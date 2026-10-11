import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BindingFailure, type ProfileBinding } from "../../../apps/desktop/native-worker/profile-bindings.ts";
import { verifyAssets, type Boot } from "../../../apps/desktop/native-worker/cli-check.ts";
import { parseTaskRunBoot, runTaskRun, taskRunBindingRoot, type TaskRunBoot, type TaskRunDependencies, type TaskRunFrame, type TaskRunRuntime, type TaskRunSandbox } from "../../../apps/desktop/native-worker/task-run.ts";
import { ControlledTaskCleanupError, applyControlledPatch, controlledBaseline, createControlledPatch, controlledVerifierCases } from "../src/controlled-task.ts";
import { TaskToolLimitError, type ProviderTurnOptions } from "../src/controlled-task-session.ts";
import type { ManagedRuntimeAssets } from "../src/managed-runtime.ts";
import { ProviderFailure } from "../src/session-protocol.ts";
import { acceptTaskRunUpdate, taskRunMaxFrameBytes, taskRunMaxToolCalls, taskRunObservedModels, taskRunRequestedModels, validateTaskRunStatus, type TaskRunProvider, type TaskRunStatus } from "../src/task-run-protocol.ts";
import pins from "../runtime-assets/native-cli-assets.lock.json";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const correct = "export function sumIntegers(values) {\n  if (!Array.isArray(values)) throw new TypeError('Expected an array');\n  let total = 0;\n  for (const value of values) {\n    if (!Number.isSafeInteger(value)) throw new TypeError('Expected safe integers');\n    total += value;\n    if (!Number.isSafeInteger(total)) throw new RangeError('Unsafe sum');\n  }\n  return total;\n}\n";
const bootFor = (provider: TaskRunProvider): TaskRunBoot => ({type: "task_run_boot", schema_version: "1.0", request_id: randomUUID(), profile_id: randomUUID(), provider, task_id: "controlled-sum-integers-v1",
  journal_root: path.resolve("fixture-journal"), assets_root: path.resolve("fixture-assets"), profile_registry_root: path.resolve("fixture-appdata", "managed-profiles")});
const assetsFor = (boot: TaskRunBoot, catalog = true): ManagedRuntimeAssets => ({baseImage: "node@sha256:" + "0".repeat(64), journalRoot: boot.journal_root, bridgeRoot: boot.assets_root,
  binaries: {claude: {binaryPath: path.resolve("fixture-claude"), sha256: "0".repeat(64)}, codex: {binaryPath: path.resolve("fixture-codex"), sha256: "1".repeat(64)}},
  ...(catalog ? {codexCatalog: {filePath: path.resolve("fixture-assets", "codex-coding-catalog.json"), sha256: pins.codex_catalog.sha256}} : {})});

interface Options { provider?: TaskRunProvider; binding?: ProfileBinding | null; catalog?: boolean }
function fixture(options: Options = {}) {
  const provider = options.provider ?? "codex", boot = bootFor(provider), calls: string[] = [], frames: TaskRunFrame[] = [], stats = {control_failure: false, task_calls: 2};
  const owner = randomUUID();
  const binding: ProfileBinding | undefined = options.binding === null ? undefined : options.binding ?? {schema_version: "1.0", profile_id: boot.profile_id, provider, owner, state: "ready"};
  const assets = assetsFor(boot, options.catalog ?? true);
  let retained = 0;
  const runtime: TaskRunRuntime = {
    async beginOperation() { calls.push("begin"); },
    async installCodexCodingCatalog() { calls.push("install-catalog"); },
    async start() { calls.push("start"); },
    async exec(argv) { calls.push("exec"); assert.equal(argv[0], "node"); return {code: 0, stdout: pins.codex_catalog.sha256 + "\n", stderr: ""}; },
    async retainOperation() { calls.push("retain"); retained++; return () => { calls.push("release"); retained--; }; },
    async stop(destroy, config) { calls.push("stop"); assert.equal(destroy, false); assert.equal(config?.signal?.aborted, false); },
    async finishOperation(config) { calls.push("finish"); assert.equal(retained, 0, "operation borrower released before quiescent finish"); assert.equal(config?.signal?.aborted, false); },
    async verifyOperation() { throw new Error("fixture_no_docker"); }, async beginNamespaceExec() { throw new Error("fixture_no_docker"); },
  };
  const sandbox = {
    container: "cg-task-fixture", volume: "cg-workspace-fixture",
    async exec(argv: string[]) { calls.push("seed"); assert.equal(argv[0], "node"); return {code: 0, stdout: "", stderr: ""}; },
    async close() { calls.push("sandbox-close"); }, async inspect() { return {}; },
  } as unknown as TaskRunSandbox;
  const deps: TaskRunDependencies = {
    bindings(root) { assert.equal(root, taskRunBindingRoot(boot)); return {async read(profileId, requested) { calls.push("read"); assert.equal(profileId, boot.profile_id); assert.equal(requested, provider); return binding; }}; },
    async assets() { calls.push("assets"); return assets; },
    async prerequisite() { calls.push("prerequisite"); },
    restore(restored, actualAssets) { calls.push("restore"); assert.equal(restored, binding); assert.equal(actualAssets, assets); return runtime; },
    async sandbox(image) { calls.push("sandbox"); assert.equal(image, assets.baseImage); return sandbox; },
    async bridge() { calls.push("bridge"); return {stats, close() { calls.push("bridge-close"); }}; },
    async provider(turn: ProviderTurnOptions) {
      calls.push("provider"); assert.equal(turn.provider, provider); assert.equal(retained, 1); assert.equal(turn.runtime, runtime); assert.equal(turn.bridgeStats, stats);
      turn.observer.model(taskRunObservedModels[provider][0]); turn.observer.toolCall(1); turn.observer.toolCall(2); turn.trace.quiescent = true;
    },
    async snapshot(actual, image) { calls.push("snapshot"); assert.equal(actual, sandbox); assert.equal(image, assets.baseImage); return correct; },
    async verify(source, image) { calls.push("verify"); assert.equal(image, assets.baseImage); return {passed: true, cases: controlledVerifierCases, json_cases_passed: true, sparse_cases_passed: true, candidate_sha256: sha256(source)}; },
  };
  const run = (signal = new AbortController().signal) => runTaskRun(boot, signal, frame => frames.push(frame), deps);
  return {boot, calls, frames, stats, runtime, sandbox, deps, binding, owner, assets, run};
}
type ResultFrame = Extract<TaskRunFrame, {type: "result"}>;
const result = (frames: TaskRunFrame[]) => frames.at(-1) as ResultFrame;
// The Rust supervisor's wire rules for worker frames: ordered adjacent phases (cleaning may be
// entered from anywhere), model/activity only while running or verifying, one final result.
function assertSupervisorRules(frames: TaskRunFrame[]) {
  const order = ["preparing", "running", "verifying", "cleaning"];
  assert.ok(frames.length <= 64 && frames.every(frame => Buffer.byteLength(JSON.stringify(frame) + "\n") <= 65_536));
  let phase = -1, tools = 0, models = 0, results = 0;
  frames.forEach((frame, index) => {
    assert.equal(results, 0, "nothing follows the result frame");
    if (frame.type === "progress") {
      const next = order.indexOf(frame.phase);
      assert.ok(next === phase + 1 || (next === 3 && phase >= 0 && phase < 3) || (phase === -1 && next === 0), `phase ${frame.phase} after ${order[phase]}`); phase = next;
    } else if (frame.type === "model" || frame.type === "activity") {
      assert.ok(phase === 1 || phase === 2, `${frame.type} while ${order[phase]}`);
      if (frame.type === "model") assert.equal(++models, 1);
      else { assert.ok(frame.tool_calls >= tools && frame.tool_calls <= taskRunMaxToolCalls && frame.tool_calls > 0); tools = frame.tool_calls; }
    } else {
      results++; assert.equal(phase, 3, "result only after cleaning"); assert.equal(index, frames.length - 1);
      if (frame.outcome === "passed" || frame.outcome === "rejected") assert.ok(models === 1 && tools >= 1, "success needs a reported model and tool call");
    }
  });
  assert.equal(results, 1, "exactly one result");
}
// Plays the native supervisor: every frame becomes a public status that must be
// accepted by the same monotonic/terminal rules the browser contract enforces.
function supervise(boot: TaskRunBoot, frames: TaskRunFrame[]): TaskRunStatus {
  assertSupervisorRules(frames);
  let previous: TaskRunStatus | null = null, phase: "starting" | "preparing" | "running" | "verifying" | "cleaning" | "finished" = "starting", tools = 0, observed: string | null = null, revision = 0;
  for (const frame of frames) {
    revision++;
    if (frame.type === "progress") phase = frame.phase; else if (frame.type === "activity") tools = frame.tool_calls; else if (frame.type === "model") observed = frame.observed; else phase = "finished";
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= taskRunMaxFrameBytes);
    const final = frame.type === "result";
    previous = acceptTaskRunUpdate(previous, {schema_version: "1.0", availability: "available", operation: {request_id: boot.request_id, profile_id: boot.profile_id, provider: boot.provider, task_id: boot.task_id,
      revision, phase, outcome: final ? frame.outcome : null, error_code: final ? frame.error_code : null, cleanup: final ? frame.cleanup : "pending", tool_calls: tools,
      model: {requested: taskRunRequestedModels[boot.provider], observed}, result: final ? frame.result : null}});
  }
  return validateTaskRunStatus(previous);
}
const types = (frames: TaskRunFrame[]) => frames.map(frame => frame.type === "progress" ? frame.phase : frame.type);

test("boot accepts only the exact trusted fixed shape with absolute native paths", () => {
  const boot = bootFor("codex");
  assert.deepEqual(parseTaskRunBoot(boot), boot);
  assert.equal(taskRunBindingRoot(boot), path.resolve("fixture-appdata", "managed-profile-sessions"));
  const {journal_root: _journal, ...missing} = boot;
  for (const value of [{...boot, argv: []}, missing, {...boot, profile_id: "../x"}, {...boot, request_id: "x"}, {...boot, provider: "api"}, {...boot, task_id: "other-task"}, {...boot, task_id: undefined},
    {...boot, assets_root: "relative"}, {...boot, journal_root: path.resolve("x") + "\n"}, {...boot, profile_registry_root: path.resolve("foreign-profile-store")}, {...boot, type: "profile_session_boot"},
    {...boot, model: "gpt-5"}, {...boot, prompt: "x"}, null, [], "boot"]) assert.throws(() => parseTaskRunBoot(value));
});
test("Codex happy path restores the bound runtime, installs the pinned catalog and emits an ordered, contract-valid sequence", async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.calls, ["read", "assets", "prerequisite", "restore", "begin", "install-catalog", "start", "exec", "retain", "sandbox", "seed", "bridge", "provider", "bridge-close", "snapshot", "verify", "bridge-close", "sandbox-close", "stop", "release", "finish"]);
  assert.deepEqual(types(f.frames), ["preparing", "running", "model", "activity", "activity", "verifying", "cleaning", "result"]);
  assert.deepEqual(f.frames.filter(frame => frame.type === "model"), [{type: "model", observed: "gpt-6-luna"}]);
  assert.deepEqual(f.frames.filter(frame => frame.type === "activity"), [{type: "activity", tool_calls: 1}, {type: "activity", tool_calls: 2}]);
  const final = result(f.frames), expected = createControlledPatch(correct);
  assert.equal(final.outcome, "passed"); assert.equal(final.error_code, null); assert.equal(final.cleanup, "verified");
  assert.deepEqual(final.result, {verifier: {passed: true, cases: 34, json_cases_passed: true, sparse_cases_passed: true}, candidate_sha256: sha256(correct), patch_sha256: expected.patch_sha256, patch: expected.patch});
  assert.equal(applyControlledPatch(controlledBaseline, final.result!.patch!), correct);
  const status = supervise(f.boot, f.frames);
  assert.equal(status.operation?.outcome, "passed"); assert.equal(status.operation?.tool_calls, 2); assert.equal(status.operation?.model.observed, "gpt-6-luna");
});
test("Claude happy path needs no catalog and uses the same cheap-model contract", async () => {
  const f = fixture({provider: "claude", catalog: false}); await f.run();
  assert.ok(!f.calls.includes("install-catalog") && !f.calls.includes("exec"));
  assert.deepEqual(types(f.frames), ["preparing", "running", "model", "activity", "activity", "verifying", "cleaning", "result"]);
  assert.equal(result(f.frames).outcome, "passed"); assert.equal(supervise(f.boot, f.frames).operation?.model.observed, "claude-haiku-4-5-20251001");
});
test("unbound, reserved and invalid profile bindings stop before assets, Docker or any runtime", async () => {
  const unbound = fixture({binding: null}); await unbound.run();
  assert.deepEqual(unbound.calls, ["read"]); assert.deepEqual(types(unbound.frames), ["preparing", "cleaning", "result"]);
  assert.deepEqual(result(unbound.frames), {type: "result", outcome: "failed", error_code: "profile_unbound", cleanup: "verified", result: null}); supervise(unbound.boot, unbound.frames);
  const base = fixture().binding!;
  const reserved = fixture({binding: {...base, state: "reserved"}}); await reserved.run();
  assert.deepEqual(reserved.calls, ["read"]);
  assert.deepEqual(result(reserved.frames), {type: "result", outcome: "needs_review", error_code: "profile_needs_review", cleanup: "unknown", result: null}); supervise(reserved.boot, reserved.frames);
  const invalid = fixture(); invalid.deps.bindings = () => ({async read() { throw new BindingFailure("profile_invalid"); }}); await invalid.run();
  assert.deepEqual(result(invalid.frames), {type: "result", outcome: "failed", error_code: "profile_invalid", cleanup: "verified", result: null});
});
test("setup failures map to closed codes before any mutation and never leak details", async () => {
  for (const [stage, code, expected] of [["assets", "asset_missing", "asset_missing"], ["assets", "asset_invalid", "asset_invalid"], ["prerequisite", "docker_unavailable", "docker_unavailable"], ["prerequisite", "image_missing", "image_missing"], ["prerequisite", "other", "worker_failed"]] as const) {
    const f = fixture(); f.deps[stage] = async () => { throw Object.assign(new Error("PRIVATE_DETAIL"), {code}); };
    await f.run(); assert.ok(!f.calls.includes("restore")); assert.equal(result(f.frames).error_code, expected); assert.equal(result(f.frames).cleanup, "verified"); assert.ok(!JSON.stringify(f.frames).includes("PRIVATE"));
  }
  const noCatalog = fixture({catalog: false}); await noCatalog.run();
  assert.deepEqual(noCatalog.calls, ["read", "assets"]); assert.equal(result(noCatalog.frames).error_code, "asset_missing");
  const tampered = fixture(); tampered.runtime.exec = async () => ({code: 0, stdout: "0".repeat(64) + "\n", stderr: ""}); await tampered.run();
  assert.equal(result(tampered.frames).error_code, "asset_invalid"); assert.ok(!tampered.calls.includes("provider")); assert.equal(result(tampered.frames).cleanup, "verified");
  const busy = fixture(); busy.runtime.beginOperation = async () => { throw new Error("managed_profile_busy"); }; await busy.run();
  assert.equal(result(busy.frames).error_code, "profile_needs_review"); assert.equal(result(busy.frames).outcome, "needs_review"); supervise(busy.boot, busy.frames);
});
test("a missing or different model stops the run: no fallback, no verification, no model frame", async () => {
  for (const provider of ["codex", "claude"] as const) {
    for (const when of ["before-observation", "after-observation"] as const) {
      const f = fixture({provider}); f.deps.provider = async turn => { if (when === "after-observation") { turn.observer.model(taskRunObservedModels[provider][0]); turn.observer.toolCall(1); } throw new ProviderFailure("model"); };
      await f.run();
      assert.deepEqual(result(f.frames), {type: "result", outcome: "failed", error_code: "model_unavailable", cleanup: "verified", result: null});
      assert.ok(!f.calls.includes("snapshot") && !f.calls.includes("verify")); supervise(f.boot, f.frames);
    }
    // An identity outside the accepted list is never reported or counted as observed.
    const mismatch = fixture({provider}); mismatch.deps.provider = async turn => { turn.observer.model("gpt-5.5-sonnet-or-astra"); turn.observer.toolCall(1); turn.trace.quiescent = true; };
    await mismatch.run(); assert.ok(!mismatch.frames.some(frame => frame.type === "model")); assert.notEqual(result(mismatch.frames).outcome, "passed"); assert.ok(!mismatch.calls.includes("verify"));
    assert.ok(!JSON.stringify(mismatch.frames).includes("astra"));
  }
});
test("provider failures map to quota, authentication and generic provider codes", async () => {
  for (const [category, code] of [["quota", "quota_exhausted"], ["auth_required", "auth_required"], ["session_expired", "auth_required"], ["network", "provider_failed"], ["protocol", "provider_failed"], ["process", "provider_failed"], ["unsupported", "provider_failed"], ["deadline", "deadline_exceeded"]] as const) {
    const f = fixture(); f.deps.provider = async () => { throw new ProviderFailure(category); }; await f.run();
    assert.equal(result(f.frames).error_code, code, category); assert.equal(result(f.frames).outcome, "failed"); assert.equal(result(f.frames).cleanup, "verified"); assert.equal(result(f.frames).result, null); supervise(f.boot, f.frames);
  }
  const unknown = fixture(); unknown.deps.provider = async () => { throw new Error("PRIVATE_PROVIDER_TEXT sk-abcdefghijklmnopqrstuvwxyz"); }; await unknown.run();
  assert.equal(result(unknown.frames).error_code, "worker_failed"); assert.ok(!JSON.stringify(unknown.frames).includes("PRIVATE"));
});
test("tool calls are monotonic and bounded; exceeding sixteen is a tool limit", async () => {
  const f = fixture(); f.deps.provider = async turn => {
    turn.observer.model(taskRunObservedModels.codex[0]);
    for (const count of [1, 2, 2, 1, 3, ...Array.from({length: 13}, (_, index) => 4 + index)]) turn.observer.toolCall(count);
    turn.trace.quiescent = true;
  };
  await f.run();
  const counts = f.frames.filter(frame => frame.type === "activity").map(frame => (frame as {tool_calls: number}).tool_calls);
  assert.deepEqual(counts, Array.from({length: 16}, (_, index) => index + 1)); assert.equal(Math.max(...counts), taskRunMaxToolCalls);
  assert.equal(supervise(f.boot, f.frames).operation?.tool_calls, 16); assert.equal(result(f.frames).outcome, "passed");
  for (const mode of ["session", "observer"] as const) {
    const limited = fixture(); limited.deps.provider = async turn => {
      turn.observer.model(taskRunObservedModels.codex[0]); for (let count = 1; count <= 16; count++) turn.observer.toolCall(count);
      if (mode === "session") throw new TaskToolLimitError(); turn.observer.toolCall(17);
    };
    await limited.run();
    assert.deepEqual(result(limited.frames), {type: "result", outcome: "failed", error_code: "tool_limit", cleanup: "verified", result: null});
    assert.ok(limited.frames.every(frame => frame.type !== "activity" || frame.tool_calls <= 16)); assert.ok(!limited.calls.includes("verify")); supervise(limited.boot, limited.frames);
  }
});
test("a run without any model activity or tool call cannot pass", async () => {
  for (const mode of ["no-tool", "no-model"] as const) {
    const f = fixture(); f.deps.provider = async turn => { if (mode === "no-tool") turn.observer.model(taskRunObservedModels.codex[0]); else turn.observer.toolCall(1); turn.trace.quiescent = true; };
    await f.run(); assert.equal(result(f.frames).error_code, "provider_failed"); assert.ok(!f.calls.includes("verify")); supervise(f.boot, f.frames);
  }
});
test("verifier rejection is a rejected result without a patch, with verified cleanup", async () => {
  const f = fixture(); f.deps.verify = async source => ({passed: false, cases: 34, json_cases_passed: true, sparse_cases_passed: false, candidate_sha256: sha256(source)});
  await f.run();
  assert.deepEqual(result(f.frames), {type: "result", outcome: "rejected", error_code: "candidate_rejected", cleanup: "verified",
    result: {verifier: {passed: false, cases: 34, json_cases_passed: true, sparse_cases_passed: false}, candidate_sha256: sha256(correct), patch_sha256: null, patch: null}});
  assert.equal(supervise(f.boot, f.frames).operation?.outcome, "rejected");
});
test("candidate, snapshot and verifier failures use their own closed codes", async () => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void, string]> = [
    ["snapshot policy", f => { f.deps.snapshot = async () => { throw new Error("candidate_secret_content"); }; }, "candidate_invalid"],
    ["snapshot exporter", f => { f.deps.snapshot = async () => { throw new Error("candidate_snapshot_rejected"); }; }, "candidate_invalid"],
    ["snapshot docker", f => { f.deps.snapshot = async () => { throw new Error("PRIVATE_DOCKER"); }; }, "worker_failed"],
    ["verifier docker", f => { f.deps.verify = async () => { throw new Error("PRIVATE_DOCKER"); }; }, "verifier_failed"],
    ["verifier hash", f => { f.deps.verify = async () => ({passed: true, cases: 34, json_cases_passed: true, sparse_cases_passed: true, candidate_sha256: "0".repeat(64)}); }, "verifier_failed"],
    ["unpatchable CRLF", f => { f.deps.snapshot = async () => correct.replaceAll("\n", "\r\n"); }, "candidate_invalid"],
    ["unchanged baseline", f => { f.deps.snapshot = async () => controlledBaseline; }, "candidate_invalid"],
    ["oversize frame", f => { f.deps.snapshot = async () => Array.from({length: 2000}, (_, index) => `const v${index} = "\\\\\\\\\\\\\\\\";`).join("\n") + "\n" + correct; }, "candidate_invalid"],
  ];
  for (const [label, arrange, code] of cases) {
    const f = fixture(); arrange(f); await f.run();
    assert.equal(result(f.frames).error_code, code, label); assert.equal(result(f.frames).outcome, "failed", label); assert.equal(result(f.frames).result, null, label); assert.equal(result(f.frames).cleanup, "verified", label);
    assert.ok(!JSON.stringify(f.frames).includes("PRIVATE")); supervise(f.boot, f.frames);
  }
});
test("cancellation at every phase reports cancelled with verified cleanup and no result", async () => {
  type Arrange = (f: ReturnType<typeof fixture>, controller: AbortController) => void;
  const phases: Array<[string, Arrange, string[]]> = [
    ["preparing", (f, c) => { f.deps.prerequisite = async () => { c.abort("cancelled"); }; }, ["preparing", "cleaning", "result"]],
    ["starting runtime", (f, c) => { f.runtime.start = async () => { c.abort("cancelled"); throw new Error("PRIVATE_ABORT"); }; }, ["preparing", "cleaning", "result"]],
    ["running", (f, c) => { f.deps.provider = async turn => { turn.observer.model("gpt-6-luna"); turn.observer.toolCall(1); c.abort("cancelled"); throw new ProviderFailure("canceled"); }; }, ["preparing", "running", "model", "activity", "cleaning", "result"]],
    ["verifying", (f, c) => { f.deps.verify = async () => { c.abort("cancelled"); throw new Error("PRIVATE_ABORT"); }; }, ["preparing", "running", "model", "activity", "activity", "verifying", "cleaning", "result"]],
    ["after verification", (f, c) => { const original = f.deps.verify; f.deps.verify = async (...args) => { const verdict = await original(...args); c.abort("cancelled"); return verdict; }; }, ["preparing", "running", "model", "activity", "activity", "verifying", "cleaning", "result"]],
    ["cleaning", (f, c) => { f.runtime.stop = async () => { c.abort("cancelled"); }; }, ["preparing", "running", "model", "activity", "activity", "verifying", "cleaning", "result"]],
  ];
  for (const [label, arrange, sequence] of phases) {
    const controller = new AbortController(), f = fixture(); arrange(f, controller); await f.run(controller.signal);
    assert.deepEqual(types(f.frames), sequence, label);
    assert.deepEqual(result(f.frames), {type: "result", outcome: "cancelled", error_code: "cancelled", cleanup: "verified", result: null}, label);
    assert.ok(!JSON.stringify(f.frames).includes("PRIVATE")); supervise(f.boot, f.frames);
    if (f.calls.includes("restore") && label !== "cleaning") assert.deepEqual(f.calls.slice(f.calls.includes("retain") ? -3 : -2), f.calls.includes("retain") ? ["stop", "release", "finish"] : ["stop", "finish"], label);
  }
  const deadline = new AbortController(), f = fixture(); f.deps.provider = async () => { deadline.abort("deadline_exceeded"); throw new ProviderFailure("canceled"); };
  await f.run(deadline.signal); assert.deepEqual(result(f.frames), {type: "result", outcome: "failed", error_code: "deadline_exceeded", cleanup: "verified", result: null}); supervise(f.boot, f.frames);
  const early = new AbortController(); early.abort("cancelled"); const immediate = fixture(); await immediate.run(early.signal);
  assert.deepEqual(immediate.calls, []); assert.equal(result(immediate.frames).outcome, "cancelled");
});
test("any cleanup that cannot be verified becomes needs_review with unknown cleanup, never success", async () => {
  type Arrange = (f: ReturnType<typeof fixture>, controller: AbortController) => void;
  const faults: Array<[string, Arrange, string[]]> = [
    ["stop", f => { f.runtime.stop = async () => { throw new Error("PRIVATE_CLEANUP"); }; }, ["release", "finish"]],
    ["finish", f => { f.runtime.finishOperation = async () => { throw new Error("PRIVATE_CLEANUP"); }; }, ["stop", "release"]],
    ["sandbox", f => { f.sandbox.close = async () => { throw new Error("PRIVATE_CLEANUP"); }; }, ["stop", "release"]],
    ["pending callbacks", f => { const original = f.deps.provider; f.deps.provider = async turn => { await original(turn); turn.trace.quiescent = false; }; }, ["stop", "release"]],
    ["cancel and stop", (f, c) => { f.runtime.stop = async () => { c.abort("cancelled"); throw new Error("PRIVATE_CLEANUP"); }; }, ["release", "finish"]],
    ["rejected and stop", f => { f.deps.verify = async source => ({passed: false, cases: 34, json_cases_passed: false, sparse_cases_passed: false, candidate_sha256: sha256(source)}); f.runtime.stop = async () => { throw new Error("PRIVATE_CLEANUP"); }; }, ["release", "finish"]],
  ];
  for (const [label, arrange, tail] of faults) {
    const controller = new AbortController(), f = fixture(); arrange(f, controller); await f.run(controller.signal);
    assert.deepEqual(result(f.frames), {type: "result", outcome: "needs_review", error_code: "cleanup_failed", cleanup: "unknown", result: null}, label);
    assert.deepEqual(f.calls.slice(-tail.length), tail.map(call => call === "stop" || call === "release" || call === "finish" ? call : call), label);
    assert.ok(!JSON.stringify(f.frames).includes("PRIVATE")); supervise(f.boot, f.frames);
  }
  // Provider failure with unverifiable cleanup keeps its cause but is still a review state.
  const f = fixture(); f.deps.provider = async () => { throw new ProviderFailure("quota"); }; f.runtime.stop = async () => { throw new Error("x"); }; await f.run();
  assert.deepEqual(result(f.frames), {type: "result", outcome: "needs_review", error_code: "cleanup_failed", cleanup: "unknown", result: null});
  const created = fixture(); created.deps.sandbox = async () => { throw new AggregateError([new Error("PRIVATE")], "sandbox_cleanup_failed"); }; await created.run();
  assert.deepEqual(result(created.frames), {type: "result", outcome: "needs_review", error_code: "cleanup_failed", cleanup: "unknown", result: null});
  assert.ok(created.calls.includes("stop")); assert.ok(created.calls.includes("release"));
  assert.ok(!created.calls.includes("finish"), "an unreturned sandbox with uncertain cleanup retains the persistent claim");
});
test("independent cleanup uncertainty preserves the profile claim even when cancelled or timed out", async () => {
  for (const scope of ["snapshot", "verifier"] as const) for (const abort of [null, "cancelled", "deadline_exceeded"] as const) {
    const f = fixture(), controller = new AbortController();
    const fail = async () => {
      if (abort) controller.abort(abort);
      throw new ControlledTaskCleanupError(scope, [new Error("PRIVATE_INDEPENDENT_RESOURCE")]);
    };
    if (scope === "snapshot") f.deps.snapshot = fail; else f.deps.verify = fail;
    await f.run(controller.signal);
    assert.deepEqual(result(f.frames), {type: "result", outcome: "needs_review", error_code: "cleanup_failed", cleanup: "unknown", result: null}, `${scope}: ${abort}`);
    assert.ok(f.calls.includes("sandbox-close"));
    assert.deepEqual(f.calls.slice(-2), ["stop", "release"]);
    assert.ok(!f.calls.includes("finish"), "claim must remain while independent resources may exist");
    assert.ok(!JSON.stringify(f.frames).includes("PRIVATE"));
    supervise(f.boot, f.frames);
  }
});

test("cleanup-looking error text alone cannot mark an independent resource leak", async () => {
  for (const scope of ["snapshot", "verifier"] as const) for (const failure of [
    new Error(`controlled_${scope}_cleanup_failed`),
    new AggregateError([new Error("PRIVATE")], `controlled_${scope}_cleanup_failed`),
    Object.assign(new Error("PRIVATE"), {scope}),
  ]) {
    const f = fixture(), fail = async () => { throw failure; };
    if (scope === "snapshot") f.deps.snapshot = fail; else f.deps.verify = fail;
    await f.run();
    assert.deepEqual(result(f.frames), {type: "result", outcome: "failed", error_code: scope === "snapshot" ? "worker_failed" : "verifier_failed", cleanup: "verified", result: null});
    assert.equal(f.calls.at(-1), "finish");
    supervise(f.boot, f.frames);
  }
});

test("unhealthy relay never passes", async () => {
  for (const when of ["before", "after"] as const) {
    const f = fixture();
    if (when === "before") f.deps.bridge = async () => ({stats: {control_failure: true, task_calls: 0}, close() {}});
    else f.deps.provider = async turn => { turn.observer.model("gpt-6-luna"); turn.observer.toolCall(1); (f.stats as any).control_failure = true; turn.trace.quiescent = true; };
    await f.run(); assert.notEqual(result(f.frames).outcome, "passed"); assert.ok(!f.calls.includes("verify"));
  }
});
test("no frame carries prompts, provider text, source outside the patch, paths or account identifiers", async () => {
  for (const provider of ["codex", "claude"] as const) {
    const f = fixture({provider}); await f.run();
    const text = JSON.stringify(f.frames.filter(frame => frame.type !== "result")); const all = JSON.stringify(f.frames);
    for (const secret of [f.owner, f.boot.assets_root, f.boot.journal_root, f.boot.profile_registry_root, path.basename(f.boot.assets_root), "Fix /task/sum.mjs", "task_exec", "/opt/cg", "catalog", "docker", f.boot.profile_id, f.boot.request_id])
      assert.ok(!all.includes(secret), `leaks ${secret}`);
    assert.ok(!text.includes("export function"));
    for (const frame of f.frames) assert.deepEqual(Object.keys(frame).sort(), frame.type === "result" ? ["cleanup", "error_code", "outcome", "result", "type"] : frame.type === "progress" ? ["phase", "type"] : frame.type === "model" ? ["observed", "type"] : ["tool_calls", "type"]);
  }
  const failing = fixture(); failing.deps.provider = async () => { throw Object.assign(new Error("PRIVATE_PROMPT_TEXT /home/PRIVATE_USER/.codex/auth.json"), {cause: "PRIVATE"}); }; await failing.run();
  assert.ok(!JSON.stringify(failing.frames).includes("PRIVATE"));
});
test("late provider callbacks after the running phase never produce model or activity frames", async () => {
  let late: ProviderTurnOptions["observer"] | undefined;
  const f = fixture(); const original = f.deps.provider;
  f.deps.provider = async turn => { late = turn.observer; await original(turn); };
  f.runtime.stop = async () => { late!.toolCall(3); late!.model("gpt-6-luna"); };
  await f.run(); supervise(f.boot, f.frames);
  assert.deepEqual(f.frames.filter(frame => frame.type === "activity").length, 2);
  const early = fixture(); early.deps.provider = async turn => { turn.observer.toolCall(1); throw new ProviderFailure("protocol"); };
  await early.run(); assert.ok(early.frames.some(frame => frame.type === "activity")); supervise(early.boot, early.frames);
});
test("frame sequences obey the supervisor rules on happy, failure and cancel paths", async () => {
  const runs: Array<(f: ReturnType<typeof fixture>, c: AbortController) => void> = [
    () => {}, f => { f.deps.provider = async () => { throw new ProviderFailure("quota"); }; }, f => { f.deps.verify = async s => ({passed: false, cases: 34, json_cases_passed: false, sparse_cases_passed: false, candidate_sha256: sha256(s)}); },
    (f, c) => { f.deps.provider = async turn => { turn.observer.model("gpt-6-luna"); c.abort("cancelled"); throw new ProviderFailure("canceled"); }; }, (f, c) => { f.deps.assets = async () => { c.abort("cancelled"); throw new Error("x"); }; },
    f => { f.runtime.finishOperation = async () => { throw new Error("x"); }; }, f => { f.deps.snapshot = async () => { throw new Error("candidate_unsafe_content"); }; },
  ];
  for (const provider of ["codex", "claude"] as const) for (const arrange of runs) {
    const controller = new AbortController(), f = fixture({provider}); arrange(f, controller); await f.run(controller.signal); supervise(f.boot, f.frames);
  }
});
test("exactly one result frame is emitted and it is last, even when the sink is faulty after it", async () => {
  for (const arrange of [(f: ReturnType<typeof fixture>) => { f.deps.provider = async () => { throw new ProviderFailure("quota"); }; }, () => {}]) {
    const f = fixture(); arrange(f); await f.run(); assert.equal(f.frames.filter(frame => frame.type === "result").length, 1); assert.equal(f.frames.at(-1)?.type, "result");
  }
});
test("verifyAssets accepts the optional catalog only with the exact pin and checks it before the provider binary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cg-task-assets-"));
  const boot: Boot = {type: "boot", schema_version: "1.0", request_id: randomUUID(), provider: "codex", journal_root: path.resolve("j"), assets_root: directory};
  const binaries = Object.fromEntries(Object.entries(pins.binaries).map(([id, pin]) => [id, {file: pin.file, sha256: pin.sha256}]));
  const config = (catalog?: unknown) => JSON.stringify({schema_version: "1.0", base_image: pins.base_image, binaries, bridges: {}, ...(catalog === undefined ? {} : {catalog})});
  const reason = (work: Promise<unknown>) => work.then(() => "accepted", error => (error as Error).message);
  try {
    for (const catalog of [undefined, null]) { await writeFile(path.join(directory, "config.json"), config(catalog)); assert.equal(await reason(verifyAssets(boot, {})), "asset_missing"); }
    const pin = {file: pins.codex_catalog.file, sha256: pins.codex_catalog.sha256};
    await writeFile(path.join(directory, "config.json"), config(pin));
    assert.equal(await reason(verifyAssets(boot, {})), "asset_missing", "listed catalog file must exist");
    await writeFile(path.join(directory, pin.file), "tampered catalog");
    assert.equal(await reason(verifyAssets(boot, {})), "asset_invalid", "catalog digest is pinned before the binary is read");
    for (const bad of [{...pin, sha256: "0".repeat(64)}, {...pin, file: "other.json"}, {...pin, extra: true}, "catalog", []]) {
      await writeFile(path.join(directory, "config.json"), config(bad)); assert.equal(await reason(verifyAssets(boot, {})), "asset_invalid");
    }
  } finally { await rm(directory, {recursive: true, force: true}); }
});
test("worker entry dispatches task runs and keeps stdout framed for an unbound profile", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cg-task-entry-"));
  try {
    const input = {...bootFor("codex"), profile_registry_root: path.join(directory, "managed-profiles")};
    const run = async (message: unknown) => {
      const child = spawn(process.execPath, ["--import", "tsx", path.resolve("apps/desktop/native-worker/entry.ts")], {windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
      let stdout = "", stderr = "";
      child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
      child.stdin.on("error", () => {}); child.stdin.write(JSON.stringify(message) + "\n");
      const exit = await new Promise<number | null>((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error("fixture_worker_deadline")); }, 15_000); child.on("error", reject); child.on("close", code => { clearTimeout(timer); resolve(code); }); });
      return {exit, stdout, stderr};
    };
    const ok = await run(input);
    assert.equal(ok.exit, 0); assert.equal(ok.stderr, "");
    const frames = ok.stdout.trim().split("\n").map(line => JSON.parse(line)) as TaskRunFrame[];
    assert.deepEqual(types(frames), ["preparing", "cleaning", "result"]);
    assert.deepEqual(result(frames), {type: "result", outcome: "failed", error_code: "profile_unbound", cleanup: "verified", result: null});
    await mkdir(directory, {recursive: true});
    const rejected = await run({...input, prompt: "free text"});
    assert.equal(rejected.exit, 1); assert.equal(rejected.stdout, "");
  } finally { await rm(directory, {recursive: true, force: true}); }
});
