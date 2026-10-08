import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Socket } from "node:net";
import test from "node:test";
import { attachManagedControl, validateControlEnvelope } from "./managed-control.mts";
import { Frames } from "./tunnel-wire.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options: Parameters<typeof attachManagedControl>[1] = { provider: "codex" }, blockedOutput = false) {
  const child = Object.assign(new EventEmitter(), { stdin: blockedOutput ? new Writable({ write(_chunk, _encoding, _callback) {} }) : new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } });
  const replies: any[] = [];
  if (!blockedOutput) child.stdin.on("data", chunk => { for (const line of chunk.toString().trim().split("\n")) replies.push(JSON.parse(line)); });
  const control = attachManagedControl(child as unknown as ChildProcessWithoutNullStreams, { readyTimeoutMs: 1000, ...options });
  const send = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
  const start = async () => { send({ kind: "ready" }); await control.ready; };
  return { child, control, replies, send, start };
}
test("host control envelopes reject null, unknown fields, spoofed identities and malformed data", () => {
  for (const value of [null, [], 7, { kind: "__proto__" }, { kind: "task", id: "a", arguments: {}, container: "escape" }, { kind: "task", id: "../scope", arguments: {} }, { kind: "task", id: "x".repeat(65), arguments: {} }, { kind: "connect", id: "a", authority: null }, { kind: "data", id: "a", data: "!!!" }, { kind: "ready", id: "a" }]) assert.throws(() => validateControlEnvelope(value));
});
test("control before readiness and repeated readiness fail closed", async () => {
  for (const repeated of [false, true]) {
    const f = fixture(); try { if (repeated) await f.start(); f.send(repeated ? { kind: "ready" } : { kind: "task", id: "a", arguments: {} }); await tick(); assert.equal(f.control.stats.control_failure, true); if (!repeated) await assert.rejects(f.control.ready); } finally { f.control.close(); }
  }
});
test("intentional shutdown does not mark a control failure or send late task replies", async () => {
  let release!: (value: unknown) => void;
  const f = fixture({provider:"codex",execute:async()=>new Promise(resolve=>{release=resolve;})});
  await f.start(); f.send({kind:"task",id:"a",arguments:{}}); f.control.close(); f.child.emit("exit",0); release({exit_code:0}); await tick(); assert.equal(f.control.stats.control_failure,false); assert.equal(f.replies.length,0);
});
test("malformed/truncated and oversized wire frames reject without task dispatch", async () => {
  for (const content of ["{\n", "x".repeat(65_537), '{"kind":"ready"}']) {
    const frames = new Frames(); const error = new Promise(resolve => frames.once("error", resolve)); frames.on("data", () => assert.fail("unexpected frame")); frames.end(content); assert.ok(await error);
  }
});
test("task concurrency is reserved before dispatch and total executions stop at sixteen", async () => {
  let calls = 0, release!: (value: unknown) => void;
  const f = fixture({ provider: "codex", execute: async () => { calls++; if (calls === 1) return new Promise(resolve => { release = resolve; }); return { exit_code: 0 }; } });
  try {
    await f.start(); f.send({ kind: "task", id: "one", arguments: {} }); f.send({ kind: "task", id: "two", arguments: {} }); await tick(); assert.equal(calls, 1); assert.equal(f.replies[0].result.error, "task_busy");
    release({ exit_code: 0 }); await tick();
    for (let i = 0; i < 16; i++) { f.send({ kind: "task", id: `call_${i}`, arguments: {} }); await tick(); }
    assert.equal(calls, 16); assert.equal(f.control.stats.task_calls, 16); assert.equal(f.replies.at(-1).result.error, "task_call_limit");
  } finally { f.control.close(); }
});
test("oversized task results are replaced by a bounded error", async () => {
  const f = fixture({ provider: "codex", execute: async () => ({ stdout: "x".repeat(48_001) }) });
  try { await f.start(); f.send({ kind: "task", id: "a", arguments: {} }); await tick(); assert.deepEqual(f.replies[0].result, { error: "task_output_limit" }); } finally { f.control.close(); }
});
test("provider and private/mixed DNS denial happens before opening a socket", async () => {
  let lookups = 0, sockets = 0;
  const f = fixture({ provider: "codex", resolveAddresses: async () => { lookups++; return ["8.8.8.8", "127.0.0.1"]; }, openSocket: () => { sockets++; throw Error("must not open"); } });
  try {
    await f.start(); for (const [i, authority] of ["example.com:443", "127.0.0.1:443", "auth.openai.com:80", "auth.openai.com:443"].entries()) f.send({ kind: "connect", id: `a${i}`, authority });
    await tick(); assert.equal(lookups, 1); assert.equal(sockets, 0); assert.equal(f.control.stats.denied, 4); assert.deepEqual(f.control.stats.network_errors, ["private_dns_answer"]);
  } finally { f.control.close(); }
});
test("canceled DNS cannot reopen a socket or take ownership of a reused id", async () => {
  const resolutions: ((addresses: string[]) => void)[] = []; let opened = 0;
  const f = fixture({ provider: "codex", resolveAddresses: () => new Promise(resolve => resolutions.push(resolve)), openSocket: () => { opened++; const socket = new EventEmitter(); return Object.assign(socket, { setTimeout() {}, destroy() { socket.emit("close"); }, pause() {}, resume() {} }) as unknown as Socket; } });
  try {
    await f.start(); f.send({ kind: "connect", id: "same", authority: "auth.openai.com:443" }); f.send({ kind: "close", id: "same" }); f.send({ kind: "connect", id: "same", authority: "auth.openai.com:443" });
    resolutions[0](["8.8.8.8"]); await tick(); assert.equal(opened, 0); resolutions[1](["8.8.8.8"]); await tick(); assert.equal(opened, 1);
  } finally { f.control.close(); }
});
test("sixteen pending DNS requests exhaust admission and shut down the relay", async () => {
  let lookups = 0; const f = fixture({ provider: "codex", resolveAddresses: async () => { lookups++; return new Promise(() => {}); } });
  try { await f.start(); for (let i = 0; i < 17; i++) f.send({ kind: "connect", id: `a${i}`, authority: "auth.openai.com:443" }); await tick(); assert.equal(lookups, 16); assert.equal(f.control.stats.control_failure, true); } finally { f.control.close(); }
});
test("cancel/reconnect flood cannot release unresolved DNS admission", async () => {
  let lookups = 0; const f = fixture({ provider: "codex", resolveAddresses: async () => { lookups++; return new Promise(() => {}); } });
  try { await f.start(); for (let i = 0; i < 20; i++) { f.send({ kind: "connect", id: `a${i}`, authority: "auth.openai.com:443" }); f.send({ kind: "close", id: `a${i}` }); } await tick(); assert.equal(lookups, 16); assert.equal(f.control.stats.control_failure, true); } finally { f.control.close(); }
});
test("unresolved DNS has a fail-closed deadline", async () => {
  const f = fixture({ provider: "codex", dnsTimeoutMs: 10, resolveAddresses: async () => new Promise(() => {}) });
  try { await f.start(); f.send({ kind: "connect", id: "a", authority: "auth.openai.com:443" }); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.control.stats.control_failure, true); } finally { f.control.close(); }
});
test("socket close or error releases inbound backpressure and future task frames", async () => {
  for (const event of ["close", "error"]) {
    const socket = Object.assign(new EventEmitter(), { setTimeout() {}, destroy() { socket.emit("close"); }, write() { return false; }, pause() {}, resume() {} }); let tasks = 0;
    const f = fixture({ provider: "codex", resolveAddresses: async () => ["8.8.8.8"], openSocket: () => socket as unknown as Socket, execute: async () => { tasks++; return { exit_code: 0 }; } });
    try { await f.start(); f.send({ kind: "connect", id: "a", authority: "auth.openai.com:443" }); await tick(); f.send({ kind: "data", id: "a", data: "YWJj" }); f.send({ kind: "task", id: "t", arguments: {} }); await tick(); assert.equal(tasks, 0); socket.emit(event, new Error("synthetic")); await tick(); assert.equal(tasks, 1); assert.equal(socket.listenerCount("drain"), 0); assert.equal(f.control.stats.control_failure, false); } finally { f.control.close(); }
  }
});
test("output drain ownership is bounded per socket and released on close, error or stop", async () => {
  for (const event of ["close", "error", "stop"]) {
    let resumes=0;
    const socket = Object.assign(new EventEmitter(), { setTimeout() {}, destroy() { socket.emit("close"); }, pause() {}, resume() {resumes++;} });
    const f = fixture({provider:"codex",resolveAddresses:async()=>["8.8.8.8"],openSocket:()=>socket as unknown as Socket},true);
    try {
      await f.start(); f.send({kind:"connect",id:"a",authority:"auth.openai.com:443"}); await tick();
      for(let i=0;i<10;i++)socket.emit("data",Buffer.alloc(24_576));
      assert.equal(f.child.stdin.listenerCount("drain"),1);
      if(event==="stop")f.control.close();else socket.emit(event,new Error("synthetic"));
      assert.equal(f.child.stdin.listenerCount("drain"),0); f.child.stdin.emit("drain"); assert.equal(resumes,0); assert.equal(f.control.stats.control_failure,false);
    } finally {f.control.close();}
  }
});
test("connection rejection stats retain only fixed reason codes and exclude attacker domains or error text", async () => {
  const canary="syntheticprivatecredentialmaterial";
  const f = fixture({provider:"codex",resolveAddresses:async()=>{throw new Error(canary);}});
  try {
    await f.start(); for (let i = 0; i < 100; i++) { f.send({ kind: "connect", id: `a${i}`, authority: `${canary}${i}.example:443` }); await tick(); }
    assert.equal(f.control.stats.denied, 100); assert.deepEqual(f.control.stats.denied_destinations, ["authority_denied"]);
    f.send({kind:"connect",id:"dns_error",authority:"auth.openai.com:443"}); await tick();
    assert.equal(f.control.stats.denied,101); assert.deepEqual(f.control.stats.denied_destinations,["authority_denied","dns_failure"]); assert.deepEqual(f.control.stats.network_errors,["dns_failure"]);
    const report=JSON.stringify(f.control.stats); assert.equal(report.includes(canary),false); assert.equal(report.includes(".example"),false); assert.equal(f.control.stats.control_failure, false);
  } finally { f.control.close(); }
});
test("a blocked output pipe has a hard queue bound even for rejected task requests", async () => {
  const f = fixture({ provider: "codex" }, true); try { await f.start(); for (let i = 0; i < 20_000; i++) f.send({ kind: "task", id: `a${i}`, arguments: {} }); await tick(); assert.equal(f.control.stats.control_failure, true); assert.ok(f.child.stdin.writableLength < 1_100_000); } finally { f.control.close(); }
});
