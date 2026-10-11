import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { TaskToolLimitError, prepareTaskToolReply, providerCommand, runControlledProviderTurn, type ProviderProcessFactory, type ProviderTurnOptions } from "../src/controlled-task-session.ts";
import { ProviderFailure } from "../src/session-protocol.ts";
import { taskRunMaxToolCalls, type TaskRunProvider } from "../src/task-run-protocol.ts";

type Write = (value: unknown) => void;
// A scripted stand-in for `docker exec -i <container> <official cli>`.
function fakeProcess(script: (message: Record<string, any>, write: Write) => void, start?: (write: Write) => void): {factory: ProviderProcessFactory; commands: string[][]; written: Record<string, any>[]} {
  const commands: string[][] = [], written: Record<string, any>[] = [];
  const factory: ProviderProcessFactory = (containerId, args) => {
    assert.match(containerId, /^[a-f0-9]{64}$/); commands.push(args);
    const child = Object.assign(new EventEmitter(), {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { setImmediate(() => child.emit("close", 0)); return true; }});
    const write: Write = value => { child.stdout.write(JSON.stringify(value) + "\n"); };
    createInterface({input: child.stdin}).on("line", line => { const message = JSON.parse(line); written.push(message); script(message, write); });
    if (start) setImmediate(() => start(write));
    return child as never;
  };
  return {factory, commands, written};
}
function turn(provider: TaskRunProvider, spawnProcess: ProviderProcessFactory, extra: Partial<ProviderTurnOptions> = {}) {
  const events: string[] = [], executed: unknown[] = [], stats = {control_failure: false, task_calls: 1}, trace = {quiescent: false}, execs: string[][] = [];
  const options: ProviderTurnOptions = {
    provider, spawnProcess, signal: new AbortController().signal, bridgeStats: stats, trace, deadlineMs: 5000,
    runtime: {
      async verifyOperation() { return "a".repeat(64); }, async beginNamespaceExec() {},
      async exec(args) { execs.push(args); return {code: 0, stdout: JSON.stringify({loggedIn: true, authMethod: "claude.ai"})}; },
    },
    async execute(arguments_) { executed.push(arguments_); return {exit_code: 0, stdout: "ok", stderr: ""}; },
    observer: {model: observed => events.push(`model:${observed}`), toolCall: count => events.push(`tools:${count}`)},
    ...extra,
  };
  return {options, events, executed, trace, execs, stats};
}
const toolCall = (id: number, threadId = "thread-1") => ({id: `call-${id}`, method: "item/tool/call", params: {threadId, tool: "task_exec", arguments: {argv: ["node", "-e", "1"]}}});
interface CodexScript { models?: unknown; model?: string; account?: unknown; calls?: number; turn?: Record<string, unknown>; failTurn?: boolean }
function codex(options: CodexScript = {}) {
  const process = fakeProcess((message, write) => {
    const reply = (result: unknown) => write({id: message.id, result});
    switch (message.method) {
      case "initialize": return reply({});
      case "account/read": return reply({account: Object.hasOwn(options, "account") ? options.account : {type: "chatgpt"}});
      case "model/list": return reply({data: options.models ?? [{model: "gpt-6-luna", hidden: false}, {model: "other-model", hidden: false}]});
      case "thread/start": return reply({thread: {id: "thread-1"}, model: options.model ?? "gpt-6-luna"});
      case "turn/start": {
        reply({turn: {id: "turn-1"}});
        for (let index = 1; index <= (options.calls ?? 2); index++) write(toolCall(index));
        // The completion notification only follows the last answered callback.
        if (!options.failTurn) setImmediate(() => setTimeout(() => write({method: "turn/completed", params: {threadId: "thread-1", turn: {id: "turn-1", status: "completed", ...options.turn}}}), 30));
        else write({method: "turn/completed", params: {threadId: "thread-1", turn: {id: "turn-1", status: "failed", error: {message: "usage limit reached for this account"}}}});
      }
    }
  });
  return process;
}
test("provider commands pin the cheap model and never offer a fallback", () => {
  const claude = providerCommand("claude"), codexArgs = providerCommand("codex");
  assert.deepEqual(claude.slice(claude.indexOf("--model"), claude.indexOf("--model") + 4), ["--model", "haiku", "--fallback-model", "haiku"]);
  assert.ok(codexArgs.includes('model="gpt-6-luna"') && codexArgs.includes('model_catalog_json="/opt/cg/catalog.json"') && codexArgs.includes("agents.enabled=false"));
  assert.ok(!claude.concat(codexArgs).some(arg => /sonnet|opus|astra/i.test(arg)));
});
test("tool replies carry only reconstructed scalars and bounded text", () => {
  assert.deepEqual(prepareTaskToolReply({exit_code: 0, stdout: "a", stderr: "", extra: "PRIVATE"}), {success: true, contentItems: [{type: "inputText", text: '{"exit_code":0,"stdout":"a","stderr":""}'}]});
  assert.equal(prepareTaskToolReply({exit_code: 2, stdout: "", stderr: "x"}).success, false);
  assert.equal(prepareTaskToolReply({error: "PRIVATE"}).contentItems[0].text, '{"error":"task_tool_failed"}');
  assert.equal(prepareTaskToolReply({exit_code: 0, stdout: "x".repeat(60_000), stderr: ""}).contentItems[0].text, '{"error":"task_output_limit"}');
  assert.equal(prepareTaskToolReply("junk").contentItems[0].text, '{"error":"task_tool_failed"}');
});
test("Codex turn observes the pinned model once, counts callbacks and answers them through the sandbox", async () => {
  const process = codex(), t = turn("codex", process.factory);
  await runControlledProviderTurn(t.options);
  assert.deepEqual(t.events, ["model:gpt-6-luna", "tools:1", "tools:2"]); assert.equal(t.executed.length, 2); assert.equal(t.trace.quiescent, true);
  assert.equal(process.written.find(message => message.method === "thread/start")!.params.model, "gpt-6-luna");
  assert.equal(process.written.filter(message => message.result?.success === true).length, 2);
  assert.ok(process.commands[0].includes('model="gpt-6-luna"'));
});
test("Codex without the cheap model stops before any thread or turn: no fallback", async () => {
  for (const models of [[{model: "other-model", hidden: false}], [{model: "gpt-6-luna", hidden: true}]]) {
    const process = codex({models}), t = turn("codex", process.factory);
    await assert.rejects(runControlledProviderTurn(t.options), error => error instanceof ProviderFailure && error.category === "model");
    assert.ok(!process.written.some(message => message.method === "thread/start")); assert.deepEqual(t.events, []); assert.equal(t.trace.quiescent, true);
  }
  const mismatch = codex({model: "other-model"}), t = turn("codex", mismatch.factory);
  await assert.rejects(runControlledProviderTurn(t.options), error => error instanceof ProviderFailure && error.category === "model");
  assert.ok(!mismatch.written.some(message => message.method === "turn/start")); assert.deepEqual(t.events, []);
});
test("Codex account, quota and tool-limit failures are classified without provider text", async () => {
  const anonymous = codex({account: null}), a = turn("codex", anonymous.factory);
  await assert.rejects(runControlledProviderTurn(a.options), error => error instanceof ProviderFailure && error.category === "auth_required");
  const quota = codex({failTurn: true, calls: 0}), q = turn("codex", quota.factory);
  await assert.rejects(runControlledProviderTurn(q.options), error => error instanceof ProviderFailure && error.category === "quota" && !error.message.includes("account"));
  const limit = codex({calls: taskRunMaxToolCalls + 1}), l = turn("codex", limit.factory);
  await assert.rejects(runControlledProviderTurn(l.options), TaskToolLimitError);
  assert.equal(l.events.filter(event => event.startsWith("tools:")).length, taskRunMaxToolCalls); assert.ok(l.executed.length <= taskRunMaxToolCalls);
});
test("Codex turn without any callback cannot pass and a cancelled signal stops the process", async () => {
  const none = codex({calls: 0}), n = turn("codex", none.factory);
  await assert.rejects(runControlledProviderTurn(n.options), error => error instanceof ProviderFailure && error.category === "protocol");
  const controller = new AbortController(), silent = fakeProcess(() => {}), s = turn("codex", silent.factory, {signal: controller.signal});
  const pending = runControlledProviderTurn(s.options); setTimeout(() => controller.abort("cancelled"), 20);
  await assert.rejects(pending, error => error instanceof ProviderFailure && error.category === "canceled");
  const deadline = new AbortController(), late = turn("codex", fakeProcess(() => {}).factory, {signal: deadline.signal}); deadline.abort("deadline_exceeded");
  await assert.rejects(runControlledProviderTurn(late.options), error => error instanceof ProviderFailure && error.category === "deadline");
});
const claudeStream = (model: string, uses: number, result: Record<string, unknown> = {type: "result", subtype: "success", is_error: false}) => (write: Write) => {
  write({type: "system", subtype: "init", model});
  for (let index = 0; index < uses; index++) write({type: "assistant", message: {model, content: [{type: "tool_use", id: `use-${index}`, name: "mcp__commongrid__task_exec", input: {argv: ["node"]}}]}});
  write(result);
};
test("Claude stream observes an accepted Haiku identity and counts tool uses", async () => {
  const process = fakeProcess(() => {}, claudeStream("claude-haiku-4-5-20251001", 2)), t = turn("claude", process.factory); t.stats.task_calls = 2;
  await runControlledProviderTurn(t.options);
  assert.deepEqual(t.events, ["model:claude-haiku-4-5-20251001", "tools:1", "tools:2"]); assert.equal(t.trace.quiescent, true);
  assert.deepEqual(t.execs, [["/opt/cg/claude", "auth", "status", "--json"]]);
  assert.ok(process.commands[0].includes("--fallback-model") && process.commands[0].includes("haiku"));
});
test("Claude with another model, no login, a quota result or too many tool uses fails with the right category", async () => {
  for (const model of ["claude-sonnet-4-5", "claude-opus-4-1", "haiku"]) {
    const t = turn("claude", fakeProcess(() => {}, claudeStream(model, 1)).factory);
    await assert.rejects(runControlledProviderTurn(t.options), error => error instanceof ProviderFailure && error.category === "model"); assert.deepEqual(t.events, []);
  }
  const loggedOut = turn("claude", fakeProcess(() => {}, claudeStream("claude-haiku-4-5", 1)).factory, {runtime: {
    async verifyOperation() { return "a".repeat(64); }, async beginNamespaceExec() {}, async exec() { return {code: 1, stdout: JSON.stringify({loggedIn: false, authMethod: "none"})}; }}});
  await assert.rejects(runControlledProviderTurn(loggedOut.options), error => error instanceof ProviderFailure && error.category === "auth_required");
  const quota = turn("claude", fakeProcess(() => {}, claudeStream("claude-haiku-4-5", 1, {type: "result", subtype: "error_max_budget_usd", is_error: true})).factory);
  await assert.rejects(runControlledProviderTurn(quota.options), error => error instanceof ProviderFailure && error.category === "quota");
  const many = turn("claude", fakeProcess(() => {}, claudeStream("claude-haiku-4-5", taskRunMaxToolCalls + 1)).factory); many.stats.task_calls = 16;
  await assert.rejects(runControlledProviderTurn(many.options), TaskToolLimitError); assert.equal(many.events.filter(event => event.startsWith("tools:")).length, taskRunMaxToolCalls);
  const idle = turn("claude", fakeProcess(() => {}, claudeStream("claude-haiku-4-5", 0)).factory); idle.stats.task_calls = 0;
  await assert.rejects(runControlledProviderTurn(idle.options), error => error instanceof ProviderFailure && error.category === "protocol");
});
