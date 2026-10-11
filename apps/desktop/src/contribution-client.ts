import type { TaskContract } from "@commongrid/task-schema";
import { AccountExpired } from "./account-api";

// Narrow, read-only client for the owner's own contribution records. It reuses
// AccountExpired for 401 so callers clear private account data the same way as
// accountJSON, but keeps the HTTP status (404 vs 503) that accountJSON drops.
export class ContributionHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super("Contribution request failed"); }
}
export class ContributionFormatError extends Error {}

export type DetailKind = "leases" | "submissions" | "checkpoints";

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const codePattern = /^[a-z_]{1,64}$/;

export async function contributionJSON(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { credentials: "same-origin", signal });
  if (response.status === 401) throw new AccountExpired();
  if (!response.ok) {
    let code = "";
    try {
      const body = await response.json();
      if (body && typeof body.code === "string" && codePattern.test(body.code)) code = body.code;
    } catch { /* The status alone is enough. */ }
    throw new ContributionHttpError(response.status, code);
  }
  return response.json();
}

function bad(): never { throw new ContributionFormatError("Unexpected contribution record"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad();
  return value as Record<string, unknown>;
}
function id(value: unknown): string { if (typeof value !== "string" || !idPattern.test(value)) bad(); return value; }
function hash(value: unknown): string { if (typeof value !== "string" || !hashPattern.test(value)) bad(); return value; }
function commit(value: unknown): string { if (typeof value !== "string" || !commitPattern.test(value)) bad(); return value; }
function date(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) bad();
  return value;
}
function optionalDate(value: unknown): string | undefined { return value === undefined || value === null ? undefined : date(value); }
function count(value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) bad();
  return value;
}
// Free text is displayed verbatim as a text node, never as markup.
function freeText(value: unknown, max: number): string { if (typeof value !== "string" || value.length > max) bad(); return value; }
function label(value: unknown): string { if (typeof value !== "string" || value.length < 1 || value.length > 64) bad(); return value; }
function unwrap(value: unknown): Record<string, unknown> { return object(object(value).item); }

export type LeaseDetail = {
  id: string; attemptId: string; taskId: string; taskVersion: number; contractHash: string; strategyId: string; state: string;
  effectiveLimitSec: number; reservedMs: number; spentMs: number; overrunMs: number;
  createdAt: string; expiresAt: string; startedAt?: string; stopRequestedAt?: string; endedAt?: string;
};
export type SubmissionDetail = {
  id: string; leaseId: string; taskId: string; taskVersion: number; contractHash: string; baseCommit: string;
  artifactId: string; artifactSha256: string; artifactSize: number; status: string;
  createdAt: string; verifiedAt?: string; acceptedAt?: string;
};
export type CheckpointDetail = {
  id: string; taskId: string; taskVersion: number; contractHash: string; leaseId: string; parentId?: string;
  type: "hard" | "soft"; baseCommit: string; summary: string; continuation: string;
  artifactId: string; artifactSha256: string; artifactSize: number; status: string; reasonCode?: string;
  createdAt: string; expiresAt: string; verifiedAt?: string;
};
export type ContributionDetail =
  | { kind: "leases"; record: LeaseDetail }
  | { kind: "submissions"; record: SubmissionDetail }
  | { kind: "checkpoints"; record: CheckpointDetail };

function readArtifact(value: unknown) {
  const artifact = object(value);
  return { id: id(artifact.id), sha256: hash(artifact.sha256), size: count(artifact.size_bytes, 1) };
}
export function readLease(value: unknown, expectedID: string): LeaseDetail {
  const raw = unwrap(value);
  const record = id(raw.id);
  if (record !== expectedID) bad();
  return {
    id: record, attemptId: id(raw.attempt_id), taskId: id(raw.task_id), taskVersion: count(raw.task_version, 1), contractHash: hash(raw.contract_hash),
    strategyId: id(raw.strategy_id), state: label(raw.state), effectiveLimitSec: count(raw.effective_limit_sec), reservedMs: count(raw.reserved_ms),
    spentMs: count(raw.spent_ms), overrunMs: count(raw.overrun_ms), createdAt: date(raw.created_at), expiresAt: date(raw.expires_at),
    startedAt: optionalDate(raw.started_at), stopRequestedAt: optionalDate(raw.stop_requested_at), endedAt: optionalDate(raw.ended_at),
  };
}
export function readSubmission(value: unknown, expectedID: string): SubmissionDetail {
  const raw = unwrap(value);
  const record = id(raw.id);
  if (record !== expectedID) bad();
  const artifact = readArtifact(raw.artifact);
  return {
    id: record, leaseId: id(raw.lease_id), taskId: id(raw.task_id), taskVersion: count(raw.task_version, 1), contractHash: hash(raw.contract_hash),
    baseCommit: commit(raw.base_commit), artifactId: artifact.id, artifactSha256: artifact.sha256, artifactSize: artifact.size, status: label(raw.status),
    createdAt: date(raw.created_at), verifiedAt: optionalDate(raw.verified_at), acceptedAt: optionalDate(raw.accepted_at),
  };
}
export function readCheckpoint(value: unknown, expectedID?: string): CheckpointDetail {
  const raw = unwrap(value);
  const metadata = object(raw.metadata);
  const artifact = readArtifact(raw.artifact);
  const record = id(metadata.checkpoint_id);
  if (expectedID !== undefined && record !== expectedID) bad();
  if (metadata.type !== "hard" && metadata.type !== "soft") bad();
  // The server stores the digest in both places; a disagreement is not displayable.
  if (hash(metadata.artifact_sha256) !== artifact.sha256) bad();
  const reasonCode = raw.reason_code === undefined || raw.reason_code === null || raw.reason_code === "" ? undefined : label(raw.reason_code);
  return {
    id: record, taskId: id(metadata.task_id), taskVersion: count(metadata.task_version, 1), contractHash: hash(metadata.contract_hash), leaseId: id(metadata.lease_id),
    parentId: metadata.parent_checkpoint_id === undefined || metadata.parent_checkpoint_id === null ? undefined : id(metadata.parent_checkpoint_id),
    type: metadata.type, baseCommit: commit(metadata.base_commit), summary: freeText(metadata.summary, 4000), continuation: freeText(metadata.continuation_instructions, 24000),
    artifactId: artifact.id, artifactSha256: artifact.sha256, artifactSize: artifact.size, status: label(raw.status), reasonCode,
    createdAt: date(raw.created_at), expiresAt: date(raw.expires_at), verifiedAt: optionalDate(raw.verified_at),
  };
}

export async function fetchContributionDetail(kind: DetailKind, recordID: string, signal: AbortSignal): Promise<ContributionDetail> {
  if (!idPattern.test(recordID)) bad();
  const data = await contributionJSON(`/api/v1/${kind}/${encodeURIComponent(recordID)}`, signal);
  if (kind === "leases") return { kind, record: readLease(data, recordID) };
  if (kind === "submissions") return { kind, record: readSubmission(data, recordID) };
  return { kind, record: readCheckpoint(data, recordID) };
}

export type ResumeTarget = { task: TaskContract; strategyId: string };
export function resumeKey(target: ResumeTarget): string {
  return [target.task.id, target.task.task_version, target.task.contract_hash, target.task.workspace.commit, target.strategyId].join("|");
}
// Read-only server compatibility lookup. Every parameter comes from the
// already-validated catalog task and one of its own strategies; the server's
// answer is returned as-is and nothing about the user or result is assumed.
export async function fetchResumeCheckpoint(target: ResumeTarget, signal: AbortSignal): Promise<CheckpointDetail> {
  const { task, strategyId } = target;
  if (!idPattern.test(task.id) || !Number.isSafeInteger(task.task_version) || task.task_version < 1 || !hashPattern.test(task.contract_hash) || !commitPattern.test(task.workspace.commit) || !task.strategies.some((strategy) => strategy.id === strategyId) || !idPattern.test(strategyId)) bad();
  const query = new URLSearchParams({ task_version: String(task.task_version), contract_hash: task.contract_hash, base_commit: task.workspace.commit, strategy_id: strategyId });
  const data = await contributionJSON(`/api/v1/tasks/${encodeURIComponent(task.id)}/resume?${query}`, signal);
  const record = readCheckpoint(data);
  // A compatible answer for another task or version is not an answer to this question.
  if (record.taskId !== task.id || record.taskVersion !== task.task_version || record.contractHash !== task.contract_hash || record.baseCommit !== task.workspace.commit) bad();
  return record;
}
