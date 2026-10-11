import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptTaskRunUpdate, taskRunObservedModels, taskRunRequestedModels, unavailableTaskRun, validateTaskRunCancel,
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
