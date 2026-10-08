import { test } from "node:test";
import assert from "node:assert/strict";
import { advertisedToolNames, codexEvents } from "../../spike/cli-session/model-fixture.mjs";
test("wire inventory includes tool definitions carried in additional_tools input", () => {
  assert.deepEqual(advertisedToolNames({ tools: [{ type: "function", name: "task_exec" }], input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }] }] }), ["task_exec", "functions.exec"]);
  assert.deepEqual(advertisedToolNames({ input: [{ type: "message", tools: [{ name: "irrelevant" }] }] }), []);
});
test("namespaced task calls retain exact identity without accepting lookalike namespaces", () => {
  const call = codexEvents("functions.task_exec", {}, "fixture").at(-1).response.output[0];
  assert.equal(call.name, "task_exec");assert.equal(call.namespace, "functions");
  const unknown = codexEvents("unreviewed.task_exec", {}, "fixture").at(-1).response.output[0];
  assert.equal(unknown.name, "unreviewed.task_exec");assert.equal(unknown.namespace, undefined);
});
