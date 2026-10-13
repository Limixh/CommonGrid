import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptTaskRunUpdate, taskRunCatalogPins, taskRunControlledTaskId, taskRunObservedModels, taskRunPatchHeader, taskRunPatchPaths,
  taskRunRequestedModels, taskRunTaskIds, unavailableTaskRun, validTaskRunPatch, validateTaskRunCancel, validateTaskRunResult,
  validateTaskRunStart, validateTaskRunStatus, type TaskRunOperation, type TaskRunStatus,
} from "../src/task-run-protocol.ts";
import { claudeFunctionalTestModel, claudeFunctionalTestObservedModels, codexFunctionalTestModel } from "../testing/functional-test-models.ts";

const request = "10000000-0000-4000-8000-000000000001", profile = "20000000-0000-4000-8000-000000000002";
const hash = "a".repeat(64), patchHash = "b".repeat(64);
const patch = "diff --git a/sum.mjs b/sum.mjs\nindex 0000000..1111111 100644\n--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1,2 @@\n-old\n+new\n+line\n";
const operation = (changes: Partial<TaskRunOperation> = {}): TaskRunOperation => ({
  request_id: request, profile_id: profile, provider: "codex", task_id: "controlled-sum-integers-v1", revision: 0,
  phase: "starting", outcome: null, error_code: null, cleanup: "pending", tool_calls: 0, model: {requested: "gpt-6-luna", observed: null}, result: null, ...changes,
});
const status = (changes: Partial<TaskRunOperation> = {}): TaskRunStatus => ({schema_version: "1.0", availability: "available", operation: operation(changes)});
const verified = {verifier: {passed: true, cases: 34, json_cases_passed: true, sparse_cases_passed: true}, candidate_sha256: hash, patch_sha256: patchHash, patch};
const passed = (changes: Partial<TaskRunOperation> = {}) => status({phase: "finished", revision: 9, outcome: "passed", cleanup: "verified", tool_calls: 3,
  model: {requested: "gpt-6-luna", observed: "gpt-6-luna"}, result: verified, ...changes});

test("browser-safe model pins match the functional-test model policy", () => {
  assert.equal(taskRunRequestedModels.codex, codexFunctionalTestModel);
  assert.equal(taskRunRequestedModels.claude, claudeFunctionalTestModel);
  assert.deepEqual([...taskRunObservedModels.codex], [codexFunctionalTestModel]);
  assert.deepEqual([...taskRunObservedModels.claude], [...claudeFunctionalTestObservedModels]);
});

test("start grants only an explicitly approved controlled task; cancel is revision scoped", () => {
  const start = {schema_version: "1.0", request_id: request, profile_id: profile, task_id: "controlled-sum-integers-v1", approved: true};
  assert.deepEqual(validateTaskRunStart(start), start);
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
const software = (changes: Partial<TaskRunOperation> = {}) => passed({task_id: "software-bounds", result: softwareVerified, ...changes});

test("each task has its own patch path, header and verifier checks", () => {
  assert.deepEqual({...taskRunPatchPaths}, {"controlled-sum-integers-v1": "sum.mjs", "software-bounds": "src/search.ts"});
  assert.equal(taskRunPatchHeader("software-bounds"), "diff --git a/src/search.ts b/src/search.ts\n");
  assert.deepEqual(taskRunTaskIds.map(id => taskRunControlledTaskId === id), [true, false]);
  assert.ok(validTaskRunPatch(softwarePatch, "software-bounds") && !validTaskRunPatch(softwarePatch, "controlled-sum-integers-v1"));
  assert.ok(validTaskRunPatch(patch) && !validTaskRunPatch(patch, "software-bounds"));
  assert.ok(taskRunCatalogPins["software-bounds"] && /^[0-9a-f]{64}$/.test(taskRunCatalogPins["software-bounds"].contract_hash));
  assert.equal(taskRunCatalogPins["controlled-sum-integers-v1"], undefined);
  assert.deepEqual(validateTaskRunStart({schema_version: "1.0", request_id: request, profile_id: profile, task_id: "software-bounds", approved: true}).task_id, "software-bounds");
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
  assert.throws(() => acceptTaskRunUpdate(running, status({task_id: "software-bounds", phase: "running", revision: 4, tool_calls: 2, model: running.operation!.model})), /stale/);
});
