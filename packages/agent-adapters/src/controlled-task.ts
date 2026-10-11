// Controlled one-file coding task (controlled-sum-integers-v1). This is not a
// general artifact importer: the agent only sees /task/sum.mjs, and it never
// receives the oracle or the verifier filesystem, network or identity.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { checked } from "./managed-runtime.ts";
import { TaskToolsRuntime, dockerCommand } from "./task-runtime.ts";
import { controlledCandidateSnapshotScript, validateControlledCandidateBytes, validateControlledCandidateSource } from "./controlled-task-artifact.ts";
import { validTaskRunPatch } from "./task-run-protocol.ts";

export const controlledTaskId = "controlled-sum-integers-v1";
export const controlledBaseline = "export function sumIntegers(values) { return values.reduce((total, value) => total + value); }\n";
export const controlledTaskExecDescription = 'Execute argv directly in the isolated /task workspace, without credentials or network. The working directory is /task. There is no implicit shell and no stdin delivery. Node is available: use ["node", "-e", "JavaScript source"] to read or edit files. If a shell is needed, explicitly pass ["/bin/sh", "-c", "shell source"]. Commands default to a 3000 ms timeout; optional timeout_ms must be an integer from 1 to 30000.';
export const controlledTaskPrompt = "Fix /task/sum.mjs using only task_exec. Export sumIntegers(values). Throw TypeError if values is not an array. Empty array returns 0. Visit every array position from left to right, including empty slots. Validate each value immediately before adding it: throw TypeError at the first value that is not a safe integer. After each addition, immediately throw RangeError if the running sum is not a safe integer. Stop at the first error; do not validate later values before adding earlier ones. Use Node argv to read and edit the existing file, and try examples in the task workspace. Do not change the filename or create other files. The independent verifier runs elsewhere. Report a short completion.\n\nTask tool contract: " + controlledTaskExecDescription;
export const controlledTaskToolSchema = {
  type: "object",
  properties: {
    argv: { type: "array", minItems: 1, maxItems: 128, items: { type: "string", maxLength: 65536 } },
    timeout_ms: { type: "integer", minimum: 1, maximum: 30000 },
  },
  required: ["argv"],
  additionalProperties: false,
} as const;
// 32 JSON-transported cases plus 2 sparse arrays built inside the verifier.
export const controlledVerifierCases = 34;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const owner = "io.commongrid.spike.owner";
type Exec = Pick<TaskToolsRuntime, "exec">;

export async function seedControlledTask(runtime: Exec): Promise<void> {
  const result = await runtime.exec(["node", "-e", `require('node:fs').writeFileSync('/task/sum.mjs',${JSON.stringify(controlledBaseline)},{flag:'wx'});`]);
  assert.equal(result.code, 0, "controlled_task_seed_failed");
}
export async function writeControlledCandidate(runtime: Exec, source: string): Promise<void> {
  const result = await runtime.exec(["node", "-e", `require('node:fs').writeFileSync('/task/sum.mjs',${JSON.stringify(source)});`]);
  assert.equal(result.code, 0, "controlled_candidate_write_failed");
}

type DockerResult = {code: number | null; stdout: string};
// Docker access is injectable so unit tests never need a daemon.
export interface ControlledTaskDocker {
  checked(args: string[], timeoutMs?: number): Promise<string>;
  command(args: string[], options: {timeoutMs: number; maxBytes: number}): Promise<DockerResult>;
}
export interface ControlledStaging { volume: string; exec: Exec["exec"]; close(): Promise<unknown> }
export interface ControlledVerifierDeps extends ControlledTaskDocker {
  staging(image: string): Promise<ControlledStaging>;
}
const dockerDeps: ControlledTaskDocker = {checked: (args, timeoutMs) => checked(args, timeoutMs), command: dockerCommand};
const verifierDeps: ControlledVerifierDeps = {...dockerDeps, staging: image => TaskToolsRuntime.create({image, cpu: 1, memoryMb: 256}, 120_000)};

/** Freezes the task container, exports the single file through a read-only exporter and validates the bytes. */
export async function snapshotControlledCandidate(runtime: Pick<TaskToolsRuntime, "inspect" | "container" | "volume">, image: string, docker: ControlledTaskDocker = dockerDeps): Promise<string> {
  await runtime.inspect();
  const id = randomUUID(), name = `cg-export-${id}`;
  await docker.checked(["pause", runtime.container]);
  try {
    const result = await docker.command(["run", "--name", name, "--label", `${owner}=${id}`, "--network", "none", "--read-only", "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "128m", "--pids-limit", "16", "--mount", `type=volume,src=${runtime.volume},dst=/task,readonly,volume-nocopy`, image, "node", "-e", controlledCandidateSnapshotScript], {timeoutMs: 30_000, maxBytes: 65_536});
    assert.equal(result.code, 0, "candidate_snapshot_rejected");
    const encoded = result.stdout.trim();
    assert.ok(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded), "candidate_snapshot_encoding");
    const bytes = Buffer.from(encoded, "base64");
    assert.equal(bytes.toString("base64"), encoded, "candidate_snapshot_encoding");
    return validateControlledCandidateBytes(bytes);
  } finally {
    const found = await docker.checked(["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]);
    if (found) { assert.equal(await docker.checked(["inspect", "--format", `{{index .Config.Labels "${owner}"}}`, name]), id); await docker.checked(["rm", "--force", name]); }
    await docker.checked(["unpause", runtime.container]);
  }
}

function oracle(values: unknown): {value?: number; error?: string} {
  if (!Array.isArray(values)) return {error: "TypeError"};
  let total = 0;
  for (const value of values) { if (!Number.isSafeInteger(value)) return {error: "TypeError"}; total += value as number; if (!Number.isSafeInteger(total)) return {error: "RangeError"}; }
  return {value: total};
}
export interface ControlledVerifierResult { passed: boolean; cases: number; json_cases_passed: boolean; sparse_cases_passed: boolean; candidate_sha256: string }
/** Independent verifier: candidate code runs offline in a throwaway read-only container; expected answers stay on the host. */
export async function verifyControlledCandidate(source: string, image: string, deps: ControlledVerifierDeps = verifierDeps, signal?: AbortSignal): Promise<ControlledVerifierResult> {
  validateControlledCandidateSource(source);
  signal?.throwIfAborted();
  const staging = await deps.staging(image), id = randomUUID(), name = `cg-verifier-${id}`;
  try {
    signal?.throwIfAborted();
    await writeControlledCandidate(staging, source);
    await deps.checked(["create", "--name", name, "--label", `${owner}=${id}`, "--network", "none", "--read-only", "--user", "65532:65532", "--workdir", "/task", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "256m", "--memory-swap", "256m", "--pids-limit", "32", "--cpus", "1", "--init", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--mount", `type=volume,src=${staging.volume},dst=/task,readonly,volume-nocopy`, image, "node", "-e", "setTimeout(()=>process.exit(0),120000)"]);
    await deps.checked(["start", name]);
    signal?.throwIfAborted();
    // Host oracle is independent of all candidate code and files. Random cases
    // are generated after export; no expected answer is passed to the child.
    const cases: unknown[] = [[], [1, 2, 3], [-7, 4, -2], [0], [Number.MAX_SAFE_INTEGER], [Number.MAX_SAFE_INTEGER, 1], [Number.MIN_SAFE_INTEGER, -1], [1.2], ["2"], null, {}, [true]];
    const random = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
    for (let i = 0; i < 20; i++) cases.push(Array.from({length: i % 8}, (_, j) => (random[(i + j) % random.length] - 128) * 17));
    // Sparse arrays must be constructed in both processes: JSON would replace
    // their holes with null and hide implementations that skip empty slots.
    const sparseCases = [Array(1), [1,,]];
    const driver = "const input=JSON.parse(process.argv[1]);input.push(Array(1),[1,,]);const m=await import('/task/sum.mjs');const results=[];for(const x of input){try{results.push({value:await m.sumIntegers(x)})}catch(e){results.push({error:e.name})}}console.log(JSON.stringify(results));";
    const result = await deps.command(["exec", name, "node", "--input-type=module", "-e", driver, JSON.stringify(cases)], {timeoutMs: 5000, maxBytes: 16_384});
    let jsonCasesPassed = false, sparseCasesPassed = false;
    try {
      assert.equal(result.code, 0);
      const results = JSON.parse(result.stdout);
      assert.deepEqual(results.slice(0, cases.length), cases.map(oracle)); jsonCasesPassed = true;
      assert.deepEqual(results.slice(cases.length), sparseCases.map(oracle)); sparseCasesPassed = true;
    } catch {}
    const hash = await deps.checked(["exec", name, "node", "-e", "const fs=require('node:fs'),c=require('node:crypto');console.log(c.createHash('sha256').update(fs.readFileSync('/task/sum.mjs')).digest('hex'));"], 10_000);
    assert.equal(hash, sha256(source), "verifier_candidate_mutated");
    return {passed: jsonCasesPassed && sparseCasesPassed, cases: cases.length + sparseCases.length, json_cases_passed: jsonCasesPassed, sparse_cases_passed: sparseCasesPassed, candidate_sha256: hash};
  } finally {
    // Cleanup always completes; a failure of either step surfaces to the caller.
    const failures: unknown[] = [];
    try {
      const found = await deps.checked(["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]);
      if (found) { assert.equal(await deps.checked(["inspect", "--format", `{{index .Config.Labels "${owner}"}}`, name]), id); await deps.checked(["rm", "--force", name]); }
    } catch (error) { failures.push(error); }
    try { await staging.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "controlled_verifier_cleanup_failed");
  }
}

// ---- In-memory unified diff of the single controlled file -----------------

// Lines keep their terminating "\n", so a missing final newline is a real
// difference between two otherwise equal last lines.
const lineTokens = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
type Op = {t: "=" | "-" | "+"; token: string};
const maxDynamicCells = 4_000_000;
function editScript(before: string[], after: string[]): Op[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const a = before.slice(prefix, before.length - suffix), b = after.slice(prefix, after.length - suffix);
  const ops: Op[] = before.slice(0, prefix).map(token => ({t: "=", token}));
  if ((a.length + 1) * (b.length + 1) > maxDynamicCells) {
    // Still a correct (just not minimal) diff for very large rewrites.
    for (const token of a) ops.push({t: "-", token});
    for (const token of b) ops.push({t: "+", token});
  } else {
    const width = b.length + 1, table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({t: "=", token: a[i]}); i++; j++; }
      else if (j >= b.length || (i < a.length && table[(i + 1) * width + j] >= table[i * width + j + 1])) ops.push({t: "-", token: a[i++]});
      else ops.push({t: "+", token: b[j++]});
    }
  }
  for (const token of before.slice(before.length - suffix)) ops.push({t: "=", token});
  return ops;
}
const blobId = (value: string) => createHash("sha1").update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest("hex").slice(0, 7);
const patchHeader = "diff --git a/sum.mjs b/sum.mjs\n";
const noNewline = "\\ No newline at end of file";
const range = (before: number, count: number) => count === 1 ? String(before + 1) : `${before + (count === 0 ? 0 : 1)},${count}`;
const bodyLines = (prefix: string, token: string) => token.endsWith("\n") ? [prefix + token.slice(0, -1)] : [prefix + token, noNewline];

/** Git-style unified diff (3 lines of context) from the fixed baseline to a candidate. */
export function buildControlledPatch(source: string, baseline = controlledBaseline): string {
  validateControlledCandidateSource(source);
  if (source === baseline) throw new Error("candidate_unchanged");
  const ops = editScript(lineTokens(baseline), lineTokens(source));
  const changes = ops.flatMap((op, index) => op.t === "=" ? [] : [index]);
  const groups: Array<[number, number]> = [];
  for (const index of changes) {
    const last = groups.at(-1);
    if (last && index - last[1] - 1 <= 6) last[1] = index; else groups.push([index, index]);
  }
  const before = new Array<number>(ops.length + 1).fill(0), after = new Array<number>(ops.length + 1).fill(0);
  ops.forEach((op, index) => { before[index + 1] = before[index] + (op.t === "+" ? 0 : 1); after[index + 1] = after[index] + (op.t === "-" ? 0 : 1); });
  const lines = [patchHeader.trimEnd(), `index ${blobId(baseline)}..${blobId(source)} 100644`, "--- a/sum.mjs", "+++ b/sum.mjs"];
  for (const [first, last] of groups) {
    const from = Math.max(0, first - 3), to = Math.min(ops.length, last + 4);
    lines.push(`@@ -${range(before[from], before[to] - before[from])} +${range(after[from], after[to] - after[from])} @@`);
    for (const op of ops.slice(from, to)) lines.push(...bodyLines(op.t === "=" ? " " : op.t, op.token));
  }
  const patch = lines.join("\n") + "\n";
  // CRLF sources, oversize diffs and anything else the public contract
  // rejects cannot be reported as a patch.
  if (!validTaskRunPatch(patch)) throw new Error("candidate_patch_invalid");
  return patch;
}
const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/;
/** Strict single-file apply, in memory: any context mismatch, bad count or stray line throws. */
export function applyControlledPatch(baseline: string, patch: string): string {
  const fail = (): never => { throw new Error("candidate_patch_apply_failed"); };
  const lines = patch.split("\n");
  if (lines.pop() !== "" || lines.length < 5 || lines[0] !== patchHeader.trimEnd()) fail();
  let at = 1;
  if (/^index [0-9a-f]{7,40}\.\.[0-9a-f]{7,40} 100644$/.test(lines[at])) at++;
  if (lines[at++] !== "--- a/sum.mjs" || lines[at++] !== "+++ b/sum.mjs") fail();
  const base = lineTokens(baseline), out: string[] = [];
  let position = 0, hunks = 0;
  while (at < lines.length) {
    const header = hunkHeader.exec(lines[at++]);
    if (!header) return fail();
    const oldCount = header[2] === undefined ? 1 : Number(header[2]), newCount = header[4] === undefined ? 1 : Number(header[4]);
    const start = oldCount === 0 ? Number(header[1]) : Number(header[1]) - 1;
    if (start < position || start > base.length) fail();
    out.push(...base.slice(position, start)); position = start;
    let seenOld = 0, seenNew = 0;
    while (at < lines.length && !lines[at].startsWith("@@ ")) {
      const line = lines[at++], prefix = line[0];
      if (prefix !== " " && prefix !== "-" && prefix !== "+") return fail();
      const noEol = lines[at] === noNewline; if (noEol) at++;
      const token = line.slice(1) + (noEol ? "" : "\n");
      if (prefix !== "+") { if (base[position] !== token) fail(); position++; seenOld++; }
      if (prefix !== "-") { out.push(token); seenNew++; }
    }
    if (seenOld !== oldCount || seenNew !== newCount) fail();
    hunks++;
  }
  if (!hunks) fail();
  out.push(...base.slice(position));
  return out.join("");
}
export interface ControlledPatch { patch: string; patch_sha256: string; base_sha256: string; candidate_sha256: string; applied_candidate_sha256: string }
/** Builds the patch and proves it turns the baseline into exactly this candidate. */
export function createControlledPatch(source: string, baseline = controlledBaseline): ControlledPatch {
  const patch = buildControlledPatch(source, baseline), applied = applyControlledPatch(baseline, patch);
  if (applied !== source) throw new Error("candidate_patch_roundtrip_failed");
  return {patch, patch_sha256: sha256(patch), base_sha256: sha256(baseline), candidate_sha256: sha256(source), applied_candidate_sha256: sha256(applied)};
}
