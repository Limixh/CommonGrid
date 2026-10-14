import type { TaskContract } from "@commongrid/task-schema";
import { AccountExpired } from "./account-api";
import { readLease, readSubmission, type LeaseDetail, type SubmissionDetail } from "./contribution-client";

export type ExecutionCapability = Readonly<{task_version: number; contract_hash: string; base_commit: string; max_limit_sec: number; strategies: readonly string[]}>;
export type ExecutionCapabilities = ReadonlyMap<string, ExecutionCapability>;
export type TimedLeaseDetail = LeaseDetail & {serverTime?: string; receivedDeadlineMs?: number; receivedRunDeadlineMs?: number};
export class CentralExecutionError extends Error {
  constructor(readonly code: string) { super("Central execution request failed"); }
}
const id = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const hash = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function invalid(): never { throw new CentralExecutionError("response_invalid"); }

// A capability adds permission only for an already validated, exact contract.
export function readExecutionCapabilities(value: unknown, tasks: readonly TaskContract[], source: string): ExecutionCapabilities {
  const result = new Map<string, ExecutionCapability>();
  if (value === undefined) return result;
  if (!object(value) || Object.keys(value).length > tasks.length || source !== "database" && Object.keys(value).length) invalid();
  for (const [taskId, raw] of Object.entries(value)) {
    const task = tasks.find(task => task.id === taskId);
    if (!task || !object(raw) || Object.keys(raw).sort().join(",") !== "base_commit,contract_hash,max_limit_sec,strategies,task_version" ||
      raw.task_version !== task.task_version || raw.contract_hash !== task.contract_hash || raw.base_commit !== task.workspace.commit ||
      !Number.isSafeInteger(raw.max_limit_sec) || Number(raw.max_limit_sec) < 1 || Number(raw.max_limit_sec) > 1200 ||
      !Array.isArray(raw.strategies) || raw.strategies.length !== task.strategies.length ||
      raw.strategies.some((strategy, index) => strategy !== task.strategies[index].id)) invalid();
    result.set(taskId, Object.freeze({task_version: task.task_version, contract_hash: task.contract_hash,
      base_commit: task.workspace.commit, max_limit_sec: Number(raw.max_limit_sec), strategies: Object.freeze([...raw.strategies])}));
  }
  return result;
}

async function request(path: string, signal: AbortSignal, csrf?: string, body?: unknown, bytes?: Uint8Array): Promise<Record<string, unknown>> {
  const started = Date.now();
  const response = await fetch(path, {signal, credentials: "same-origin", ...(csrf === undefined ? {} : {
    method: "POST", headers: {"X-CSRF-Token": csrf, "Content-Type": bytes ? "application/vnd.commongrid.artifact+zip" : "application/json"},
    body: bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : JSON.stringify(body ?? {}),
  })});
  if (response.status === 401) throw new AccountExpired();
  const text = await response.text();
  if (text.length > 65536) invalid();
  let value: unknown;
  try { value = JSON.parse(text); } catch { invalid(); }
  if (!response.ok) throw new CentralExecutionError(object(value) && typeof value.code === "string" && /^[a-z_]{1,64}$/.test(value.code) ? value.code : "request_failed");
  if (!object(value) || value.source !== "database") invalid();
  return {...value, request_started_at_ms: started};
}
function timedLease(value: Record<string, unknown>, leaseId: string, required: boolean, capToRunLimit = true): TimedLeaseDetail {
  const lease = readLease(value, leaseId);
  if (!required) return lease;
  if (value.execution_enabled !== true || typeof value.server_time !== "string" || value.server_time.length > 64 ||
    !Number.isFinite(Date.parse(value.server_time))) invalid();
  // Starting the relative clock before the request subtracts transport time.
  // No heartbeat can extend the native run's captured deadline.
  const remaining = Math.max(0, Date.parse(lease.expiresAt) - Date.parse(value.server_time));
  return {...lease, serverTime: value.server_time, receivedDeadlineMs: Number(value.request_started_at_ms) + remaining,
    ...(capToRunLimit ? {receivedRunDeadlineMs: Number(value.request_started_at_ms) + Math.min(lease.effectiveLimitSec * 1000, remaining)} : {})};
}
function responseID(value: Record<string, unknown>): string {
  if (!object(value.item) || typeof value.item.id !== "string" || !id.test(value.item.id)) invalid();
  return value.item.id;
}
export async function reserveCentralTask(taskId: string, body: {task_version: number; contract_hash: string; strategy_id: string; request_key: string; limit_sec: number}, csrf: string, signal: AbortSignal) {
  const value = await request(`/api/v1/tasks/${encodeURIComponent(taskId)}/leases`, signal, csrf, body);
  return timedLease(value, responseID(value), true, false);
}
export async function centralLeaseAction(leaseId: string, action: "start" | "heartbeat" | "stop" | "end", csrf: string, signal: AbortSignal): Promise<TimedLeaseDetail> {
  const value = await request(`/api/v1/leases/${encodeURIComponent(leaseId)}/${action}`, signal, csrf, action === "end" ? {reason: "stopped"} : {});
  return timedLease(value, leaseId, action === "start" || action === "heartbeat");
}
export async function readCentralLease(leaseId: string, signal: AbortSignal) {
  return readLease(await request(`/api/v1/leases/${encodeURIComponent(leaseId)}`, signal), leaseId);
}
export type ArtifactReceipt = {id: string; sha256: string; size_bytes: number};
export async function uploadCentralResult(leaseId: string, requestKey: string, bytes: Uint8Array, expectedHash: string, csrf: string, signal: AbortSignal): Promise<ArtifactReceipt> {
  const value = await request(`/api/v1/leases/${encodeURIComponent(leaseId)}/artifacts?purpose=result&request_key=${encodeURIComponent(requestKey)}`, signal, csrf, undefined, bytes);
  if (!object(value.item)) invalid();
  const artifact = value.item;
  if (typeof artifact.id !== "string" || !id.test(artifact.id) || typeof artifact.sha256 !== "string" || !hash.test(artifact.sha256) ||
    artifact.sha256 !== expectedHash || artifact.size_bytes !== bytes.length) invalid();
  return {id: artifact.id, sha256: artifact.sha256, size_bytes: bytes.length};
}
export async function submitCentralResult(leaseId: string, body: {task_version: number; contract_hash: string; base_commit: string; request_key: string; artifact: ArtifactReceipt}, csrf: string, signal: AbortSignal): Promise<SubmissionDetail> {
  const value = await request(`/api/v1/leases/${encodeURIComponent(leaseId)}/result`, signal, csrf, body);
  const receipt = readSubmission(value, responseID(value));
  if (receipt.leaseId !== leaseId || receipt.taskVersion !== body.task_version || receipt.contractHash !== body.contract_hash ||
    receipt.baseCommit !== body.base_commit || receipt.artifactId !== body.artifact.id || receipt.artifactSha256 !== body.artifact.sha256 || receipt.artifactSize !== body.artifact.size_bytes) invalid();
  return receipt;
}
