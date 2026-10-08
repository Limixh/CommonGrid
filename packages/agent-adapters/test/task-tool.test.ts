import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTaskTool } from "../src/task-tool.ts";
test("task tool refuses selecting another attempt, Docker options or unbounded inputs", () => {
  for (const value of [null, [], { argv: [] }, { argv: ["--privileged", "node"] }, { argv: ["node"], container: "another" }, { argv: ["node"], cwd: "C:/Users" }, { argv: ["node\0"] }, { argv: ["node", "x".repeat(65537)] }, { argv: ["node"], timeout_ms: 30001 }, { argv: ["node"], timeout_ms: 0.5 }])
    assert.throws(() => validateTaskTool(value), /invalid_tool_arguments/);
});
test("task argv preserves shell-looking text as a single container argument", () => {
  assert.deepEqual(validateTaskTool({ argv: ["node", "-e", "console.log('$(whoami) & echo')"], timeout_ms: 1000 }), { argv: ["node", "-e", "console.log('$(whoami) & echo')"], timeout_ms: 1000 });
});
