import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeLine, parseCodexAppServerLine } from "../src/provider-events.ts";
test("Claude completion requires successful subtype and explicit non-error status", () => {
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 2, output_tokens: 3 } })), { type: "completed", usage: { inputTokens: 2, outputTokens: 3, source: "client_reported" } });
  for (const value of [{ type: "result", subtype: "error_during_execution", is_error: true }, { type: "result", subtype: "success" }, { type: "result", subtype: "success", is_error: false, usage: { input_tokens: -1, output_tokens: 0 } }])
    assert.equal(parseClaudeLine(JSON.stringify(value)).type, "error");
});
test("Claude tool calls and unknown events cannot imply progress or completion", () => {
  assert.equal(parseClaudeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "task_exec" }] } })).type, "unknown");
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Text" }] } })), { type: "message", text: "Text" });
  assert.equal(parseClaudeLine('{"type":"custom.progress"}').type, "unknown");
  assert.equal(parseClaudeLine("x".repeat(1048577)).type, "error");
});
test("Codex app-server interrupted and failed turns never normalize as completed", () => {
  for (const status of ["failed", "interrupted", "inProgress"])
    assert.equal(parseCodexAppServerLine(JSON.stringify({ method: "turn/completed", params: { turn: { status } } })).type, "error");
  assert.equal(parseCodexAppServerLine(JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } })).type, "completed");
  assert.equal(parseCodexAppServerLine('{"id":1,"result":{}}').type, "unknown");
});
