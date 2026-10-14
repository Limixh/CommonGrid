import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptTaskRunUpdate, taskRunCatalogPins, taskRunControlledTaskId, taskRunObservedModels, taskRunPatchHeader, taskRunPatchPaths,
  taskRunRequestedModels, taskRunStrategyIds, taskRunTaskIds, taskRunVerifierChecks, unavailableTaskRun, validTaskRunStrategy, validTaskRunPatch, validateTaskRunCancel, validateTaskRunResult,
  validateTaskRunStart, validateTaskRunStatus, type TaskRunOperation, type TaskRunStatus,
  validateTaskRunResultPackage, validateTaskRunResultPackageRequest, sameTaskRunLeaseContext,
} from "../src/task-run-protocol.ts";
import { claudeFunctionalTestModel, claudeFunctionalTestObservedModels, codexFunctionalTestModel } from "../testing/functional-test-models.ts";

const request = "10000000-0000-4000-8000-000000000001", profile = "20000000-0000-4000-8000-000000000002";
const hash = "a".repeat(64), patchHash = "b".repeat(64);
const patch = "diff --git a/sum.mjs b/sum.mjs\nindex 0000000..1111111 100644\n--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1,2 @@\n-old\n+new\n+line\n";
const operation = (changes: Partial<TaskRunOperation> = {}): TaskRunOperation => ({
  request_id: request, profile_id: profile, provider: "codex", task_id: "controlled-sum-integers-v1", strategy_id: null, revision: 0,
  phase: "starting", outcome: null, error_code: null, cleanup: "pending", tool_calls: 0, model: {requested: "gpt-6-luna", observed: null}, result: null, ...changes,
});
const status = (changes: Partial<TaskRunOperation> = {}): TaskRunStatus => ({schema_version: "1.0", availability: "available", operation: operation(changes)});
const verified = {verifier: {passed: true, cases: 34, json_cases_passed: true, sparse_cases_passed: true}, candidate_sha256: hash, patch_sha256: patchHash, patch};
const passed = (changes: Partial<TaskRunOperation> = {}) => status({phase: "finished", revision: 9, outcome: "passed", cleanup: "verified", tool_calls: 3,
  model: {requested: "gpt-6-luna", observed: "gpt-6-luna"}, result: verified, ...changes});

test("leased starts pin the task, strategy, base and immutable bounded deadline", () => {
  const lease = {lease_id: "lease-1", attempt_id: "attempt-1", task_version: 1,
    contract_hash: taskRunCatalogPins["software-bounds"]!.contract_hash, base_commit: "7a06a3ea1880fec11033104223474b8f297cab6c",
    strategy_id: "invariant", time_limit_sec: 120, expires_at_ms: 1_800_000_000_000};
  const start = {schema_version: "1.0", request_id: request, profile_id: profile, task_id: "software-bounds", strategy_id: "invariant", approved: true, lease_context: lease};
  assert.deepEqual(validateTaskRunStart(start), start);
  for (const changes of [{lease_id: "../lease"}, {attempt_id: ""}, {task_version: 2}, {contract_hash: hash}, {base_commit: "0".repeat(40)},
    {strategy_id: "boundary-first"}, {time_limit_sec: 0}, {time_limit_sec: 1201}, {expires_at_ms: 0}, {expires_at_ms: 1.2}, {token: "secret"}])
    assert.throws(() => validateTaskRunStart({...start, lease_context: {...lease, ...changes}}), /contract_invalid/);
  for (const lease_context of [null, undefined, []]) assert.throws(() => validateTaskRunStart({...start, lease_context}), /contract_invalid/);
  assert.throws(() => validateTaskRunStart({...start, task_id: "controlled-sum-integers-v1", strategy_id: null}), /contract_invalid/);
  const before = status({task_id: "software-bounds", strategy_id: "invariant", lease_context: lease});
  const reordered = Object.fromEntries(Object.entries(lease).reverse()) as typeof lease;
  assert.ok(sameTaskRunLeaseContext(lease, reordered));
  assert.ok(acceptTaskRunUpdate(before, status({task_id: "software-bounds", strategy_id: "invariant", lease_context: reordered, phase: "preparing", revision: 1})));
  for (const changes of [{lease_id: "lease-2"}, {attempt_id: "attempt-2"}, {time_limit_sec: 121}, {expires_at_ms: lease.expires_at_ms + 1}])
    assert.throws(() => acceptTaskRunUpdate(before, status({task_id: "software-bounds", strategy_id: "invariant", lease_context: {...lease, ...changes}, phase: "preparing", revision: 1})), /stale/);
});

test("result package transport is identity scoped, bounded and canonical", () => {
  const value = {schema_version: "1.0", request_id: request, lease_id: "lease-1", sha256: hash, size_bytes: 1, bytes_base64: "YQ=="};
  assert.deepEqual(validateTaskRunResultPackage(value), value);
  for (const changes of [{request_id: "x"}, {lease_id: "../x"}, {sha256: "X".repeat(64)}, {size_bytes: 0}, {size_bytes: 16385},
    {bytes_base64: "YR=="}, {bytes_base64: "YQ"}, {bytes_base64: "YQ==\n"}, {size_bytes: 3}, {private: "secret"}])
    assert.throws(() => validateTaskRunResultPackage({...value, ...changes}), /contract_invalid/);
  assert.ok(validateTaskRunResultPackageRequest({schema_version: "1.0", request_id: request, expected_revision: 9}));
  assert.throws(() => validateTaskRunResultPackageRequest({schema_version: "1.0", request_id: request, expected_revision: -1}), /contract_invalid/);
});

test("browser-safe model pins match the functional-test model policy", () => {
  assert.equal(taskRunRequestedModels.codex, codexFunctionalTestModel);
  assert.equal(taskRunRequestedModels.claude, claudeFunctionalTestModel);
  assert.deepEqual([...taskRunObservedModels.codex], [codexFunctionalTestModel]);
  assert.deepEqual([...taskRunObservedModels.claude], [...claudeFunctionalTestObservedModels]);
});

test("start grants only an explicitly approved controlled task; cancel is revision scoped", () => {
  const start = {schema_version: "1.0", request_id: request, profile_id: profile, task_id: "controlled-sum-integers-v1", strategy_id: null, approved: true};
  assert.deepEqual(validateTaskRunStart(start), start);
  const {strategy_id: _omitted, ...withoutStrategy} = start;
  assert.throws(() => validateTaskRunStart(withoutStrategy), /contract_invalid/);
  for (const changes of [{approved: false}, {approved: "true"}, {task_id: "anything"}, {task_id: ["controlled-sum-integers-v1"]}, {request_id: "x"}, {schema_version: "2.0"}])
    assert.throws(() => validateTaskRunStart({...start, ...changes}), /contract_invalid/);
  for (const extra of [{prompt: "rm -rf"}, {model: "gpt-6"}, {provider: "claude"}, {workspace: "C:\\"}])
    assert.throws(() => validateTaskRunStart({...start, ...extra}), /contract_invalid/);
  assert.deepEqual(validateTaskRunCancel({schema_version: "1.0", request_id: request, expected_revision: 4}), {schema_version: "1.0", request_id: request, expected_revision: 4});
  for (const expected_revision of [-1, 1.5, 1_000_000_001, "1", null])
    assert.throws(() => validateTaskRunCancel({schema_version: "1.0", request_id: request, expected_revision}), /contract_invalid/);
});

test("observations reject private fields, expensive or unknown models and premature results", () => {
  assert.deepEqual(validateTaskRunStatus(unavailableTaskRun()), unavailableTaskRun());
  assert.deepEqual(validateTaskRunStatus(status()), status());
  assert.deepEqual(validateTaskRunStatus(status({phase: "running", revision: 3, tool_calls: 2, model: {requested: "gpt-6-luna", observed: "gpt-6-luna"}})).operation?.tool_calls, 2);
  assert.ok(validateTaskRunStatus(status({provider: "claude", model: {requested: "haiku", observed: "claude-haiku-4-5"}, phase: "running", revision: 2})));
  for (const value of [null, [], {...status(), account: {}}, {...unavailableTaskRun(), operation: operation()},
    {...status(), operation: {...operation(), email: "private@example.test"}},
    status({model: {requested: "gpt-6", observed: null}}), status({model: {requested: "gpt-6-luna", observed: "gpt-6"}, phase: "running"}),
    status({provider: "claude", model: {requested: "haiku", observed: "haiku"}, phase: "running"}),
    status({provider: "claude", model: {requested: "sonnet", observed: null}}),
    status({phase: "starting", tool_calls: 1}), status({phase: "running", tool_calls: 17}), status({phase: "running", tool_calls: 1.5}),
    status({phase: "verifying", result: verified}), status({phase: "running", cleanup: "verified"}), status({phase: "running", error_code: "cancelled"})])
    assert.throws(() => validateTaskRunStatus(value), /contract_invalid/);
});

test("terminal observations bind outcome, cleanup, verifier and patch", () => {
  assert.equal(validateTaskRunStatus(passed()).operation?.result?.patch, patch);
  const rejected = passed({outcome: "rejected", error_code: "candidate_rejected",
    result: {verifier: {passed: false, cases: 34, json_cases_passed: true, sparse_cases_passed: false}, candidate_sha256: hash, patch_sha256: null, patch: null}});
  assert.ok(validateTaskRunStatus(rejected));
  assert.ok(validateTaskRunStatus(status({phase: "finished", revision: 2, outcome: "cancelled", error_code: "cancelled", cleanup: "verified"})));
  assert.ok(validateTaskRunStatus(status({phase: "finished", revision: 2, outcome: "failed", error_code: "model_unavailable", cleanup: "verified"})));
  assert.ok(validateTaskRunStatus(status({phase: "finished", revision: 2, outcome: "needs_review", error_code: "cleanup_failed", cleanup: "unknown"})));
  for (const value of [
    passed({cleanup: "unknown"}), passed({error_code: "cancelled"}), passed({model: {requested: "gpt-6-luna", observed: null}}), passed({tool_calls: 0}),
    passed({result: {...verified, verifier: {...verified.verifier, passed: false}}}),
    passed({result: {...verified, verifier: {...verified.verifier, sparse_cases_passed: false}}}),
    passed({result: {...verified, patch: null}}), passed({result: {...verified, patch: "--- a/other\n"}}),
    passed({result: {...verified, patch: patch + "\u202e"}}), passed({result: {...verified, patch: patch.replace("\n", "\r\n")}}),
    passed({result: {...verified, patch: patch + "+".repeat(49_152)}}), passed({result: {...verified, candidate_sha256: "A".repeat(64)}}),
    passed({result: {...verified, private_path: "/home"}} as never), passed({result: null}),
    passed({outcome: "rejected", error_code: "candidate_rejected"}),
    status({phase: "finished", revision: 2, outcome: "failed", error_code: "cancelled", cleanup: "verified"}),
    status({phase: "finished", revision: 2, outcome: "cancelled", error_code: "worker_failed", cleanup: "verified"}),
    status({phase: "finished", revision: 2, outcome: "failed", error_code: "candidate_rejected", cleanup: "verified"}),
    status({phase: "finished", revision: 2, outcome: "failed", error_code: null, cleanup: "verified"}),
    status({phase: "finished", revision: 2, outcome: "failed", error_code: "worker_failed", cleanup: "unknown"}),
    status({phase: "finished", revision: 2, outcome: "needs_review", error_code: "worker_failed", cleanup: "verified"}),
    status({phase: "finished", revision: 2, outcome: "failed", error_code: "worker_failed", cleanup: "verified", result: verified})])
    assert.throws(() => validateTaskRunStatus(value), /contract_invalid/);
});

test("updates for one request only move forward", () => {
  const running = status({phase: "running", revision: 3, tool_calls: 2, model: {requested: "gpt-6-luna", observed: "gpt-6-luna"}});
  assert.deepEqual(acceptTaskRunUpdate(null, running), running);
  assert.deepEqual(acceptTaskRunUpdate(running, running), running);
  assert.ok(acceptTaskRunUpdate(running, passed()));
  for (const incoming of [status({phase: "preparing", revision: 4}), status({phase: "running", revision: 2, tool_calls: 2, model: running.operation!.model}),
    status({phase: "running", revision: 3, tool_calls: 3, model: running.operation!.model}), status({phase: "running", revision: 4, tool_calls: 1, model: running.operation!.model}),
    status({phase: "running", revision: 4, tool_calls: 2}), {...status({phase: "running", revision: 4}), operation: null},
    status({request_id: "30000000-0000-4000-8000-000000000003", phase: "running", revision: 9}), status({profile_id: "30000000-0000-4000-8000-000000000003", phase: "running", revision: 9})])
    assert.throws(() => acceptTaskRunUpdate(running, incoming), /stale|contract_invalid/);
  const done = passed();
  assert.throws(() => acceptTaskRunUpdate(done, passed({revision: 10})), /stale/);
  assert.equal(acceptTaskRunUpdate(done, status({request_id: "30000000-0000-4000-8000-000000000003"})).operation?.phase, "starting");
});

const softwarePatch = "diff --git a/src/search.ts b/src/search.ts\n--- a/src/search.ts\n+++ b/src/search.ts\n@@ -1 +1 @@\n-  let hi = values.length - 1;\n+  let hi = values.length;\n";
const softwareVerified = {verifier: {passed: true, cases: 40, visible_tests_passed: true, hidden_cases_passed: true}, candidate_sha256: hash, patch_sha256: patchHash, patch: softwarePatch};
const softwareRejected = {verifier: {passed: false, cases: 40, visible_tests_passed: true, hidden_cases_passed: false}, candidate_sha256: hash, patch_sha256: null, patch: null};
const software = (changes: Partial<TaskRunOperation> = {}) => passed({task_id: "software-bounds", strategy_id: "invariant", result: softwareVerified, ...changes});

test("each task has its own patch path, header and verifier checks", () => {
  assert.deepEqual({...taskRunPatchPaths}, {"controlled-sum-integers-v1": "sum.mjs", "software-bounds": "src/search.ts", "software-intervals": "src/intervals.ts"});
  assert.equal(taskRunPatchHeader("software-intervals"), "diff --git a/src/intervals.ts b/src/intervals.ts\n");
  assert.equal(taskRunPatchHeader("software-bounds"), "diff --git a/src/search.ts b/src/search.ts\n");
  assert.deepEqual(taskRunTaskIds.map(id => taskRunControlledTaskId === id), [true, false, false]);
  assert.ok(validTaskRunPatch(softwarePatch, "software-bounds") && !validTaskRunPatch(softwarePatch, "controlled-sum-integers-v1"));
  assert.ok(validTaskRunPatch(patch) && !validTaskRunPatch(patch, "software-bounds"));
  assert.ok(taskRunCatalogPins["software-bounds"] && /^[0-9a-f]{64}$/.test(taskRunCatalogPins["software-bounds"].contract_hash));
  assert.ok(taskRunCatalogPins["software-intervals"] && /^[0-9a-f]{64}$/.test(taskRunCatalogPins["software-intervals"].contract_hash));
  assert.notEqual(taskRunCatalogPins["software-intervals"]!.contract_hash, taskRunCatalogPins["software-bounds"]!.contract_hash);
  assert.notEqual(taskRunCatalogPins["software-intervals"]!.contract_hash, "0".repeat(64));
  assert.equal(taskRunCatalogPins["controlled-sum-integers-v1"], undefined);
  assert.deepEqual(validateTaskRunStart({schema_version: "1.0", request_id: request, profile_id: profile, task_id: "software-bounds", strategy_id: "invariant", approved: true}).task_id, "software-bounds");
});

test("software results are accepted for passed and rejected outcomes", () => {
  assert.equal(validateTaskRunStatus(software()).operation?.result?.patch, softwarePatch);
  assert.deepEqual(validateTaskRunResult(softwareVerified, "passed", "software-bounds"), softwareVerified);
  const rejected = software({outcome: "rejected", error_code: "candidate_rejected", result: softwareRejected});
  assert.deepEqual(validateTaskRunStatus(rejected).operation?.result, softwareRejected);
  assert.ok(validateTaskRunStatus(software({outcome: "rejected", error_code: "candidate_rejected", result: {...softwareRejected, verifier: {passed: false, cases: 40, visible_tests_passed: false, hidden_cases_passed: true}}})));
  for (const value of [
    software({result: {...softwareVerified, verifier: {...softwareVerified.verifier, passed: false}}}),
    software({result: {...softwareVerified, verifier: {...softwareVerified.verifier, hidden_cases_passed: false}}}),
    software({result: {...softwareVerified, verifier: {...softwareVerified.verifier, cases: 0}}}),
    software({result: {...softwareVerified, patch: null}}),
    software({outcome: "rejected", error_code: "candidate_rejected", result: softwareVerified}),
    software({outcome: "rejected", error_code: "candidate_rejected", result: {...softwareRejected, patch: softwarePatch}}),
  ]) assert.throws(() => validateTaskRunStatus(value), /contract_invalid/);
});

test("verifier fields and patch headers never cross between tasks", () => {
  // Controlled verifier fields on a software run, and the other way around.
  assert.throws(() => validateTaskRunStatus(software({result: verified})), /contract_invalid/);
  assert.throws(() => validateTaskRunStatus(passed({result: softwareVerified})), /contract_invalid/);
  assert.throws(() => validateTaskRunResult(verified, "passed", "software-bounds"), /contract_invalid/);
  assert.throws(() => validateTaskRunResult(softwareVerified, "passed", "controlled-sum-integers-v1"), /contract_invalid/);
  assert.throws(() => validateTaskRunResult(softwareRejected, "rejected", "controlled-sum-integers-v1"), /contract_invalid/);
  assert.throws(() => validateTaskRunResult({...softwareRejected, verifier: {passed: false, cases: 34, json_cases_passed: true, sparse_cases_passed: false}}, "rejected", "software-bounds"), /contract_invalid/);
  // A verifier mixing both vocabularies has too many fields for either task.
  const mixed = {...softwareVerified.verifier, json_cases_passed: true, sparse_cases_passed: true};
  for (const taskId of ["controlled-sum-integers-v1", "software-bounds"] as const)
    assert.throws(() => validateTaskRunResult({...softwareVerified, verifier: mixed}, "passed", taskId), /contract_invalid/);
  // Patch headers belong to the task's own writable file.
  assert.throws(() => validateTaskRunStatus(software({result: {...softwareVerified, patch}})), /contract_invalid/);
  assert.throws(() => validateTaskRunStatus(passed({result: {...verified, patch: softwarePatch}})), /contract_invalid/);
  assert.throws(() => validateTaskRunStatus(software({result: {...softwareVerified, patch: softwarePatch.replace("src/search.ts", "src/other.ts")}})), /contract_invalid/);
  assert.throws(() => validateTaskRunStatus(software({result: {...softwareVerified, patch: "--- a/src/search.ts\n" + softwarePatch}})), /contract_invalid/);
  assert.throws(() => validateTaskRunResult(verified, "failed" as never, "software-bounds"), /contract_invalid/);
  assert.throws(() => validateTaskRunResult(softwareVerified, "passed", "unknown-task" as never), /contract_invalid/);
});

test("same-revision equality ignores object key order and still detects real changes", () => {
  const running = status({phase: "running", revision: 3, tool_calls: 2, model: {requested: "gpt-6-luna", observed: "gpt-6-luna"}});
  const reordered = JSON.parse(JSON.stringify(running, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse()) : value)) as TaskRunStatus;
  assert.notDeepEqual(Object.keys(reordered.operation!), Object.keys(running.operation!));
  assert.deepEqual(acceptTaskRunUpdate(running, reordered), reordered);
  const done = software();
  const doneReordered = {...done, operation: {...Object.fromEntries(Object.entries(done.operation!).reverse()),
    result: {...Object.fromEntries(Object.entries(softwareVerified).reverse()), verifier: Object.fromEntries(Object.entries(softwareVerified.verifier).reverse())}}};
  assert.ok(acceptTaskRunUpdate(done, doneReordered));
  assert.throws(() => acceptTaskRunUpdate(done, software({result: {...softwareVerified, candidate_sha256: "c".repeat(64)}})), /stale/);
  assert.throws(() => acceptTaskRunUpdate(done, passed()), /stale/);
  assert.throws(() => acceptTaskRunUpdate(running, status({phase: "running", revision: 3, tool_calls: 3, model: running.operation!.model})), /stale/);
  // A request never changes its task.
  assert.throws(() => acceptTaskRunUpdate(running, status({task_id: "software-bounds", strategy_id: "invariant", phase: "running", revision: 4, tool_calls: 2, model: running.operation!.model})), /stale/);
});

test("strategy ids are fixed per task: null for the controlled task, the approved list for software-bounds", () => {
  assert.deepEqual(taskRunStrategyIds["controlled-sum-integers-v1"], []);
  assert.deepEqual(taskRunStrategyIds["software-bounds"], ["invariant", "boundary-first"]);
  for (const id of ["invariant", "boundary-first"]) assert.ok(validTaskRunStrategy("software-bounds", id));
  assert.ok(validTaskRunStrategy("controlled-sum-integers-v1", null));
  for (const value of [null, undefined, "", "Invariant", "unknown", 1, ["invariant"]]) assert.ok(!validTaskRunStrategy("software-bounds", value), String(value));
  for (const value of ["invariant", "", undefined, 0]) assert.ok(!validTaskRunStrategy("controlled-sum-integers-v1", value), String(value));
});

test("start and status carry exactly strategy_id in the allowed task combinations", () => {
  const start = (task_id: string, strategy_id: unknown) => ({schema_version: "1.0", request_id: request, profile_id: profile, task_id, strategy_id, approved: true});
  for (const id of ["invariant", "boundary-first"]) assert.deepEqual(validateTaskRunStart(start("software-bounds", id)), start("software-bounds", id));
  assert.deepEqual(validateTaskRunStart(start("controlled-sum-integers-v1", null)), start("controlled-sum-integers-v1", null));
  for (const value of [start("software-bounds", null), start("software-bounds", "unknown"), start("software-bounds", ""), start("software-bounds", undefined), start("software-bounds", ["invariant"]),
    start("controlled-sum-integers-v1", "invariant"), start("controlled-sum-integers-v1", ""), start("controlled-sum-integers-v1", undefined), {...start("software-bounds", "invariant"), instructions: "free text"}])
    assert.throws(() => validateTaskRunStart(value), /contract_invalid/);
  const {strategy_id: _omitted, ...missing} = software().operation!;
  assert.throws(() => validateTaskRunStatus({schema_version: "1.0", availability: "available", operation: missing}), /contract_invalid/);
  const operationKeys = Object.keys(software().operation!).sort();
  assert.deepEqual(operationKeys, ["cleanup", "error_code", "model", "outcome", "phase", "profile_id", "provider", "request_id", "result", "revision", "strategy_id", "task_id", "tool_calls"]);
  assert.equal(validateTaskRunStatus(software({strategy_id: "boundary-first"})).operation?.strategy_id, "boundary-first");
  assert.equal(validateTaskRunStatus(status()).operation?.strategy_id, null);
  assert.equal(validateTaskRunStatus(software({phase: "starting", revision: 0, outcome: null, cleanup: "pending", tool_calls: 0, model: {requested: "gpt-6-luna", observed: null}, result: null})).operation?.strategy_id, "invariant");
  for (const value of [software({strategy_id: null}), software({strategy_id: "unknown"}), software({strategy_id: "Invariant"}), passed({strategy_id: "invariant"}), passed({strategy_id: ""}),
    status({task_id: "software-bounds", phase: "running", revision: 2, strategy_id: null}), status({phase: "running", revision: 2, strategy_id: "boundary-first"})])
    assert.throws(() => validateTaskRunStatus(value), /contract_invalid/);
});

test("a request never changes its strategy; a later request may use another", () => {
  const model = {requested: "gpt-6-luna", observed: "gpt-6-luna"};
  const running = status({task_id: "software-bounds", strategy_id: "invariant", phase: "running", revision: 3, tool_calls: 2, model});
  assert.ok(acceptTaskRunUpdate(running, running));
  assert.ok(acceptTaskRunUpdate(running, software({strategy_id: "invariant", revision: 9})));
  assert.throws(() => acceptTaskRunUpdate(running, status({task_id: "software-bounds", strategy_id: "boundary-first", phase: "running", revision: 4, tool_calls: 2, model})), /stale/);
  assert.throws(() => acceptTaskRunUpdate(running, status({task_id: "software-bounds", strategy_id: "boundary-first", phase: "running", revision: 3, tool_calls: 2, model})), /stale/);
  assert.throws(() => acceptTaskRunUpdate(running, software({strategy_id: "boundary-first", revision: 9})), /stale/);
  const done = software();
  assert.throws(() => acceptTaskRunUpdate(done, software({strategy_id: "boundary-first"})), /stale/);
  assert.throws(() => acceptTaskRunUpdate(done, software({strategy_id: "boundary-first", revision: 10})), /stale/);
  const next = status({request_id: "30000000-0000-4000-8000-000000000003", task_id: "software-bounds", strategy_id: "boundary-first"});
  assert.equal(acceptTaskRunUpdate(done, next).operation?.strategy_id, "boundary-first");
});

const intervalsPatch = "diff --git a/src/intervals.ts b/src/intervals.ts\n--- a/src/intervals.ts\n+++ b/src/intervals.ts\n@@ -1 +1 @@\n-  sorted.sort();\n+  sorted.sort((a, b) => a[0] - b[0]);\n";
const intervalsVerified = {...softwareVerified, patch: intervalsPatch};
const intervals = (changes: Partial<TaskRunOperation> = {}) => passed({task_id: "software-intervals", strategy_id: "sort-first", result: intervalsVerified, ...changes});

test("software-intervals has its own patch header and the software verifier checks", () => {
  assert.ok(validTaskRunPatch(intervalsPatch, "software-intervals") && !validTaskRunPatch(intervalsPatch, "software-bounds") && !validTaskRunPatch(intervalsPatch));
  assert.ok(!validTaskRunPatch(softwarePatch, "software-intervals"));
  assert.deepEqual(taskRunVerifierChecks["software-intervals"], ["visible_tests_passed", "hidden_cases_passed"]);
  assert.equal(validateTaskRunStatus(intervals()).operation?.result?.patch, intervalsPatch);
  assert.deepEqual(validateTaskRunResult(intervalsVerified, "passed", "software-intervals"), intervalsVerified);
  assert.deepEqual(validateTaskRunStatus(intervals({outcome: "rejected", error_code: "candidate_rejected", result: softwareRejected})).operation?.result, softwareRejected);
  // The patch must name this task's writable file, and the other task's patch is refused.
  for (const bad of [intervals({result: {...intervalsVerified, patch: softwarePatch}}), intervals({result: {...intervalsVerified, patch: intervalsVerified.patch.replace("src/intervals.ts", "src/other.ts")}}),
    intervals({result: {...intervalsVerified, patch: null}}), intervals({result: verified}), software({result: intervalsVerified})]) assert.throws(() => validateTaskRunStatus(bad), /contract_invalid/);
  assert.throws(() => validateTaskRunResult(verified, "passed", "software-intervals"), /contract_invalid/);
});
test("software-intervals strategy ids are sort-first and sweep, never the bounds ids", () => {
  assert.deepEqual(taskRunStrategyIds["software-intervals"], ["sort-first", "sweep"]);
  for (const id of ["sort-first", "sweep"]) assert.ok(validTaskRunStrategy("software-intervals", id));
  for (const value of [null, undefined, "", "Sweep", "invariant", "boundary-first", "unknown", 1, ["sweep"]]) assert.ok(!validTaskRunStrategy("software-intervals", value), String(value));
  for (const id of ["sort-first", "sweep"]) assert.ok(!validTaskRunStrategy("software-bounds", id) && !validTaskRunStrategy("controlled-sum-integers-v1", id));
  const start = (task_id: string, strategy_id: unknown) => ({schema_version: "1.0", request_id: request, profile_id: profile, task_id, strategy_id, approved: true});
  for (const id of ["sort-first", "sweep"]) assert.deepEqual(validateTaskRunStart(start("software-intervals", id)), start("software-intervals", id));
  for (const value of [start("software-intervals", null), start("software-intervals", "invariant"), start("software-intervals", ""), start("software-bounds", "sweep"), start("controlled-sum-integers-v1", "sort-first")])
    assert.throws(() => validateTaskRunStart(value), /contract_invalid/);
  assert.equal(validateTaskRunStatus(intervals({strategy_id: "sweep"})).operation?.strategy_id, "sweep");
  for (const value of [intervals({strategy_id: null}), intervals({strategy_id: "invariant"}), software({strategy_id: "sweep"})]) assert.throws(() => validateTaskRunStatus(value), /contract_invalid/);
  // A request never changes its strategy, and never its task.
  const running = status({task_id: "software-intervals", strategy_id: "sort-first", phase: "running", revision: 3, tool_calls: 2, model: {requested: "gpt-6-luna", observed: "gpt-6-luna"}});
  assert.ok(acceptTaskRunUpdate(running, intervals({strategy_id: "sort-first", revision: 9})));
  assert.throws(() => acceptTaskRunUpdate(running, intervals({strategy_id: "sweep", revision: 9})), /stale/);
  assert.throws(() => acceptTaskRunUpdate(running, software({strategy_id: "invariant", revision: 9})), /stale/);
});
