import type { OperationJournalSnapshot, OperationJournalReadResult } from "./operation-journal-types.ts";

// Browser-safe observations only. These records confer no runtime authority.
export const recoveryOperationLimit = 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const actions = ["lease_acquire", "lease_release", "namespace_create", "namespace_start", "namespace_remove", "namespace_exec", "volume_create", "volume_remove", "public_install", "public_manifest_publish", "public_checkpoint_publish"];
const reasons = ["operation_journal_missing", "operation_journal_invalid", "operation_journal_overflow", "operation_journal_io_failed"];
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function validIdentity(value: unknown): value is OperationJournalSnapshot["identity"] {
  return record(value) && keys(value, ["owner", "provider", "operation"]) && typeof value.owner === "string" && uuid.test(value.owner) && typeof value.operation === "string" && uuid.test(value.operation) && typeof value.provider === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value.provider);
}
function validSnapshot(value: unknown): value is OperationJournalSnapshot {
  if (!record(value) || !keys(value, ["identity", "namespace_ids", "pending", "captures", "last_sequence", "last_hash", "terminal", "durability"], ["lease_id"]) || !validIdentity(value.identity)) return false;
  if (Object.hasOwn(value, "lease_id") && (typeof value.lease_id !== "string" || !hash.test(value.lease_id))) return false;
  if (!Array.isArray(value.namespace_ids) || value.namespace_ids.length > 512 || !value.namespace_ids.every(id => typeof id === "string" && hash.test(id)) || new Set(value.namespace_ids).size !== value.namespace_ids.length) return false;
  if (!Array.isArray(value.pending) || value.pending.length > 512 || !value.pending.every(intent => record(intent) && keys(intent, ["intent_id", "action"], ["role", "resource_id"]) && typeof intent.intent_id === "string" && uuid.test(intent.intent_id) && typeof intent.action === "string" && actions.includes(intent.action) && (!Object.hasOwn(intent, "role") || typeof intent.role === "string" && ["runtime", "init", "tools", "auth"].includes(intent.role)) && (!Object.hasOwn(intent, "resource_id") || typeof intent.resource_id === "string" && hash.test(intent.resource_id)))) return false;
  if (new Set(value.pending.map(intent => intent.intent_id)).size !== value.pending.length) return false;
  if (!Array.isArray(value.captures) || value.captures.length > 512 || !value.captures.every(capture => record(capture) && keys(capture, ["intent_id", "resource_id"]) && typeof capture.intent_id === "string" && uuid.test(capture.intent_id) && typeof capture.resource_id === "string" && hash.test(capture.resource_id))) return false;
  if (new Set(value.captures.map(capture => capture.intent_id)).size !== value.captures.length) return false;
  return Number.isSafeInteger(value.last_sequence) && Number(value.last_sequence) >= 1 && Number(value.last_sequence) <= 512 && typeof value.last_hash === "string" && hash.test(value.last_hash) && typeof value.terminal === "boolean" && (!value.terminal || value.pending.length === 0) && typeof value.durability === "string" && ["process_crash", "file_and_directory_synced"].includes(value.durability);
}
export interface RecoveryOperation {
  identity: OperationJournalSnapshot["identity"];
  last_sequence: number;
  last_hash: string;
  status: "recorded_complete" | "needs_review";
  pending_count: number;
  recorded_namespace_count: number;
  durability: OperationJournalSnapshot["durability"];
}
export interface RecoveryStatus {
  status: "available" | "unavailable" | "blocked";
  reason?: string;
  execution_enabled: false;
  automatic_recovery: false;
  worker_quiescence: "unknown";
  daemon_state: "unknown";
  operations: RecoveryOperation[];
}
function result(status: RecoveryStatus["status"], operations: RecoveryOperation[] = [], reason?: string): RecoveryStatus {
  return {status, ...(reason ? {reason} : {}), execution_enabled: false, automatic_recovery: false, worker_quiescence: "unknown", daemon_state: "unknown", operations};
}
/** Unknown/corrupt input fails closed; never forward journal extensions or error text. */
export function projectOperationRecovery(value: OperationJournalReadResult | unknown): RecoveryStatus {
  if (!record(value) || !keys(value, ["status", "operations"], ["reason"]) || !Array.isArray(value.operations)) return result("blocked", [], "operation_journal_invalid");
  if (typeof value.status === "string" && ["unavailable", "blocked"].includes(value.status)) {
    if (value.operations.length !== 0 || typeof value.reason !== "string" || !reasons.includes(value.reason)) return result("blocked", [], "operation_journal_invalid");
    return result(value.status as "unavailable" | "blocked", [], value.reason);
  }
  if (value.status !== "available" || Object.hasOwn(value, "reason")) return result("blocked", [], "operation_journal_invalid");
  if (value.operations.length > recoveryOperationLimit) return result("blocked", [], "operation_journal_overflow");
  if (!value.operations.every(validSnapshot)) return result("blocked", [], "operation_journal_invalid");
  const identities = value.operations.map(operation => `${operation.identity.owner}/${operation.identity.provider}/${operation.identity.operation}`);
  if (new Set(identities).size !== identities.length) return result("blocked", [], "operation_journal_invalid");
  return result("available", value.operations.map(operation => ({identity: {...operation.identity}, last_sequence: operation.last_sequence, last_hash: operation.last_hash, status: operation.terminal ? "recorded_complete" : "needs_review", pending_count: operation.pending.length, recorded_namespace_count: operation.namespace_ids.length, durability: operation.durability})));
}
/** Validate the projected network contract before showing any observations. */
export function validateRecoveryStatus(value: unknown): RecoveryStatus {
  if (!record(value) || !keys(value, ["status", "execution_enabled", "automatic_recovery", "worker_quiescence", "daemon_state", "operations"], ["reason"]) || value.execution_enabled !== false || value.automatic_recovery !== false || value.worker_quiescence !== "unknown" || value.daemon_state !== "unknown" || !Array.isArray(value.operations)) throw new Error("operation_recovery_response_invalid");
  if (typeof value.status === "string" && ["blocked", "unavailable"].includes(value.status)) {
    if (value.operations.length || typeof value.reason !== "string" || ![...reasons, "native_recovery_unavailable"].includes(value.reason)) throw new Error("operation_recovery_response_invalid");
  } else if (value.status !== "available" || Object.hasOwn(value, "reason") || value.operations.length > recoveryOperationLimit || !value.operations.every(row => record(row) && keys(row, ["identity", "last_sequence", "last_hash", "status", "pending_count", "recorded_namespace_count", "durability"]) && validIdentity(row.identity) && Number.isSafeInteger(row.last_sequence) && Number(row.last_sequence) >= 1 && Number(row.last_sequence) <= 512 && typeof row.last_hash === "string" && hash.test(row.last_hash) && typeof row.status === "string" && ["recorded_complete", "needs_review"].includes(row.status) && Number.isSafeInteger(row.pending_count) && Number(row.pending_count) >= 0 && Number(row.pending_count) <= 512 && Number.isSafeInteger(row.recorded_namespace_count) && Number(row.recorded_namespace_count) >= 0 && Number(row.recorded_namespace_count) <= 512 && (row.status !== "recorded_complete" || row.pending_count === 0) && typeof row.durability === "string" && ["process_crash", "file_and_directory_synced"].includes(row.durability))) throw new Error("operation_recovery_response_invalid");
  const identities = value.operations.map(row => `${row.identity.owner}/${row.identity.provider}/${row.identity.operation}`);
  if (new Set(identities).size !== identities.length) throw new Error("operation_recovery_response_invalid");
  return structuredClone(value) as unknown as RecoveryStatus;
}
/** An inspect-only review request: no lease adoption, cleanup or execution permission. */
export function createOperationReviewRequest(status: RecoveryStatus, identity: RecoveryOperation["identity"]) {
  const checked = validateRecoveryStatus(status);
  if (checked.status !== "available") throw new Error("operation_review_unavailable");
  const row = checked.operations.find(operation => operation.identity.operation === identity.operation && operation.identity.owner === identity.owner && operation.identity.provider === identity.provider);
  if (!row || row.status !== "needs_review") throw new Error("operation_review_unavailable");
  return {schema_version: 1, action: "inspect_only", identity: {...row.identity}, expected_sequence: row.last_sequence, expected_hash: row.last_hash, execution_enabled: false, automatic_recovery: false, worker_quiescence: "unknown", daemon_state: "unknown"} as const;
}



