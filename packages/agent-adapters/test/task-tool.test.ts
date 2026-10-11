import { test } from "node:test";
import assert from "node:assert/strict";
import { executeTaskTool, validateTaskTool } from "../src/task-tool.ts";
import { CommandError, runOwnedCommand } from "../src/owned-process.ts";
test("task tool refuses selecting another attempt, Docker options or unbounded inputs", () => {
  for (const value of [null, [], { argv: [] }, { argv: ["--privileged", "node"] }, { argv: ["node"], container: "another" }, { argv: ["node"], cwd: "C:/Users" }, { argv: ["node\0"] }, { argv: ["node", "x".repeat(65537)] }, { argv: ["node"], timeout_ms: 30001 }, { argv: ["node"], timeout_ms: 0.5 }])
    assert.throws(() => validateTaskTool(value), /invalid_tool_arguments/);
});
test("task argv preserves shell-looking text as a single container argument", () => {
  assert.deepEqual(validateTaskTool({ argv: ["node", "-e", "console.log('$(whoami) & echo')"], timeout_ms: 1000 }), { argv: ["node", "-e", "console.log('$(whoami) & echo')"], timeout_ms: 1000 });
});

test("cancelling a task tool stops a slow owned command before its command deadline", async () => {
  const controller = new AbortController();
  let started!: () => void, failure: CommandError | undefined;
  const began = new Promise<void>(resolve => { started = resolve; });
  const runtime = {async exec(argv: string[], options: {timeoutMs?: number; signal?: AbortSignal} = {}) {
    // This local fixture exercises the real owned-process cancellation path;
    // no Docker, CLI or model is launched.
    const command = runOwnedCommand(process.execPath, argv.slice(1), options);
    started();
    try { return await command; }
    catch (error) {
      assert.ok(error instanceof CommandError); failure = error;
      const cleanup = await error.cleanup;
      assert.equal(cleanup.status, "termination_reported");
      throw error;
    }
  }};
  const running = executeTaskTool(runtime, {argv: ["node", "-e", "setTimeout(()=>process.exit(0),30000)"], timeout_ms: 3000}, controller.signal);
  await began; controller.abort("cancelled");
  assert.deepEqual(await running, {error: "task_tool_failed"});
  assert.equal(failure?.reason, "cancelled", "abort must terminate the command rather than waiting for its timeout");
});

test("existing task tool callers still execute without a signal", async () => {
  const reply = await executeTaskTool({async exec(argv, options) {
    return runOwnedCommand(process.execPath, argv.slice(1), options);
  }}, {argv: ["node", "-e", "process.stdout.write('ok')"]});
  assert.deepEqual(reply, {exit_code: 0, stdout: "ok", stderr: ""});
});
