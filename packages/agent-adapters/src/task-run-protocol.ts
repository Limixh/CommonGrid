// Browser-safe observation of one approved task run on the selected profile.
// Only tasks in the accepted narrow scope can be requested: the controlled
// sum.mjs task and catalog software tasks run from pinned local bundles. No
// prompt text, provider payload, host path or account identity crosses this
// boundary; the verified patch is bounded and only present after verification.

export type TaskRunProvider = "claude" | "codex";
export const taskRunTaskIds = ["controlled-sum-integers-v1", "software-bounds", "software-intervals"] as const;
export type TaskRunTaskId = typeof taskRunTaskIds[number];
export const taskRunControlledTaskId: TaskRunTaskId = "controlled-sum-integers-v1";
// The single writable file of each task; its unified diff starts with this path.
export const taskRunPatchPaths: Readonly<Record<TaskRunTaskId, string>> = Object.freeze({
  "controlled-sum-integers-v1": "sum.mjs", "software-bounds": "src/search.ts", "software-intervals": "src/intervals.ts",
});
// Catalog contracts the native runner implements. A catalog selection can start
// only when its id, version and contract hash equal this pin exactly.
export const taskRunCatalogPins: Readonly<Partial<Record<TaskRunTaskId, Readonly<{task_version: number; contract_hash: string}>>>> = Object.freeze({
  "software-bounds": Object.freeze({task_version: 1, contract_hash: "4823a3908e60b9bdeebf737c4f1d8c71a53c86981f5a4c6845877ba815f1216d"}),
  "software-intervals": Object.freeze({task_version: 1, contract_hash: "5f1f13e5b3623bbd61f9479ec4944e99c71efd2cb49a608a6b4ba4c881adb6f2"}),
});
// Approved strategy ids of each pinned contract, in contract order. A catalog
// task run names exactly one; the controlled task has none (strategy_id null).
// Only the id crosses this boundary: the worker reads the instructions from the
// hash-verified contract, never from the UI.
export const taskRunStrategyIds: Readonly<Record<TaskRunTaskId, readonly string[]>> = Object.freeze({
  "controlled-sum-integers-v1": Object.freeze([] as string[]),
  "software-bounds": Object.freeze(["invariant", "boundary-first"]),
  "software-intervals": Object.freeze(["sort-first", "sweep"]),
});
export function validTaskRunStrategy(taskId: TaskRunTaskId, strategyId: unknown): strategyId is string | null {
  const allowed = taskRunStrategyIds[taskId];
  return allowed.length === 0 ? strategyId === null : typeof strategyId === "string" && allowed.includes(strategyId);
}
export const taskRunPhases = ["starting", "preparing", "running", "verifying", "cleaning", "finished"] as const;
export type TaskRunPhase = typeof taskRunPhases[number];
export const taskRunErrors = [
  "asset_missing", "asset_invalid", "docker_unavailable", "image_missing", "profile_invalid", "profile_needs_review",
  "profile_unbound", "auth_required", "model_unavailable", "quota_exhausted", "provider_failed", "tool_limit",
  "candidate_invalid", "candidate_rejected", "verifier_failed", "worker_failed", "cleanup_failed", "deadline_exceeded", "cancelled",
] as const;
export type TaskRunError = typeof taskRunErrors[number];
export type TaskRunOutcome = "passed" | "rejected" | "cancelled" | "failed" | "needs_review";
export const taskRunMaxToolCalls = 16;
export const taskRunMaxPatchBytes = 49_152;
export const taskRunMaxStatusBytes = 65_536;
// Accepted functional-test models for the first flow. Requested aliases are
// not observed identities; a missing cheap model stops the run (no fallback).
// Kept browser-safe here; a test pins these to testing/functional-test-models.
export const taskRunRequestedModels: Readonly<Record<TaskRunProvider, string>> = Object.freeze({codex: "gpt-6-luna", claude: "haiku"});
export const taskRunObservedModels: Readonly<Record<TaskRunProvider, readonly string[]>> = Object.freeze({
  codex: Object.freeze(["gpt-6-luna"]), claude: Object.freeze(["claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-haiku-5-5"]),
});
export interface TaskRunControlledVerifier { passed: boolean; cases: number; json_cases_passed: boolean; sparse_cases_passed: boolean }
// Software tasks: the pristine visible tests and host-generated hidden cases.
export interface TaskRunSoftwareVerifier { passed: boolean; cases: number; visible_tests_passed: boolean; hidden_cases_passed: boolean }
export type TaskRunVerifier = TaskRunControlledVerifier | TaskRunSoftwareVerifier;
export const taskRunVerifierChecks: Readonly<Record<TaskRunTaskId, readonly [string, string]>> = Object.freeze({
  "controlled-sum-integers-v1": Object.freeze(["json_cases_passed", "sparse_cases_passed"] as const),
  "software-bounds": Object.freeze(["visible_tests_passed", "hidden_cases_passed"] as const),
  "software-intervals": Object.freeze(["visible_tests_passed", "hidden_cases_passed"] as const),
});
export interface TaskRunResult { verifier: TaskRunVerifier; candidate_sha256: string; patch_sha256: string | null; patch: string | null }
export interface TaskRunModel { requested: string; observed: string | null }
export interface TaskRunStartRequest { schema_version: "1.0"; request_id: string; profile_id: string; task_id: TaskRunTaskId; strategy_id: string | null; approved: true }
export interface TaskRunCancelRequest { schema_version: "1.0"; request_id: string; expected_revision: number }
export interface TaskRunOperation {
  request_id: string;
  profile_id: string;
  provider: TaskRunProvider;
  task_id: TaskRunTaskId;
  strategy_id: string | null;
  revision: number;
  phase: TaskRunPhase;
  outcome: null | TaskRunOutcome;
  error_code: null | TaskRunError;
  cleanup: "pending" | "verified" | "unknown";
  tool_calls: number;
  model: TaskRunModel;
  result: null | TaskRunResult;
}
export interface TaskRunStatus { schema_version: "1.0"; availability: "available" | "unavailable"; operation: TaskRunOperation | null }

// Native worker wire (worker stdout → native supervisor). One JSON object per
// line; the supervisor owns revisions, cancellation and the public projection.
export interface TaskRunBoot {
  type: "task_run_boot"; schema_version: "1.0"; request_id: string; profile_id: string; provider: TaskRunProvider; task_id: TaskRunTaskId; strategy_id: string | null;
  journal_root: string; assets_root: string; profile_registry_root: string;
}
export type TaskRunFrame =
  {type: "progress"; phase: "preparing" | "running" | "verifying" | "cleaning"} |
  {type: "activity"; tool_calls: number} |
  {type: "model"; observed: string} |
  {type: "result"; outcome: TaskRunOutcome; error_code: TaskRunError | null; cleanup: "verified" | "unknown"; result: TaskRunResult | null};
export const taskRunMaxFrameBytes = 65_536;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const identity = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= taskRunMaxToolCalls;
function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
function oneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.includes(value as T);
}
function invalid(): never { throw new Error("task_run_contract_invalid"); }
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
export function taskRunPatchHeader(taskId: TaskRunTaskId): string {
  const path = taskRunPatchPaths[taskId];
  return `diff --git a/${path} b/${path}\n`;
}
// A unified diff of the task's single writable file: printable UTF-8 text
// without NUL, bidi controls or carriage returns, beginning with its header.
export function validTaskRunPatch(value: unknown, taskId: TaskRunTaskId = taskRunControlledTaskId): value is string {
  return typeof value === "string" && value.length > 0 && bytes(value) <= taskRunMaxPatchBytes &&
    value.startsWith(taskRunPatchHeader(taskId)) && !/[\0\r\u202a-\u202e\u2066-\u2069]/.test(value);
}
export function validateTaskRunResult(value: unknown, outcome: TaskRunOutcome, taskId: TaskRunTaskId = taskRunControlledTaskId): TaskRunResult {
  if (!exact(value, ["verifier", "candidate_sha256", "patch_sha256", "patch"]) || typeof value.candidate_sha256 !== "string" || !sha256.test(value.candidate_sha256)) invalid();
  if (!oneOf(taskId, taskRunTaskIds)) invalid();
  const verifier = value.verifier, [first, second] = taskRunVerifierChecks[taskId];
  if (!exact(verifier, ["passed", "cases", first, second]) || typeof verifier.passed !== "boolean" ||
    typeof verifier[first] !== "boolean" || typeof verifier[second] !== "boolean" ||
    !Number.isSafeInteger(verifier.cases) || Number(verifier.cases) < 1 || Number(verifier.cases) > 1000 ||
    verifier.passed !== (verifier[first] && verifier[second])) invalid();
  if (outcome === "passed") {
    if (!verifier.passed || typeof value.patch_sha256 !== "string" || !sha256.test(value.patch_sha256) || !validTaskRunPatch(value.patch, taskId)) invalid();
  } else if (outcome === "rejected") {
    if (verifier.passed || value.patch_sha256 !== null || value.patch !== null) invalid();
  } else invalid();
  return structuredClone(value) as unknown as TaskRunResult;
}
function validModel(value: unknown, provider: TaskRunProvider): value is TaskRunModel {
  return exact(value, ["requested", "observed"]) && value.requested === taskRunRequestedModels[provider] &&
    (value.observed === null || (typeof value.observed === "string" && taskRunObservedModels[provider].includes(value.observed)));
}
export function validateTaskRunStart(value: unknown): TaskRunStartRequest {
  if (!exact(value, ["schema_version", "request_id", "profile_id", "task_id", "strategy_id", "approved"]) || value.schema_version !== "1.0" ||
    !identity(value.request_id) || !identity(value.profile_id) || !oneOf(value.task_id, taskRunTaskIds) ||
    !validTaskRunStrategy(value.task_id, value.strategy_id) || value.approved !== true) invalid();
  return structuredClone(value) as unknown as TaskRunStartRequest;
}
export function validateTaskRunCancel(value: unknown): TaskRunCancelRequest {
  if (!exact(value, ["schema_version", "request_id", "expected_revision"]) || value.schema_version !== "1.0" ||
    !identity(value.request_id) || !revision(value.expected_revision)) invalid();
  return structuredClone(value) as unknown as TaskRunCancelRequest;
}
export function validateTaskRunStatus(value: unknown): TaskRunStatus {
  if (!exact(value, ["schema_version", "availability", "operation"]) || value.schema_version !== "1.0" ||
    !oneOf(value.availability, ["available", "unavailable"])) invalid();
  const op = value.operation;
  if (value.availability === "unavailable" && op !== null) invalid();
  if (op !== null) {
    if (!exact(op, ["request_id", "profile_id", "provider", "task_id", "strategy_id", "revision", "phase", "outcome", "error_code", "cleanup", "tool_calls", "model", "result"]) ||
      !identity(op.request_id) || !identity(op.profile_id) || !oneOf(op.provider, ["claude", "codex"]) || !oneOf(op.task_id, taskRunTaskIds) ||
      !validTaskRunStrategy(op.task_id, op.strategy_id) ||
      !revision(op.revision) || !oneOf(op.phase, taskRunPhases) || !count(op.tool_calls) || !validModel(op.model, op.provider) ||
      !oneOf(op.cleanup, ["pending", "verified", "unknown"]) || (op.error_code !== null && !oneOf(op.error_code, taskRunErrors))) invalid();
    if (op.phase !== "finished") {
      if (op.outcome !== null || op.error_code !== null || op.cleanup !== "pending" || op.result !== null) invalid();
      if (op.phase === "starting" && (op.tool_calls !== 0 || op.model.observed !== null)) invalid();
    } else {
      if (!oneOf(op.outcome, ["passed", "rejected", "cancelled", "failed", "needs_review"])) invalid();
      if (op.outcome === "passed" || op.outcome === "rejected") {
        if (op.cleanup !== "verified" || op.model.observed === null || op.tool_calls < 1 ||
          op.error_code !== (op.outcome === "passed" ? null : "candidate_rejected")) invalid();
        validateTaskRunResult(op.result, op.outcome, op.task_id);
      } else {
        if (op.result !== null || op.error_code === null || op.error_code === "candidate_rejected" ||
          op.cleanup !== (op.outcome === "needs_review" ? "unknown" : "verified") ||
          (op.outcome === "cancelled") !== (op.error_code === "cancelled")) invalid();
      }
    }
  }
  if (bytes(JSON.stringify(value)) > taskRunMaxStatusBytes) invalid();
  return structuredClone(value) as unknown as TaskRunStatus;
}
export function unavailableTaskRun(): TaskRunStatus {
  return {schema_version: "1.0", availability: "unavailable", operation: null};
}
// Both operations are validated exact objects, so key order is not significant.
function canonical(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
}
function sameOperation(a: TaskRunOperation, b: TaskRunOperation): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
// Observations of one request only move forward: revision, phase, tool calls
// and the first observed model never rewind or change at an equal revision.
export function acceptTaskRunUpdate(previous: TaskRunStatus | null, incoming: unknown): TaskRunStatus {
  const next = validateTaskRunStatus(incoming), before = previous?.operation, after = next.operation;
  if (!before) return next;
  if (before.phase === "finished" && after?.request_id !== before.request_id) return next;
  if (!after || after.request_id !== before.request_id || after.profile_id !== before.profile_id || after.provider !== before.provider ||
    after.task_id !== before.task_id || after.strategy_id !== before.strategy_id || after.revision < before.revision ||
    ((after.revision === before.revision || before.phase === "finished") && !sameOperation(before, after)) ||
    taskRunPhases.indexOf(after.phase) < taskRunPhases.indexOf(before.phase) || after.tool_calls < before.tool_calls ||
    (before.model.observed !== null && after.model.observed !== before.model.observed)) throw new Error("task_run_status_stale");
  return next;
}
