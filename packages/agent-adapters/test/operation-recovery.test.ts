import test from "node:test";
import assert from "node:assert/strict";
import { createOperationReviewRequest, projectOperationRecovery, validateRecoveryStatus } from "../src/operation-recovery.ts";
import { operationStatusMiddleware } from "../../../apps/desktop/operation-status-server.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

const identity = {owner: "a0000000-0000-4000-8000-000000000001", provider: "codex", operation: "a0000000-0000-4000-8000-000000000002"};
const snapshot = () => ({identity: {...identity}, namespace_ids: ["a".repeat(64)], captures: [{intent_id: "a0000000-0000-4000-8000-000000000003", resource_id: "a".repeat(64)}], pending: [{intent_id: "a0000000-0000-4000-8000-000000000003", action: "namespace_create", role: "runtime"}], last_sequence: 3, last_hash: "b".repeat(64), terminal: false, durability: "process_crash"});
const input = () => ({status: "available", operations: [snapshot()]});
test("historical captured IDs retain uncertainty and confer no cleanup authority", () => {
  const projected = projectOperationRecovery(input());
  assert.equal(projected.operations[0].pending_count, 1);
  assert.equal(projected.operations[0].status, "needs_review");
  assert.equal(projected.daemon_state, "unknown");
  assert.equal(projected.worker_quiescence, "unknown");
  assert.equal(projected.execution_enabled, false);
  assert.equal(projected.automatic_recovery, false);
  assert.equal(JSON.stringify(projected).includes("a".repeat(64)), false);
  const request = createOperationReviewRequest(projected, identity);
  assert.equal(request.expected_sequence, 3); assert.equal(request.expected_hash, "b".repeat(64));
  assert.equal(request.action, "inspect_only"); assert.deepEqual(request.identity, identity);
  assert.throws(() => createOperationReviewRequest(projected, {...identity, owner: "b0000000-0000-4000-8000-000000000001"}), /operation_review_unavailable/);
});
test("missing and malformed sources fail closed without paths or raw extensions", () => {
  assert.equal(projectOperationRecovery({status: "unavailable", reason: "operation_journal_missing", operations: []}).status, "unavailable");
  for (const malformed of [
    {...input(), path: "private/auth"}, {status: "blocked", reason: "D:/private/auth", operations: []},
    {status: "available", operations: [{...snapshot(), secret: "private/auth"}]},
    {status: "available", operations: [{...snapshot(), terminal: true}]},
    {status: "available", operations: [{...snapshot(), durability: {toString: () => "process_crash"}}]},
    {status: "available", operations: [snapshot(), snapshot()]},
    {status: "available", operations: [{...snapshot(), last_hash: "not-hash"}]},
  ]) {
    const projected = projectOperationRecovery(malformed);
    assert.equal(projected.status, "blocked"); assert.deepEqual(projected.operations, []);
    assert.equal(JSON.stringify(projected).includes("private"), false);
  }
  assert.equal(projectOperationRecovery({status: "available", operations: Array.from({length: 1025}, snapshot)}).reason, "operation_journal_overflow");
});
test("terminal records are historical completion, never a review or daemon proof", () => {
  const projected = projectOperationRecovery({status: "available", operations: [{...snapshot(), terminal: true, pending: []}]});
  assert.equal(projected.operations[0].status, "recorded_complete");
  assert.throws(() => createOperationReviewRequest(projected, identity), /operation_review_unavailable/);
  assert.deepEqual(validateRecoveryStatus(projected), projected);
  for (const malformed of [{...projected, execution_enabled: true}, {...projected, daemon_state: "stopped"}, {...projected, secret: "token"}, {...projected, operations: [{...projected.operations[0], pending_count: 1}]}]) assert.throws(() => validateRecoveryStatus(malformed), /operation_recovery_response_invalid/);
});
test("developer status endpoint admits only GET on its fixed same-origin loopback source", async () => {
  let reads = 0;
  const middleware = operationStatusMiddleware("fixed-fixture-root", async (root, options) => {reads++; assert.equal(root, "fixed-fixture-root"); assert.equal(options.maxOperations, 1024); return {status: "unavailable", reason: "operation_journal_missing", operations: []};});
  async function request(method = "GET", url = "/", headers: Record<string, string> = {host: "127.0.0.1:1420"}) {
    let body = ""; const responseHeaders: Record<string, string> = {};
    const response = {statusCode: 200, setHeader: (name: string, value: string) => {responseHeaders[name] = value;}, end: (value: string) => {body = value;}};
    await middleware({method, url, headers} as IncomingMessage, response as unknown as ServerResponse);
    return {status: response.statusCode, body: JSON.parse(body), headers: responseHeaders};
  }
  for (const args of [["POST", "/"], ["GET", "/?path=private"], ["GET", "/", {host: "attacker.example"}], ["GET", "/", {host: "127.0.0.1:1420", origin: "https://attacker.example"}], ["GET", "/", {host: "127.0.0.1:1420", origin: "http://localhost:1420"}], ["GET", "/", {host: "127.0.0.1:1420", "sec-fetch-site": "cross-site"}]] as const) {
    const response = await request(args[0], args[1], args[2]); assert.ok(response.status >= 400);
  }
  assert.equal(reads, 0);
  const accepted = await request(); assert.equal(accepted.status, 200); assert.equal(accepted.body.status, "unavailable"); assert.equal(accepted.headers["Cache-Control"], "no-store"); assert.equal(reads, 1);
});
test("reader exceptions expose only a fixed blocked code", async () => {
  let body = "";
  await operationStatusMiddleware("unused", async () => {throw new Error("D:/private/auth/token");})({method: "GET", url: "/", headers: {host: "localhost:1420"}} as IncomingMessage, {setHeader() {}, end(value: string) {body = value;}} as unknown as ServerResponse);
  assert.equal(JSON.parse(body).reason, "operation_journal_io_failed"); assert.equal(body.includes("private"), false);
});

