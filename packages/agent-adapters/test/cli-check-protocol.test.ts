import test from "node:test";
import assert from "node:assert/strict";
import { acceptCliCheckUpdate, validateCliCheckStart, validateCliCheckCancel, validateCliCheckStatus, unavailableCliCheck } from "../src/cli-check-protocol.ts";
const requestId = "a0000000-0000-4000-8000-000000000001";
const request = {schema_version: "1.0", request_id: requestId, provider: "codex"};
const operation = {request_id: requestId, provider: "codex", revision: 0, phase: "starting", outcome: null, cli_version: null, error_code: null, cleanup: "pending"};
const status = {schema_version: "1.0", availability: "available", operation};
test("CLI check requests grant only a provider version check and revision-bound cancellation", () => {
  assert.deepEqual(validateCliCheckStart(request), request);
  const cancel = {schema_version: "1.0", request_id: requestId, expected_revision: 4};
  assert.deepEqual(validateCliCheckCancel(cancel), cancel);
  for (const key of ["argv", "env", "root", "prompt", "owner", "model"]) assert.throws(() => validateCliCheckStart({...request, [key]: "private"}));
  for (const bad of [null, -1, 1.1, 1e10, Number.NaN]) assert.throws(() => validateCliCheckCancel({...cancel, expected_revision: bad}));
  for (const bad of ["claude-code", "other", null]) assert.throws(() => validateCliCheckStart({...request, provider: bad}));
  assert.throws(() => validateCliCheckStart({...request, request_id: requestId.toUpperCase()}));
});
test("CLI check status is bounded, sanitized and distinguishes cleanup from completion", () => {
  assert.deepEqual(validateCliCheckStatus(status), status);
  assert.deepEqual(validateCliCheckStatus(unavailableCliCheck()), unavailableCliCheck());
  for (const [outcome, error_code, cleanup, cli_version] of [
    ["passed", null, "verified", "codex-cli 0.157.1"], ["cancelled", "cancelled", "verified", null],
    ["failed", "docker_unavailable", "verified", null], ["failed", "image_missing", "verified", null], ["needs_review", "cleanup_failed", "unknown", null],
  ]) assert.doesNotThrow(() => validateCliCheckStatus({...status, operation: {...operation, revision: 4, phase: "finished", outcome, error_code, cleanup, cli_version}}));
  for (const changes of [
    {private_error: "auth/path"}, {phase: "unknown"}, {revision: -1}, {outcome: "passed"}, {cleanup: "verified"},
    {cli_version: "x".repeat(121)}, {cli_version: "private\nerror"}, {error_code: "private/auth/path"},
    {phase: "finished", outcome: "passed", cli_version: "codex-cli", cleanup: "unknown"},
    {phase: "finished", outcome: "cancelled", cleanup: "verified", error_code: "worker_failed"},
    {phase: "finished", outcome: "failed", cleanup: "pending", error_code: "worker_failed"},
  ]) assert.throws(() => validateCliCheckStatus({...status, operation: {...operation, ...changes}}));
  assert.throws(() => validateCliCheckStatus({...status, availability: "unavailable"}));
});
test("live observations cannot replace, rewind or alter an unchanged revision", () => {
  const initial = validateCliCheckStatus(status);
  const next = {...status, operation: {...operation, revision: 3, phase: "checking"}};
  assert.deepEqual(acceptCliCheckUpdate(initial, next), next);
  const current = validateCliCheckStatus(next);
  for (const changes of [{revision: 2}, {phase: "preparing", revision: 4}, {request_id: "a0000000-0000-4000-8000-000000000002"}, {provider: "claude"}, {phase: "cleaning"}]) assert.throws(() => acceptCliCheckUpdate(current, {...next, operation: {...next.operation, ...changes}}));
  assert.throws(() => acceptCliCheckUpdate(current, unavailableCliCheck()));
  // Property order is not part of the wire contract.
  assert.doesNotThrow(() => acceptCliCheckUpdate(current, {...next, operation: Object.fromEntries(Object.entries(next.operation).reverse())}));
  const finished = validateCliCheckStatus({...next, operation: {...next.operation, phase: "finished", revision: 5, outcome: "cancelled", error_code: "cancelled", cleanup: "verified"}});
  assert.throws(() => acceptCliCheckUpdate(finished, next));
  assert.throws(() => acceptCliCheckUpdate(finished, {...finished, operation: {...finished.operation!, revision: 6}}));
});
