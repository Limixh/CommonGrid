import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { applyControlledPatch, buildControlledPatch, controlledBaseline, controlledTaskPrompt, controlledTaskToolSchema, controlledVerifierCases, createControlledPatch,
  snapshotControlledCandidate, verifyControlledCandidate, type ControlledVerifierDeps } from "../src/controlled-task.ts";
import { controlledCandidateSnapshotScript, validateControlledCandidateBytes, validateControlledCandidateSource } from "../src/controlled-task-artifact.ts";
import { taskRunMaxPatchBytes, validTaskRunPatch } from "../src/task-run-protocol.ts";

const correct = "export function sumIntegers(values) {\n  if (!Array.isArray(values)) throw new TypeError('Expected an array');\n  let total = 0;\n  for (const value of values) {\n    if (!Number.isSafeInteger(value)) throw new TypeError('Expected safe integers');\n    total += value;\n    if (!Number.isSafeInteger(total)) throw new RangeError('Unsafe sum');\n  }\n  return total;\n}\n";
// Prevalidates every value, so it passes all JSON cases but skips empty slots.
const skipsHoles = "export function sumIntegers(values) {\n  if (!Array.isArray(values) || !values.every(Number.isSafeInteger)) throw new TypeError('Expected safe integers');\n  let total = 0;\n  for (const value of values) {\n    total += value;\n    if (!Number.isSafeInteger(total)) throw new RangeError('Unsafe sum');\n  }\n  return total;\n}\n";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("artifact policy accepts normal UTF-8 source and rejects unsafe or secret content without disclosing it", () => {
  const source = "// Türkçe örnek\nexport function sumIntegers(values) { return 0; }\n";
  assert.equal(validateControlledCandidateBytes(Buffer.from(source)), source);
  validateControlledCandidateSource(source); validateControlledCandidateSource(" ".repeat(16384));
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0xed, 0xa0, 0x80])]) assert.throws(() => validateControlledCandidateBytes(bytes), /candidate_invalid_utf8/);
  for (const text of ["a\0b", "a\x1bb", "a\u202eb", "a\u2066b"]) assert.throws(() => validateControlledCandidateSource(text), /candidate_unsafe_content/);
  assert.throws(() => validateControlledCandidateSource("\ud800"), /candidate_invalid_utf8/);
  assert.throws(() => validateControlledCandidateSource(" ".repeat(16385)), /candidate_limit/);
  const canary = "Bearer synthetic-canary-token-value";
  assert.throws(() => validateControlledCandidateSource(`/* ${canary} */\n`), error => { assert.equal((error as Error).message, "candidate_secret_content"); return true; });
  validateControlledCandidateSource("// access token checks belong outside sumIntegers\nexport const tokenCount = 0;\n");
});
test("exporter script embeds the validator without literal bidi characters and rejects before stdout", async () => {
  assert.ok(!new RegExp("[\\u202a-\\u202e\\u2066-\\u2069]").test(controlledCandidateSnapshotScript));
  const run = (setup: (directory: string) => Promise<void> | void) => mkdtemp(path.join(tmpdir(), "cg-controlled-export-")).then(async root => {
    const directory = path.join(root, "task"), output: string[] = [];
    try {
      await mkdir(directory); await setup(directory);
      const fs = await import("node:fs"), map = (value: unknown) => value === "/task" ? directory : value === "/task/sum.mjs" ? path.join(directory, "sum.mjs") : value as string;
      const facade = new Proxy(fs, {get(target, property) {
        if (property === "constants") return target.constants;
        if (["readdirSync", "lstatSync", "openSync"].includes(property as string)) return (value: unknown, ...args: unknown[]) => (target as any)[property](map(value), ...args);
        return (target as any)[property];
      }});
      vm.runInNewContext(controlledCandidateSnapshotScript, {require: () => facade, Buffer, TextDecoder, console: {log: (value: string) => output.push(value)}}, {timeout: 1000});
      return output;
    } catch (error) { assert.deepEqual(output, []); throw error; } finally { await rm(root, {recursive: true, force: true}); }
  });
  await Promise.all([
    run(directory => writeFile(path.join(directory, "sum.mjs"), correct)).then(output => assert.deepEqual(output, [Buffer.from(correct).toString("base64")])),
    assert.rejects(run(directory => writeFile(path.join(directory, "sum.mjs"), "// \u202e hidden\n")), /candidate_unsafe_content/),
    assert.rejects(run(async directory => { await writeFile(path.join(directory, "sum.mjs"), correct); await writeFile(path.join(directory, "other.mjs"), "x"); }), /artifact_inventory/),
  ]);
});

test("patch has the fixed header, validates against the public contract and applies back to the exact candidate", () => {
  const patch = buildControlledPatch(correct);
  assert.ok(patch.startsWith("diff --git a/sum.mjs b/sum.mjs\n")); assert.ok(validTaskRunPatch(patch));
  assert.match(patch, /\n--- a\/sum\.mjs\n\+\+\+ b\/sum\.mjs\n@@ -1 \+1,10 @@\n-export function sumIntegers\(values\) \{ return values\.reduce/);
  assert.equal(applyControlledPatch(controlledBaseline, patch), correct);
  const evidence = createControlledPatch(correct);
  assert.deepEqual(evidence, {patch, patch_sha256: sha256(patch), base_sha256: sha256(controlledBaseline), candidate_sha256: sha256(correct), applied_candidate_sha256: sha256(correct)});
  assert.ok(Buffer.byteLength(patch) < taskRunMaxPatchBytes);
});
test("patch builder handles multiple hunks, missing final newlines, deletions and equal-prefix files", () => {
  const lines = (count: number, change: number[] = []) => Array.from({length: count}, (_, index) => change.includes(index) ? `changed ${index}` : `line ${index}`).join("\n") + "\n";
  const cases: Array<[string, string]> = [
    [lines(40), lines(40, [2, 30])], [lines(40), lines(40, [2, 6])], [lines(40), lines(40, [0, 39])], [lines(5), lines(5) + "tail\n"], [lines(5), lines(3)],
    ["a\nb", "a\nb\n"], ["a\nb\n", "a\nb"], ["a\nb", "a\nc"], ["x\n", "y\nx\n"], ["a\n", ""], ["", "a\n"], ["a\nb\nc\nd\n", "d\nc\nb\na\n"],
  ];
  for (const [before, after] of cases) {
    const patch = buildControlledPatch(after, before);
    assert.ok(validTaskRunPatch(patch), JSON.stringify([before, after])); assert.equal(applyControlledPatch(before, patch), after, JSON.stringify([before, after]));
  }
  assert.equal(buildControlledPatch(lines(40, [2, 6]), lines(40)).match(/^@@/gm)?.length, 1);
  assert.equal(buildControlledPatch(lines(40, [2, 30]), lines(40)).match(/^@@/gm)?.length, 2);
  assert.throws(() => buildControlledPatch(controlledBaseline), /candidate_unchanged/);
});
test("large unrelated rewrites fall back to a correct whole-file hunk", () => {
  const before = Array.from({length: 2100}, (_, index) => `a${index}`).join("\n") + "\n", after = Array.from({length: 2100}, (_, index) => `b${index}`).join("\n") + "\n";
  const patch = buildControlledPatch(after, before); assert.equal(applyControlledPatch(before, patch), after);
});
test("CRLF, oversize, bidi and secret candidates never become a patch", () => {
  assert.throws(() => buildControlledPatch("export const x = 1;\r\n"), /candidate_patch_invalid/);
  assert.throws(() => buildControlledPatch(controlledBaseline.replace("\n", "\r\n") + "x\n"), /candidate_patch_invalid/);
  assert.throws(() => buildControlledPatch("// \u202e\nexport const x = 1;\n"), /candidate_unsafe_content/);
  assert.throws(() => buildControlledPatch("const password = 'synthetic_canary_value';\n"), /candidate_secret_content/);
  assert.throws(() => buildControlledPatch("x".repeat(16385)), /candidate_limit/);
  const hugeBase = Array.from({length: 4000}, (_, index) => `before line ${index}`).join("\n") + "\n";
  const candidate = Array.from({length: 900}, (_, index) => `after ${index}`).join("\n") + "\n";
  assert.ok(Buffer.byteLength(hugeBase) > 40_000);
  assert.throws(() => buildControlledPatch(candidate, hugeBase), /candidate_patch_invalid/);
});
test("apply check is strict about headers, context, counts and stray lines", () => {
  const patch = buildControlledPatch(correct);
  const mutations: Array<(value: string) => string> = [
    value => value.replace("diff --git a/sum.mjs", "diff --git a/other.mjs"), value => value.replace("--- a/sum.mjs", "--- a/other.mjs"), value => value.replace("@@ -1 +1,10 @@", "@@ -1 +1,12 @@"),
    value => value.replace("-export function", "-export  function"), value => value + "+extra\n", value => value.slice(0, -1), value => value.replace("\n@@", "\n\n@@"), value => value.replace("-export", "~export"),
    value => value.split("\n").slice(0, 4).join("\n") + "\n", value => value.replace("@@ -1 +1,10 @@", "@@ -2 +1,10 @@"),
  ];
  for (const mutate of mutations) assert.throws(() => applyControlledPatch(controlledBaseline, mutate(patch)), /candidate_patch_apply_failed/);
  assert.throws(() => applyControlledPatch("different\n", patch), /candidate_patch_apply_failed/);
});
test("in-memory patch matches the host git diff for the same inputs when git is available", async t => {
  try { execFileSync("git", ["--version"], {stdio: "ignore"}); } catch { t.skip("git unavailable"); return; }
  const directory = await mkdtemp(path.join(tmpdir(), "cg-controlled-git-"));
  try {
    for (const candidate of [correct, skipsHoles, "export const x = 1;"]) {
      await mkdir(path.join(directory, "before"), {recursive: true}); await mkdir(path.join(directory, "after"), {recursive: true});
      await writeFile(path.join(directory, "before/sum.mjs"), controlledBaseline); await writeFile(path.join(directory, "after/sum.mjs"), candidate);
      const stdout = await new Promise<string>(resolve => execFile("git", ["-C", directory, "-c", "core.autocrlf=false", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "before/sum.mjs", "after/sum.mjs"], (_error, output) => resolve(output)));
      const lines = stdout.split("\n"); lines[0] = "diff --git a/sum.mjs b/sum.mjs"; lines[2] = "--- a/sum.mjs"; lines[3] = "+++ b/sum.mjs";
      assert.equal(buildControlledPatch(candidate), lines.join("\n"));
    }
  } finally { await rm(directory, {recursive: true, force: true}); }
});

// A node-backed stand-in for the offline verifier container: it runs the real driver
// script against the candidate, with only the module path replaced.
function verifierFixture(options: {mutate?: boolean} = {}) {
  const calls: string[] = [], state = {source: ""};
  const deps: ControlledVerifierDeps = {
    async staging() {
      calls.push("staging");
      return {volume: "cg-workspace-fixture", async exec(argv) { const match = /writeFileSync\('\/task\/sum\.mjs',(".*")\);$/s.exec(argv[2]); state.source = JSON.parse(match![1]); calls.push("write"); return {code: 0, stdout: "", stderr: ""}; },
        async close() { calls.push("close"); }};
    },
    async checked(args) {
      calls.push(args[0]);
      if (args[0] === "exec") return options.mutate ? "0".repeat(64) : sha256(state.source);
      return "";
    },
    async command(args) {
      calls.push("verify"); assert.equal(args[0], "exec");
      const driver = args[5].replace("'/task/sum.mjs'", JSON.stringify(`data:text/javascript;base64,${Buffer.from(state.source).toString("base64")}`));
      return new Promise(resolve => execFile(process.execPath, ["--input-type=module", "-e", driver, args[6]], (error, stdout) => resolve({code: error ? 1 : 0, stdout})));
    },
  };
  return {calls, deps};
}
test("independent verifier runs 34 cases and separates JSON-case failures from sparse-array failures", async () => {
  const image = "node@sha256:" + "0".repeat(64);
  for (const [source, passed, json, sparse] of [[correct, true, true, true], [controlledBaseline, false, false, false], [skipsHoles, false, true, false], ["process.exit(0);\n", false, false, false]] as const) {
    const f = verifierFixture(), result = await verifyControlledCandidate(source, image, f.deps);
    assert.deepEqual(result, {passed, cases: controlledVerifierCases, json_cases_passed: json, sparse_cases_passed: sparse, candidate_sha256: sha256(source)});
    assert.deepEqual(f.calls, ["staging", "write", "create", "start", "verify", "exec", "container", "close"]);
  }
});
test("verifier refuses unsafe sources before any Docker resource and still cleans after a mutated candidate", async () => {
  const f = verifierFixture();
  for (const source of ["// Bearer synthetic-canary-token-value\n", "a\0b", " ".repeat(16385), "\ud800"]) await assert.rejects(verifyControlledCandidate(source, "image", f.deps), /candidate_/);
  assert.deepEqual(f.calls, []);
  const mutated = verifierFixture({mutate: true});
  await assert.rejects(verifyControlledCandidate(correct, "image", mutated.deps), /verifier_candidate_mutated/);
  assert.equal(mutated.calls.at(-1), "close");
  const controller = new AbortController(); controller.abort("cancelled");
  const aborted = verifierFixture();
  await assert.rejects(verifyControlledCandidate(correct, "image", aborted.deps, controller.signal));
  assert.deepEqual(aborted.calls, []);
});
test("snapshot freezes the task, decodes only canonical base64 and always unpauses", async () => {
  for (const [stdout, ok] of [[Buffer.from(correct).toString("base64") + "\n", true], ["not base64!", false], [Buffer.from("a\0b").toString("base64"), false]] as const) {
    const calls: string[] = [];
    const docker = {
      async checked(args: string[]) { calls.push(args[0]); return args[0] === "container" ? "" : ""; },
      async command(args: string[]) { calls.push("run"); assert.ok(args.includes("--network") && args.includes("none")); assert.ok(args.some(arg => arg.includes("readonly"))); assert.ok(args.includes("image")); return {code: 0, stdout}; },
    };
    const runtime = {container: "task-container", volume: "task-volume", async inspect() { calls.push("inspect"); return {}; }};
    const outcome = snapshotControlledCandidate(runtime as any, "image", docker);
    if (ok) assert.equal(await outcome, correct); else await assert.rejects(outcome);
    assert.deepEqual(calls, ["inspect", "pause", "run", "container", "unpause"]);
  }
});
test("prompt and tool schema stay the accepted fixed contract", () => {
  assert.ok(controlledTaskPrompt.includes("Fix /task/sum.mjs using only task_exec.") && controlledTaskPrompt.includes("Task tool contract: "));
  assert.deepEqual(Object.keys(controlledTaskToolSchema.properties), ["argv", "timeout_ms"]); assert.deepEqual(controlledTaskToolSchema.required, ["argv"]); assert.equal(controlledTaskToolSchema.additionalProperties, false);
});
