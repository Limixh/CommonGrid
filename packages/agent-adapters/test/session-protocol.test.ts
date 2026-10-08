import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { BoundedJsonInput, BoundedJsonLines, IncomingLineBytes, LoginCompletion, OperationCancellation, ProviderFailure, RpcLifecycle, TaskCallbackGuard, assertBridgeHealthy, classifyProviderFailure, failureCode, validateClaudeIdentity, validateClaudeResult, validateClaudeStatus, validateCodexIdentity, validateCodexTurn } from "../src/session-protocol.ts";

const category = (expected: string) => (error: unknown) => error instanceof ProviderFailure && error.category === expected;
test("sticky relay failure prevents provider success from becoming acceptance success", () => {
  const stats:Record<string,unknown> = { task_calls: 1, control_failure: false };
  validateClaudeResult({ type: "result", subtype: "success", is_error: false });assertBridgeHealthy(stats);
  stats.control_failure = true;
  assert.throws(() => assertBridgeHealthy(stats), { message: "managed_bridge_control_failed" });
  stats.task_calls = 2;
  assert.throws(() => assertBridgeHealthy(stats), { message: "managed_bridge_control_failed" });
  for(const control_failure of [null, undefined, "false", 0])assert.throws(() => assertBridgeHealthy({control_failure}), { message: "managed_bridge_control_failed" });
});
test("managed identities require explicit subscription types and reject paid API fallback", () => {
  assert.deepEqual(validateCodexIdentity({ account: { type: "chatgpt", email: "fixture@example.invalid" } }, "refresh"), { authenticated: true, method: "chatgpt" });
  assert.deepEqual(validateCodexIdentity({ account: null }, "status"), { authenticated: false, method: "none" });
  for (const account of [{ type: "apiKey" }, { type: "unknown" }, {}, "chatgpt", false]) assert.throws(() => validateCodexIdentity({ account }, "status"), category("identity"));
  for (const value of [{}, { account: undefined }, null, []]) assert.throws(() => validateCodexIdentity(value, "status"), error => error instanceof ProviderFailure);
  assert.throws(() => validateCodexIdentity({ account: null }, "refresh"), category("auth_required"));
  assert.throws(() => validateCodexIdentity({ account: { type: "chatgpt" } }, "logout"), category("identity"));
  assert.deepEqual(validateClaudeIdentity({ loggedIn: true, authMethod: "claude.ai" }, true), { authenticated: true, method: "claude.ai" });
  assert.deepEqual(validateClaudeIdentity({ loggedIn: false, authMethod: "none" }, false, true), { authenticated: false, method: "none" });
  for (const authMethod of ["api_key", "oauth", {}, "unknown"]) assert.throws(() => validateClaudeIdentity({ loggedIn: true, authMethod }), category("identity"));
  assert.throws(() => validateClaudeIdentity({ loggedIn: false, authMethod: "api_key" }), category("identity"));
  assert.throws(() => validateClaudeIdentity({ loggedIn: "true", authMethod: "claude.ai" }), category("protocol"));
  assert.throws(() => validateClaudeIdentity({ loggedIn: false }, true), category("auth_required"));
});
test("provider failures normalize into fixed categories without exposing messages", () => {
  const cases = [
    ["session token expired", "session_expired"], ["invalid_grant: refresh failed", "session_expired"], ["401 unauthorized", "auth_required"],
    ["429 Too many requests", "quota"], ["usage limit reached", "quota"], ["connection reset", "network"], ["request failed", "network"],
    ["certificate has expired", "tls"], ["403 forbidden", "http_403"], ["model not found", "model"], ["permission denied", "permission"],
    ["operation canceled", "canceled"], ["operation interrupted", "canceled"], ["request timed out", "deadline"], ["malformed callback", "protocol"], ["unfamiliar provider text", "unclassified"],
  ];
  for (const [message, expected] of cases) assert.equal(classifyProviderFailure({ message: `${message}; fixture-secret` }), expected);
  assert.equal(failureCode(new Error("managed_failure\nfixture-secret")), "managed_validation_failed");
  assert.equal(failureCode(new Error("fixture_candidate_rejected")), "fixture_candidate_rejected");
  assert.equal(failureCode(new ProviderFailure("quota")), "managed_provider_quota");
});
test("Claude status admits exit 1 only for validated logged-out state", () => {
  assert.deepEqual(validateClaudeStatus('{"loggedIn":false,"authMethod":"none"}', 1, false, true), { authenticated: false, method: "none" });
  assert.throws(() => validateClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai"}', 1), category("process"));
  assert.throws(() => validateClaudeStatus('{"loggedIn":false}', 1, true), category("auth_required"));
  assert.throws(() => validateClaudeStatus('{"loggedIn":false}', 2), category("process"));
  assert.throws(() => validateClaudeStatus('fixture-invalid-json', 1), category("protocol"));
});
test("JSON event boundary rejects malformed shapes and bounds queued bytes", () => {
  for (const line of ["{", "null", "[]", '"text"', "1"]) assert.throws(() => new BoundedJsonLines(128, 64).decode(line), category("protocol"));
  const decoder = new BoundedJsonLines(20, 16);
  assert.deepEqual(decoder.decode('{"a":1}'), { a: 1 });
  decoder.decode('{"a":2}');
  assert.throws(() => decoder.decode('{"a":3}'), category("protocol"));
  assert.throws(() => new BoundedJsonLines(64, 4).decode('{"a":1}'), category("protocol"));
});
test("incoming byte guard rejects split oversized lines before any newline arrives", () => {
  const limits=new IncomingLineBytes(128,8);
  limits.accept(Buffer.from("1234"));limits.accept(Buffer.from("5678"));
  assert.throws(()=>limits.accept(Buffer.from("fixture-secret")),category("protocol"));
  // A delayed newline cannot revive a failed stream.
  assert.throws(()=>limits.accept(Buffer.from("\n")),category("protocol"));
});
test("incoming byte guard counts total raw bytes and resets across split CRLF", () => {
  const limits=new IncomingLineBytes(13,4);
  limits.accept(Buffer.from("12\r"));limits.accept(Buffer.from("\n3456\n"));limits.accept(Buffer.from("7890"));
  assert.throws(()=>limits.accept(Buffer.from("\n")),category("protocol"));
  const lines=new IncomingLineBytes(128,4);
  lines.accept(Buffer.from("1234"));lines.accept(Buffer.from("\n12\r"));lines.accept(Buffer.from("\n34\n1234"));
  assert.throws(()=>lines.accept(Buffer.from("5\n")),category("protocol"));
});
test("incoming byte guard counts UTF-8 across arbitrary chunk boundaries", () => {
  const encoded=Buffer.from("€");const limits=new IncomingLineBytes(32,2);
  limits.accept(encoded.subarray(0,1));
  assert.throws(()=>limits.accept(encoded.subarray(1)),category("protocol"));
});
test("bounded input rejects newline-delayed output before readline produces a line", async () => {
  const input=new BoundedJsonInput(64,4);const lines=createInterface({input,crlfDelay:Infinity});
  let emitted=0;lines.on("line",()=>emitted++);lines.on("error",()=>{});
  const failed=once(input,"error");input.write(Buffer.from("12"));input.write(Buffer.from("34"));input.write(Buffer.from("5"));
  const [error]=await failed;assert.equal(failureCode(error),"managed_provider_protocol");assert.equal(emitted,0);
  assert.equal(input.destroyed,true);lines.close();
});
test("device completion handles early notification and matches the requested login", async () => {
  const login = new LoginCompletion(); login.receive({ loginId: "fixture-login", success: true }); login.bind("fixture-login"); await login.done;
  const failure = new LoginCompletion(); failure.bind("fixture-failed"); failure.receive({ loginId: "fixture-failed", success: false }); await assert.rejects(failure.done, category("auth_required"));
  const other = new LoginCompletion(); other.receive({ loginId: "other", success: true }); assert.throws(() => other.bind("requested"), category("protocol"));
  assert.throws(() => login.receive({ loginId: "fixture-login", success: true }), category("protocol"));
  for (const value of [{}, { loginId: "fixture", success: "true" }, { loginId: "", success: true }, null]) assert.throws(() => new LoginCompletion().receive(value), category("protocol"));
});
test("RPC deadline rejects pending requests and stops the owned process exactly once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let stops = 0; const rpc = new RpcLifecycle(() => {}, 30_000, () => { stops++; });
  const request = rpc.request("account/read", {});
  t.mock.timers.tick(30_000);
  await assert.rejects(request, category("deadline")); await assert.rejects(rpc.done, category("deadline"));
  await assert.rejects(rpc.request("account/logout", {}), category("deadline"));
  rpc.fail(new ProviderFailure("process")); rpc.dispose(); assert.equal(stops, 1);
});
test("RPC early exit and write failure reject both operation and every pending request", async () => {
  const rpc = new RpcLifecycle(() => {}, 30_000, () => {});
  const first = rpc.request("initialize", {}), second = rpc.request("account/read", {}); rpc.processExit();
  await assert.rejects(first, category("process")); await assert.rejects(second, category("process")); await assert.rejects(rpc.done, category("process")); rpc.dispose();
  const broken = new RpcLifecycle(() => { throw new Error("fixture-write-error"); }, 30_000, () => {});
  await assert.rejects(broken.request("initialize", {}), category("process")); broken.dispose();
});
test("explicit cancellation stays distinct from later deadline or process failures", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let stops=0;const rpc=new RpcLifecycle(()=>{},30_000,()=>{stops++;});const request=rpc.request("account/read",{});
  rpc.fail(new ProviderFailure("canceled"));t.mock.timers.tick(30_000);rpc.processExit();
  await assert.rejects(request,category("canceled"));await assert.rejects(rpc.done,category("canceled"));assert.equal(stops,1);rpc.dispose();
});
test("operation cancellation survives RPC disposal during snapshot, verifier and diff work", async () => {
  for(const canceledPhase of ["snapshot","verifier","diff"]){
    const operation=new OperationCancellation(),rpc=new RpcLifecycle(()=>{},30_000,()=>{});rpc.finish();await rpc.done;rpc.dispose();
    const verification=(async()=>{
      for(const phase of ["snapshot","verifier","diff"]){
        await Promise.resolve();
        if(phase===canceledPhase){operation.cancel();rpc.fail(new ProviderFailure("canceled"));}
        operation.assertActive();
      }
      return {success:true};
    })();
    await assert.rejects(verification,category("canceled"));
    rpc.assertHealthy();assert.throws(()=>operation.assertActive(),category("canceled"));
  }
});
test("RPC response ownership rejects unknown ids, duplicate responses and ambiguous envelopes", async () => {
  const sent: string[] = [], rpc = new RpcLifecycle(line => { sent.push(line); }, 30_000, () => {});
  const request = rpc.request("account/read", {}); const id = JSON.parse(sent[0]).id;
  for (const response of [{ id: id + 1, result: {} }, { id: String(id), result: {} }, { id }, { id, result: {}, error: { code: 1, message: "fixture" } }, { id, error: "fixture" }]) assert.throws(() => rpc.response(response), category("protocol"));
  assert.equal(rpc.response({ id, result: { account: null } }), true); assert.deepEqual(await request, { account: null });
  assert.throws(() => rpc.response({ id, result: {} }), category("protocol")); rpc.dispose();
});
test("RPC provider error preserves category and cancels other pending operations", async () => {
  const rpc = new RpcLifecycle(() => {}, 30_000, () => {});
  const first = rpc.request("account/read", {}), second = rpc.request("model/list", {});
  rpc.response({ id: 1, error: { code: -1, message: "expired session token; fixture-secret" } });
  await assert.rejects(first, category("session_expired")); await assert.rejects(second, category("session_expired")); await assert.rejects(rpc.done, category("session_expired")); rpc.dispose();
});
test("RPC completion permits the matching start response and rejects premature process closure", async () => {
  const rpc = new RpcLifecycle(() => {}, 30_000, () => {}); const request = rpc.request("turn/start", {}); rpc.finish();
  rpc.response({ id: 1, result: { turn: { id: "fixture-turn" } } }); await request; await rpc.done; rpc.processExit(); rpc.assertHealthy(); rpc.dispose();
  const pending = new RpcLifecycle(() => {}, 30_000, () => {}); const unresolved = pending.request("turn/start", {}); pending.finish(); pending.processExit();
  await assert.rejects(unresolved, category("process")); assert.throws(() => pending.assertHealthy(), category("process")); pending.dispose();
});
test("RPC request count is bounded and disposal blocks new work", async () => {
  const rpc = new RpcLifecycle(() => {}, 30_000, () => {}), pending = Array.from({ length: 32 }, () => rpc.request("fixture", {}));
  await assert.rejects(rpc.request("fixture", {}), category("protocol")); rpc.dispose();
  await Promise.all(pending.map(request => assert.rejects(request, category("canceled")))); await assert.rejects(rpc.request("fixture", {}), category("canceled"));
  const disposed = new RpcLifecycle(() => {}, 30_000, () => {}); disposed.dispose(); disposed.processExit(); disposed.fail(new ProviderFailure("process")); disposed.assertHealthy();
});
test("task callbacks require exact tool, thread, namespace and fresh bounded ids", () => {
  const callback = (id: number) => ({ id, method: "item/tool/call", params: { threadId: "fixture-thread", tool: "task_exec", namespace: null, arguments: { argv: ["node", "--version"] } } });
  const guard = new TaskCallbackGuard(); assert.deepEqual(guard.validate(callback(1), "fixture-thread"), { argv: ["node", "--version"] });
  assert.throws(() => guard.validate(callback(1), "fixture-thread"), category("protocol"));
  for (const change of [{ tool: "exec" }, { threadId: "other" }, { namespace: "functions" }, { namespace: false }, { arguments: "fixture" }]) assert.throws(() => new TaskCallbackGuard().validate({ ...callback(2), params: { ...callback(2).params, ...change } }, "fixture-thread"), category("protocol"));
  new TaskCallbackGuard().validate({ ...callback(2), params: { ...callback(2).params, namespace: undefined } }, "fixture-thread");
  assert.throws(() => new TaskCallbackGuard().validate({ ...callback(2), method: "unknown/callback" }, "fixture-thread"), category("protocol"));
  for (let id = 2; id <= 16; id++) guard.validate(callback(id), "fixture-thread");
  assert.throws(() => guard.validate(callback(17), "fixture-thread"), category("protocol"));
});
test("Claude completion classifies failed results and rejects ambiguous success", () => {
  validateClaudeResult({ type: "result", subtype: "success", is_error: false });
  for (const value of [{ type: "result", subtype: "success" }, { type: "result", subtype: "unknown", is_error: false }, { type: "result", subtype: "success", is_error: true }]) assert.throws(() => validateClaudeResult(value), category("protocol"));
  assert.throws(() => validateClaudeResult({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["network connection reset"] }), category("network"));
  assert.throws(() => validateClaudeResult({ type: "result", subtype: "error_max_budget_usd", is_error: true }), category("quota"));
});
test("Codex completion belongs to the active thread and turn, and preserves failure category", () => {
  const value = { threadId: "fixture-thread", turn: { id: "fixture-turn", status: "completed", error: null } };
  validateCodexTurn(value, "fixture-thread", "fixture-turn");
  assert.throws(() => validateCodexTurn(value, "other", "fixture-turn"), category("protocol"));
  assert.throws(() => validateCodexTurn(value, "fixture-thread", "other"), category("protocol"));
  assert.throws(() => validateCodexTurn({ ...value, turn: { ...value.turn, status: "interrupted" } }, "fixture-thread", "fixture-turn"), category("canceled"));
  assert.throws(() => validateCodexTurn({ ...value, turn: { ...value.turn, status: "failed", error: { message: "rate limit exceeded" } } }, "fixture-thread", "fixture-turn"), category("quota"));
  assert.throws(() => validateCodexTurn({ ...value, turn: { ...value.turn, status: "inProgress" } }, "fixture-thread", "fixture-turn"), category("protocol"));
});
