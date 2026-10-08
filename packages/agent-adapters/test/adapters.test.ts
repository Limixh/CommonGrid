import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexLine, describeTaskContainer } from "../src/index";
test("Codex protocol events normalize with client-reported usage", () => {
  assert.deepEqual(
    parseCodexLine('{"type":"thread.started","thread_id":"t1"}'),
    { type: "session", sessionId: "t1" },
  );
  assert.equal(parseCodexLine('{"type":"turn.started"}').type, "started");
  assert.deepEqual(
    parseCodexLine(
      '{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}',
    ),
    { type: "message", text: "Done" },
  );
  assert.deepEqual(
    parseCodexLine(
      '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":7}}',
    ),
    {
      type: "completed",
      usage: { inputTokens: 12, outputTokens: 7, source: "client_reported" },
    },
  );
});
test("unknown, malformed and oversized output never becomes progress", () => {
  for (const line of [
    "not json",
    "[]",
    '{"type":"thread.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":-2,"output_tokens":1}}',
    "x".repeat(1048577),
  ])
    assert.equal(parseCodexLine(line).type, "error");
  assert.equal(
    parseCodexLine('{"type":"custom.progress","progress":1}').type,
    "unknown",
  );
});
test("task container is constrained and does not mount host credentials", () => {
  const args = describeTaskContainer({
    image: "commongrid/task@sha256:" + "a".repeat(64),
    workspaceVolume: "cg-workspace-attempt-1",
    cpu: 2,
    memoryMb: 2048,
  });
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("none"));
  assert.ok(args.includes("65532:65532"));
  assert.ok(args.includes("ALL"));
  assert.ok(args.includes("no-new-privileges"));
  assert.ok(args.includes("type=volume,src=cg-workspace-attempt-1,dst=/task,volume-nocopy"));
  assert.ok(
    !args.some(
      (arg) =>
        arg.includes("type=bind") ||
        arg.includes("docker.sock") ||
        arg.includes("auth.json"),
    ),
  );
});
test("task container rejects mutable images, placeholder pins, host paths and excessive resources", () => {
  const spec = {
    image: "commongrid/task@sha256:" + "a".repeat(64),
    workspaceVolume: "cg-workspace-attempt-1",
    cpu: 2,
    memoryMb: 2048,
  };
  for (const patch of [
    { image: "ubuntu:latest" },
    { image: "task@sha256:" + "0".repeat(64) },
    { workspaceVolume: "C:\\Users\\Win10" },
    { workspaceVolume: "../../.codex" },
    { cpu: 65 },
    { memoryMb: 0 },
  ])
    assert.throws(() => describeTaskContainer({ ...spec, ...patch }));
});
