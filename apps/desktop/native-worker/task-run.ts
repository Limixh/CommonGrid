import { createHash } from "node:crypto";
import path from "node:path";
import { ControlledTaskCleanupError, controlledTaskId, createControlledPatch, seedControlledTask, snapshotControlledCandidate, verifyControlledCandidate, type ControlledVerifierResult } from "../../../packages/agent-adapters/src/controlled-task.ts";
import { TaskToolLimitError, runControlledProviderTurn, type ProviderTurnOptions } from "../../../packages/agent-adapters/src/controlled-task-session.ts";
import { ManagedCliRuntime, startBridge, type ManagedRuntimeAssets } from "../../../packages/agent-adapters/src/managed-runtime.ts";
import { assertBridgeHealthy, ProviderFailure } from "../../../packages/agent-adapters/src/session-protocol.ts";
import { executeTaskTool } from "../../../packages/agent-adapters/src/task-tool.ts";
import { TaskToolsRuntime } from "../../../packages/agent-adapters/src/task-runtime.ts";
import { taskRunMaxFrameBytes, taskRunMaxToolCalls, taskRunObservedModels, taskRunRequestedModels, validateTaskRunResult, validateTaskRunStatus,
  type TaskRunBoot, type TaskRunError, type TaskRunFrame, type TaskRunOutcome, type TaskRunResult } from "../../../packages/agent-adapters/src/task-run-protocol.ts";
import { verifyAssets, verifyDockerPrerequisite } from "./cli-check.ts";
import { BindingFailure, ProfileBindings, uuid, type ProfileBinding } from "./profile-bindings.ts";

export type { TaskRunBoot, TaskRunFrame };
class TaskRunFailure extends Error { constructor(readonly code: TaskRunError) { super(code); } }
const bootKeys = ["type", "schema_version", "request_id", "profile_id", "provider", "task_id", "journal_root", "assets_root", "profile_registry_root"].sort().join();
export function parseTaskRunBoot(value: unknown): TaskRunBoot {
  const boot = value as TaskRunBoot;
  if (!boot || typeof boot !== "object" || Array.isArray(boot) || Object.keys(boot).sort().join() !== bootKeys ||
    boot.type !== "task_run_boot" || boot.schema_version !== "1.0" || typeof boot.request_id !== "string" || !uuid.test(boot.request_id) ||
    typeof boot.profile_id !== "string" || !uuid.test(boot.profile_id) || !["codex", "claude"].includes(boot.provider) || boot.task_id !== controlledTaskId ||
    ![boot.journal_root, boot.assets_root, boot.profile_registry_root].every(root => typeof root === "string" && root.length < 4096 && !/[\x00\r\n]/.test(root) && path.isAbsolute(root)) ||
    path.basename(boot.profile_registry_root) !== "managed-profiles") throw new TaskRunFailure("worker_failed");
  return boot;
}
export function taskRunBindingRoot(boot: Pick<TaskRunBoot, "profile_registry_root">): string {
  return path.join(path.dirname(boot.profile_registry_root), "managed-profile-sessions");
}
export type TaskRunRuntime = Pick<ManagedCliRuntime, "beginOperation" | "start" | "stop" | "finishOperation" | "retainOperation" | "verifyOperation" | "beginNamespaceExec" | "exec" | "installCodexCodingCatalog">;
export type TaskRunSandbox = Pick<TaskToolsRuntime, "exec" | "close" | "inspect" | "container" | "volume">;
export interface TaskRunBridge { stats: ProviderTurnOptions["bridgeStats"]; close(): void }
export interface TaskRunDependencies {
  bindings(root: string): Pick<ProfileBindings, "read">;
  assets(boot: TaskRunBoot): Promise<ManagedRuntimeAssets>;
  prerequisite(assets: ManagedRuntimeAssets, signal: AbortSignal): Promise<void>;
  /** Restores the already bound runtime; a task never prepares or creates one. */
  restore(binding: ProfileBinding, assets: ManagedRuntimeAssets): TaskRunRuntime;
  sandbox(image: string): Promise<TaskRunSandbox>;
  bridge(runtime: TaskRunRuntime, sandbox: TaskRunSandbox): Promise<TaskRunBridge>;
  provider(options: ProviderTurnOptions): Promise<void>;
  snapshot(sandbox: TaskRunSandbox, image: string): Promise<string>;
  verify(source: string, image: string, signal: AbortSignal): Promise<ControlledVerifierResult>;
}
const dependencies: TaskRunDependencies = {
  bindings: root => new ProfileBindings(root),
  assets: boot => verifyAssets({type: "boot", schema_version: boot.schema_version, request_id: boot.request_id, provider: boot.provider, assets_root: boot.assets_root, journal_root: boot.journal_root}),
  prerequisite: verifyDockerPrerequisite,
  restore: (binding, assets) => ManagedCliRuntime.restore({owner: binding.owner, provider: binding.provider}, {assets}),
  sandbox: image => TaskToolsRuntime.create({image, cpu: 1, memoryMb: 256}, 600_000),
  bridge: (runtime, sandbox) => startBridge(runtime as ManagedCliRuntime, sandbox as TaskToolsRuntime),
  provider: runControlledProviderTurn,
  snapshot: (sandbox, image) => snapshotControlledCandidate(sandbox, image),
  verify: (source, image, signal) => verifyControlledCandidate(source, image, undefined, signal),
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const abortCode = (signal: AbortSignal): TaskRunError => signal.reason === "deadline_exceeded" ? "deadline_exceeded" : signal.reason === "worker_failed" ? "worker_failed" : "cancelled";
function errorCode(error: unknown, signal: AbortSignal): TaskRunError {
  if (signal.aborted) return abortCode(signal);
  if (error instanceof BindingFailure || error instanceof TaskRunFailure) return error.code;
  if (error instanceof TaskToolLimitError) return "tool_limit";
  if (error instanceof ProviderFailure) {
    switch (error.category) {
      case "model": return "model_unavailable";
      case "quota": return "quota_exhausted";
      case "auth_required": case "session_expired": return "auth_required";
      case "deadline": return "deadline_exceeded";
      case "canceled": return "cancelled";
      default: return "provider_failed";
    }
  }
  // Closed setup codes only; Docker/provider text never enters a frame.
  const code = (error as {code?: unknown})?.code;
  if (["asset_missing", "asset_invalid", "docker_unavailable", "image_missing"].includes(code as string)) return code as TaskRunError;
  // An unexplained incumbent claim on the profile needs review, not a retry.
  if ((error as Error)?.message === "managed_profile_busy") return "profile_needs_review";
  return "worker_failed";
}
// Preserve cleanup uncertainty before mapping aborts, candidate policy failures
// or the step's own tooling code.
const stepFailure = (signal: AbortSignal, code: TaskRunError) => (error: unknown): never => {
  if (error instanceof ControlledTaskCleanupError) throw error;
  if (signal.aborted) throw error;
  throw new TaskRunFailure(error instanceof Error && /^candidate_/.test(error.message) ? "candidate_invalid" : code);
};
function terminalFrame(boot: TaskRunBoot, outcome: TaskRunOutcome, error: TaskRunError | null, unverified: boolean, result: TaskRunResult | null, toolCalls: number, observed: string | null): Extract<TaskRunFrame, {type: "result"}> {
  const frame = {type: "result", outcome, error_code: error, cleanup: unverified ? "unknown" : "verified", result} as const;
  // The supervisor projects this frame into the public status; refuse anything
  // that projection would reject, and keep the line bounded.
  validateTaskRunStatus({schema_version: "1.0", availability: "available", operation: {request_id: boot.request_id, profile_id: boot.profile_id, provider: boot.provider, task_id: boot.task_id,
    revision: 1, phase: "finished", outcome, error_code: error, cleanup: frame.cleanup, tool_calls: toolCalls, model: {requested: taskRunRequestedModels[boot.provider], observed}, result}});
  if (Buffer.byteLength(JSON.stringify(frame)) > taskRunMaxFrameBytes) throw new Error("task_run_frame_too_large");
  return frame;
}
export async function runTaskRun(boot: TaskRunBoot, signal: AbortSignal, emit: (frame: TaskRunFrame) => void, deps: TaskRunDependencies = dependencies): Promise<void> {
  let runtime: TaskRunRuntime | undefined, bridge: TaskRunBridge | undefined, sandbox: TaskRunSandbox | undefined, release: (() => void) | undefined;
  let error: TaskRunError | null = null, result: TaskRunResult | null = null;
  // Scalars observed from the provider; mutated by the observer callbacks only.
  const seen = {observed: null as string | null, toolCalls: 0};
  let accepting = false, cleanupFailed = false, holdOwnership = false, settled = false;
  const trace = {quiescent: true};
  emit({type: "progress", phase: "preparing"});
  try {
    signal.throwIfAborted();
    const binding = await deps.bindings(taskRunBindingRoot(boot)).read(boot.profile_id, boot.provider);
    signal.throwIfAborted();
    if (!binding) throw new TaskRunFailure("profile_unbound");
    if (binding.state === "reserved") throw new TaskRunFailure("profile_needs_review");
    const assets = await deps.assets(boot);
    signal.throwIfAborted();
    // Codex needs the pinned catalog; a build without its public source reports it missing.
    if (boot.provider === "codex" && !assets.codexCatalog) throw new TaskRunFailure("asset_missing");
    await deps.prerequisite(assets, signal); signal.throwIfAborted();
    runtime = deps.restore(binding, assets);
    await runtime.beginOperation({signal});
    if (boot.provider === "codex") await runtime.installCodexCodingCatalog({signal});
    await runtime.start({signal}); signal.throwIfAborted();
    if (boot.provider === "codex") {
      const digest = await runtime.exec(["node", "-e", "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/opt/cg/catalog.json')).digest('hex'));"], 15_000, {signal, maxBytes: 4096});
      if (digest.code !== 0 || digest.stdout.trim() !== assets.codexCatalog!.sha256) throw new TaskRunFailure("asset_invalid");
    }
    release = await runtime.retainOperation({signal});
    try { sandbox = await deps.sandbox(assets.baseImage); }
    catch (failure) { if (failure instanceof AggregateError && failure.message === "sandbox_cleanup_failed") cleanupFailed = holdOwnership = true; throw failure; }
    signal.throwIfAborted();
    await seedControlledTask(sandbox); signal.throwIfAborted();
    bridge = await deps.bridge(runtime, sandbox); assertBridgeHealthy(bridge.stats); signal.throwIfAborted();
    emit({type: "progress", phase: "running"});
    const task = sandbox;
    // The supervisor accepts model/activity only while running: a late callback is dropped.
    accepting = true;
    try { await deps.provider({provider: boot.provider, runtime, execute: arguments_ => executeTaskTool(task as TaskToolsRuntime, arguments_), bridgeStats: bridge.stats, signal, trace,
      observer: {
        model: model => { if (accepting && seen.observed === null && (taskRunObservedModels[boot.provider] as readonly string[]).includes(model)) { seen.observed = model; emit({type: "model", observed: model}); } },
        toolCall: count => { if (!accepting) return; if (count > taskRunMaxToolCalls) throw new TaskToolLimitError(); if (count > seen.toolCalls) { seen.toolCalls = count; emit({type: "activity", tool_calls: count}); } },
      }}); } finally { accepting = false; }
    signal.throwIfAborted(); assertBridgeHealthy(bridge.stats);
    if (seen.observed === null || seen.toolCalls < 1) throw new ProviderFailure("protocol");
    emit({type: "progress", phase: "verifying"});
    // The provider process and relay are gone before the workspace is frozen.
    bridge.close();
    const source = await deps.snapshot(sandbox, assets.baseImage).catch(stepFailure(signal, "worker_failed")); signal.throwIfAborted();
    const verdict = await deps.verify(source, assets.baseImage, signal).catch(stepFailure(signal, "verifier_failed")); signal.throwIfAborted();
    if (verdict.candidate_sha256 !== sha256(source)) throw new TaskRunFailure("verifier_failed");
    const verifier = {passed: verdict.passed, cases: verdict.cases, json_cases_passed: verdict.json_cases_passed, sparse_cases_passed: verdict.sparse_cases_passed};
    if (!verdict.passed) { result = validateTaskRunResult({verifier, candidate_sha256: verdict.candidate_sha256, patch_sha256: null, patch: null}, "rejected"); error = "candidate_rejected"; }
    else {
      let evidence: ReturnType<typeof createControlledPatch>;
      try { evidence = createControlledPatch(source); } catch { throw new TaskRunFailure("candidate_invalid"); }
      result = validateTaskRunResult({verifier, candidate_sha256: verdict.candidate_sha256, patch_sha256: evidence.patch_sha256, patch: evidence.patch}, "passed");
    }
  } catch (failure) {
    // Snapshot/verifier containers have separate owners and cannot be proven gone
    // by closing the task sandbox or the managed runtime. Preserve the claim.
    if (failure instanceof ControlledTaskCleanupError) cleanupFailed = holdOwnership = true;
    result = null; error = errorCode(failure, signal);
  } finally {
    emit({type: "progress", phase: "cleaning"});
    const cleanupSignal = AbortSignal.timeout(35_000);
    try { if (bridge) assertBridgeHealthy(bridge.stats); } catch { error ??= "provider_failed"; result = null; }
    try { bridge?.close(); } catch { error ??= "provider_failed"; result = null; }
    // Ownership is only released after the sandbox is gone and no tool callback is still running.
    if (sandbox) { try { await sandbox.close(); } catch { cleanupFailed = holdOwnership = true; } }
    if (!trace.quiescent) cleanupFailed = holdOwnership = true;
    if (runtime) {
      // Hold the operation lease while task callbacks and the relay stop.
      try { await runtime.stop(false, {signal: cleanupSignal}); } catch { cleanupFailed = true; } finally { release?.(); }
      if (!holdOwnership) { try { await runtime.finishOperation({signal: cleanupSignal}); settled = !cleanupFailed; } catch { cleanupFailed = true; } }
    }
    if (signal.aborted && (error === null || error === "candidate_rejected")) { error = abortCode(signal); result = null; }
    if (cleanupFailed) error = "cleanup_failed";
    // An unexplained claim or interrupted reservation is never verified cleanup.
    const unverified = cleanupFailed || error === "profile_needs_review" || (runtime !== undefined && !settled);
    if (unverified && (error === null || error === "cancelled" || error === "candidate_rejected")) error = "cleanup_failed";
    if (error !== null && error !== "candidate_rejected") result = null;
    const outcome: TaskRunOutcome = unverified ? "needs_review" : error === null ? "passed" : error === "candidate_rejected" ? "rejected" : error === "cancelled" ? "cancelled" : "failed";
    let frame: Extract<TaskRunFrame, {type: "result"}>;
    try { frame = terminalFrame(boot, outcome, error, unverified, result, seen.toolCalls, seen.observed); }
    catch { frame = terminalFrame(boot, unverified ? "needs_review" : "failed", unverified && error === "cleanup_failed" ? "cleanup_failed" : "worker_failed", unverified, null, seen.toolCalls, seen.observed); }
    emit(frame);
  }
}
