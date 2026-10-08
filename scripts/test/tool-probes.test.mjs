import { test } from "node:test";
import assert from "node:assert/strict";
import { probeTool } from "../tool-probes.mjs";

test("a new Windows native Claude install is detected with a stale process PATH", () => {
  let called;
  const result = probeTool("claude", ["--help"], {
    platform: "win32", env: { USERPROFILE: "C:\\Users\\Test", PATH: "old" },
    exists: (p) => p === "C:\\Users\\Test\\.local\\bin\\claude.exe",
    run: (...args) => { called = args; return { status: 0, stdout: "--tools" }; },
  });
  assert.equal(result.available, true);
  assert.equal(result.resolution, "native_install");
  assert.equal(called[0], "C:\\Users\\Test\\.local\\bin\\claude.exe");
  assert.deepEqual(called[1], ["--help"]);
});

test("Windows npm shim probes refuse shell text and task-supplied switches", () => {
  let executions = 0;
  const options = { platform: "win32", env: {}, run: () => { executions++; return { status: 0 }; } };
  for (const args of [["--help & whoami"], ["-p", "task"], ["$(whoami)"], []])
    assert.throws(() => probeTool("claude", args, options));
  assert.equal(executions, 0);
  probeTool("codex", ["exec", "--help"], options);
  assert.equal(executions, 1);
});

test("a failed engine probe exposes no diagnostic output or private environment", () => {
  const result = probeTool("docker", ["info", "--format", "{{.ServerVersion}}"], {
    run: () => ({ status: 1, stdout: "private diagnostic", stderr: "private diagnostic" }),
  });
  assert.equal(result.available, false);
  assert.equal(result.stdout, "");
  assert.ok(!("stderr" in result));
});

test("read-only probes refuse native CLI model calls and engine mutation", () => {
  const run = () => { throw new Error("probe must not execute"); };
  assert.throws(() => probeTool("claude", ["-p", "task"], { platform: "linux", run }), /unsupported/);
  assert.throws(() => probeTool("docker", ["run", "image"], { run }), /unsupported/);
  assert.throws(() => probeTool("codex", ["exec", "task"], { run }), /unsupported/);
});
