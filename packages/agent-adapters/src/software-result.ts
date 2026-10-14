// Result package of a verified catalog software task run: the verified unified
// patch is re-applied to the pinned baseline, the candidate hash is checked and
// the single writable file is packed into a deterministic `cg-artifact/1`
// bundle (artifact-bundle.ts). This builder only returns in-memory bytes;
// the caller owns lease binding, private retention and explicit submission.
//
// Scanner: only the local text inspection that buildArtifactBundle itself runs
// (UTF-8, control/bidi characters, secret patterns, forbidden patterns). That is
// a local baseline check and never a scan verdict; the server's Trivy scan stays
// mandatory and this module never claims a scanner pass.
import { createHash } from "node:crypto";
import type { TaskContract } from "@commongrid/task-schema";
import { buildArtifactBundle, type ArtifactBinding } from "./artifact-bundle.ts";
import { applyControlledPatch } from "./controlled-task.ts";
import { taskRunPatchPaths, taskRunTaskIds, taskRunControlledTaskId, type TaskRunTaskId } from "./task-run-protocol.ts";

export interface SoftwareResultInput {
  /** The pinned, pristine contents of the single writable file. */
  baseline: string;
  /** Approved strategy id of the run; must be one of the contract's strategies. */
  strategyId: string;
  /** Lease the bundle is bound to (the server validates it against an active lease). */
  leaseId: string;
  /** The verified unified diff of the writable file. */
  patch: string;
  /** sha256 of the verified candidate; the re-applied patch must produce exactly this. */
  candidateSha256: string;
}
export interface SoftwareResultBundle {
  bytes: Buffer; sha256: string; size_bytes: number;
  file: { path: string; sha256: string; size_bytes: number };
}

/** Fixed, obviously local lease id for the deliverability check; never uploaded. */
export const softwareDeliverabilityLeaseId = "lease-local-deliverability-check";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function fail(code: string): never { throw new Error(code); }

// buildArtifactBundle codes that mean "these candidate bytes cannot be delivered";
// everything else (task, binding, path, scanner, archive) is not the candidate's fault.
const candidateFaults: ReadonlySet<string> = new Set([
  "artifact_file_limit", "artifact_invalid_utf8", "artifact_unsafe_content", "artifact_secret_content", "artifact_forbidden_content",
]);

/**
 * Builds the deterministic result bundle for a verified software candidate.
 * Errors: `candidate_*` when the candidate (patch, hash, delivery text policy)
 * is at fault; `result_*` for a task/strategy this package cannot represent;
 * other `artifact_*` codes pass through from the bundle builder.
 */
export async function buildSoftwareResultBundle(task: TaskContract, input: SoftwareResultInput): Promise<SoftwareResultBundle> {
  const taskId = task?.id as TaskRunTaskId;
  if (!taskRunTaskIds.includes(taskId) || taskId === taskRunControlledTaskId) fail("result_task_unsupported");
  const path = taskRunPatchPaths[taskId];
  if (!task.workspace.writable_paths.includes(path)) fail("result_path_denied");
  if (!task.strategies.some((strategy) => strategy.id === input?.strategyId)) fail("result_strategy_invalid");
  if (typeof input.baseline !== "string" || typeof input.patch !== "string" || typeof input.candidateSha256 !== "string") fail("result_input_invalid");
  const candidate = applyControlledPatch(input.baseline, input.patch, taskId);
  if (sha256(candidate) !== input.candidateSha256) fail("candidate_hash_mismatch");
  const bytes = Buffer.from(candidate, "utf8");
  const binding: ArtifactBinding = {
    purpose: "result", task_id: task.id, task_version: task.task_version, contract_hash: task.contract_hash,
    lease_id: input.leaseId, base_commit: task.workspace.commit, strategy_id: input.strategyId,
  };
  try {
    const bundle = await buildArtifactBundle(task, binding, [{ path, bytes }], async () => {});
    return { ...bundle, file: { path, sha256: sha256(bytes), size_bytes: bytes.length } };
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    throw new Error(candidateFaults.has(code) ? "candidate_not_deliverable" : code.startsWith("artifact_") ? code : "result_build_failed");
  }
}

/**
 * Worker gate: proves a verified candidate can be delivered under the artifact
 * policy (which is stricter than the worker's candidate policy: it also rejects
 * C1 controls, U+061C, U+200E and U+200F) without producing anything to keep.
 * Throws `candidate_not_deliverable` (map to candidate_invalid) when it cannot.
 */
export async function assertSoftwareResultDeliverable(task: TaskContract, input: Omit<SoftwareResultInput, "leaseId">): Promise<void> {
  await buildSoftwareResultBundle(task, { ...input, leaseId: softwareDeliverabilityLeaseId });
}
