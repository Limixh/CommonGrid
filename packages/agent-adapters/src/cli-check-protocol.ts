// Browser-safe contract for a CLI version check. It grants no model/task authority.
export type CliCheckProvider = "claude" | "codex";
export const cliCheckErrors = ["asset_missing", "asset_invalid", "docker_unavailable", "image_missing", "cli_check_failed", "worker_failed", "cleanup_failed", "deadline_exceeded", "cancelled"] as const;
export type CliCheckError = typeof cliCheckErrors[number];
export interface CliCheckStartRequest { schema_version: "1.0"; request_id: string; provider: CliCheckProvider }
export interface CliCheckCancelRequest { schema_version: "1.0"; request_id: string; expected_revision: number }
export interface CliCheckOperation {
  request_id: string;
  provider: CliCheckProvider;
  revision: number;
  phase: "starting" | "preparing" | "checking" | "cleaning" | "finished";
  outcome: null | "passed" | "cancelled" | "failed" | "needs_review";
  cli_version: null | string;
  error_code: null | CliCheckError;
  cleanup: "pending" | "verified" | "unknown";
}
export interface CliCheckStatus { schema_version: "1.0"; availability: "available" | "unavailable"; operation: CliCheckOperation | null }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, fields: string[]) { return fields.length === Object.keys(value).length && fields.every(field => Object.hasOwn(value, field)); }
function identity(value: unknown) { return typeof value === "string" && uuid.test(value); }
function provider(value: unknown) { return value === "claude" || value === "codex"; }
function invalid(): never { throw new Error("cli_check_contract_invalid"); }
export function validateCliCheckStart(value: unknown): CliCheckStartRequest {
  if (!object(value) || !exact(value, ["schema_version", "request_id", "provider"]) || value.schema_version !== "1.0" || !identity(value.request_id) || !provider(value.provider)) invalid();
  return structuredClone(value) as unknown as CliCheckStartRequest;
}
export function validateCliCheckCancel(value: unknown): CliCheckCancelRequest {
  if (!object(value) || !exact(value, ["schema_version", "request_id", "expected_revision"]) || value.schema_version !== "1.0" || !identity(value.request_id) || !revision(value.expected_revision)) invalid();
  return structuredClone(value) as unknown as CliCheckCancelRequest;
}
export function validateCliCheckStatus(value: unknown): CliCheckStatus {
  if (!object(value) || !exact(value, ["schema_version", "availability", "operation"]) || value.schema_version !== "1.0" || !["available", "unavailable"].includes(String(value.availability))) invalid();
  const operation = value.operation;
  if (value.availability === "unavailable" && operation !== null) invalid();
  if (operation !== null) {
    if (!object(operation) || !exact(operation, ["request_id", "provider", "revision", "phase", "outcome", "cli_version", "error_code", "cleanup"]) || !identity(operation.request_id) || !provider(operation.provider) || !revision(operation.revision) || !["starting", "preparing", "checking", "cleaning", "finished"].includes(String(operation.phase))) invalid();
    if (operation.cli_version !== null && (typeof operation.cli_version !== "string" || !/^[\x20-\x7e]{1,120}$/.test(operation.cli_version))) invalid();
    if (operation.error_code !== null && !cliCheckErrors.includes(operation.error_code as CliCheckError)) invalid();
    if (operation.phase !== "finished") {
      if (operation.outcome !== null || operation.cli_version !== null || operation.error_code !== null || operation.cleanup !== "pending") invalid();
    } else {
      if (!["passed", "cancelled", "failed", "needs_review"].includes(String(operation.outcome))) invalid();
      if (operation.outcome === "passed") {
        if (operation.cli_version === null || operation.error_code !== null || operation.cleanup !== "verified") invalid();
      } else {
        if (operation.cli_version !== null || operation.error_code === null || operation.cleanup !== (operation.outcome === "needs_review" ? "unknown" : "verified")) invalid();
        if (operation.outcome === "cancelled" && operation.error_code !== "cancelled") invalid();
      }
    }
  }
  return structuredClone(value) as unknown as CliCheckStatus;
}
export function unavailableCliCheck(): CliCheckStatus { return {schema_version: "1.0", availability: "unavailable", operation: null}; }

/** A live observation must not regress or silently replace the admitted operation. */
export function acceptCliCheckUpdate(previous: CliCheckStatus | null, incoming: unknown): CliCheckStatus {
  const next = validateCliCheckStatus(incoming);
  if (!previous?.operation) return next;
  const before = previous.operation, after = next.operation;
  if (before.phase === "finished" && after?.request_id !== before.request_id) return next;
  if (!after || after.request_id !== before.request_id || after.provider !== before.provider || after.revision < before.revision) throw new Error("cli_check_status_stale");
  if ((after.revision === before.revision || before.phase === "finished") && Object.keys(before).some(key => after[key as keyof CliCheckOperation] !== before[key as keyof CliCheckOperation])) throw new Error("cli_check_status_stale");
  const phases = ["starting", "preparing", "checking", "cleaning", "finished"];
  if (phases.indexOf(after.phase) < phases.indexOf(before.phase)) throw new Error("cli_check_status_stale");
  return next;
}
