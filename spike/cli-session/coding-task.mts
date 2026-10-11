// Controlled one-file coding acceptance fixture, not a general artifact importer.
// The product module owns the task, snapshot and verifier; this adapter binds the
// spike task image and keeps the host-git diff roundtrip as an independent check.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TaskToolsRuntime } from "../../packages/agent-adapters/src/task-runtime.ts";
import { runOwnedCommand } from "../../packages/agent-adapters/src/owned-process.ts";
import { controlledBaseline, controlledTaskExecDescription, controlledTaskPrompt, seedControlledTask, snapshotControlledCandidate, verifyControlledCandidate, writeControlledCandidate } from "../../packages/agent-adapters/src/controlled-task.ts";
import { taskImage } from "./managed-runtime.mts";
import { validateCodingCandidateSource } from "./coding-artifact.mjs";

export const baseline = controlledBaseline;
export const correctCandidate = "export function sumIntegers(values) {\n  if (!Array.isArray(values)) throw new TypeError('Expected an array');\n  let total = 0;\n  for (const value of values) {\n    if (!Number.isSafeInteger(value)) throw new TypeError('Expected safe integers');\n    total += value;\n    if (!Number.isSafeInteger(total)) throw new RangeError('Unsafe sum');\n  }\n  return total;\n}\n";
export const taskExecDescription = controlledTaskExecDescription;
export const codingPrompt = controlledTaskPrompt;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const seedTask = seedControlledTask;
export const writeCandidate = writeControlledCandidate;
export const snapshotCandidate = (runtime: TaskToolsRuntime): Promise<string> => snapshotControlledCandidate(runtime, taskImage);
export async function verifyCandidate(source: string) {
  const result = await verifyControlledCandidate(source, taskImage);
  return {...result, network: "none", workspace: "read_only", oracle: "host_private_expected_results", agent_access: false};
}
export async function createDiff(source: string, directory: string) {
  validateCodingCandidateSource(source);
  directory=path.resolve(directory);
  // git apply supports operation outside a repository. An explicit absent
  // git-dir disables discovery of a parent repository: otherwise an ignored
  // .local subtree can make apply exit 0 after silently skipping the patch.
  const noRepository=path.join(directory,"git-discovery-disabled");
  await assert.rejects(access(noRepository),{code:"ENOENT"},"candidate_git_boundary");
  const applyIsolation=`--git-dir=${noRepository}`;
  for(const name of ["before","after"])await mkdir(path.join(directory,name),{recursive:true});
  await writeFile(path.join(directory,"before/sum.mjs"),baseline);await writeFile(path.join(directory,"after/sum.mjs"),source);
  const result=await runOwnedCommand("git",["-C",directory,"-c","core.autocrlf=false","diff","--no-index","--no-ext-diff","--no-textconv","--","before/sum.mjs","after/sum.mjs"]);
  assert.equal(result.code,1,"candidate_must_change_baseline");
  // Normalize only Git's fixed metadata headers, never candidate source lines.
  const lines=result.stdout.split("\n");
  assert.equal(lines[0],"diff --git a/before/sum.mjs b/after/sum.mjs","candidate_diff_header");
  assert.equal(lines[2],"--- a/before/sum.mjs","candidate_diff_header");
  assert.equal(lines[3],"+++ b/after/sum.mjs","candidate_diff_header");
  lines[0]="diff --git a/sum.mjs b/sum.mjs";lines[2]="--- a/sum.mjs";lines[3]="+++ b/sum.mjs";
  const patch=lines.join("\n");
  assert.ok(patch.startsWith("diff --git a/sum.mjs b/sum.mjs\n"));
  const patchFile=path.join(directory,"candidate.patch");await writeFile(patchFile,patch);
  assert.equal((await runOwnedCommand("git",["-C",path.join(directory,"before"),applyIsolation,"-c","core.autocrlf=false","apply","--check","--",patchFile])).code,0,"git_apply_check");
  const appliedDirectory=path.join(directory,"applied");await mkdir(appliedDirectory,{recursive:true});await writeFile(path.join(appliedDirectory,"sum.mjs"),baseline);
  assert.equal((await runOwnedCommand("git",["-C",appliedDirectory,applyIsolation,"-c","core.autocrlf=false","apply","--",patchFile])).code,0,"git_apply_roundtrip");
  const applied=await readFile(path.join(appliedDirectory,"sum.mjs"),"utf8");assert.equal(applied,source,"git_applied_candidate_mismatch");
  return {patch_file:patchFile,patch_sha256:sha256(patch),base_sha256:sha256(baseline),candidate_sha256:sha256(source),applied_candidate_sha256:sha256(applied),git_apply_check:true,git_apply_roundtrip:true};
}
