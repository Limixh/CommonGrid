import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DockerCommandError } from "../../packages/agent-adapters/src/task-runtime.ts";
import { ManagedCliRuntime, assertManagedContainerFence, removeManagedContainer, removeManagedOperationContainer, type ManagedContainerEvidence } from "./managed-runtime.mts";

const owner = randomUUID(), operation = randomUUID(), id = "a".repeat(64);
const evidence = (changes: Partial<ManagedContainerEvidence> = {}): ManagedContainerEvidence => ({id,owner,operation,running:false,status:"exited",...changes});
test("same profile restoration generates a distinct operation fence", () => {
  const first=ManagedCliRuntime.restore({owner,provider:"codex"}), second=ManagedCliRuntime.restore(first.identity());
  assert.deepEqual(first.identity(),second.identity()); assert.notEqual(first.operationIdentity().operation,second.operationIdentity().operation); assert.equal(first.container,second.container);
});
test("invalid ownership evidence and mismatched owner/operation never reach removal", async () => {
  for(const value of [null,{},evidence({id:"mutable-name"}),evidence({owner:randomUUID()}),evidence({operation:randomUUID()}),{...evidence(),env:{secret:"synthetic"}},evidence({running:"false" as any})]) {
    let calls=0; await assert.rejects(()=>removeManagedContainer(value,owner,operation,false,async()=>{calls++;return "";})); assert.equal(calls,0);
  }
});
test("reference recovery rejects running, paused, restarting and removal states", async () => {
  for(const value of [evidence({running:true,status:"running"}),evidence({running:false,status:"restarting"}),evidence({running:false,status:"paused"}),evidence({running:false,status:"removing"})]) {
    let calls=0; await assert.rejects(()=>removeManagedContainer(value,owner,operation,true,async()=>{calls++;return "";})); assert.equal(calls,0);
  }
});
test("reference recovery targets the verified immutable ID and never forces or touches volumes", async () => {
  const commands:string[][]=[]; await removeManagedContainer(evidence(),owner,operation,true,async args=>{commands.push(args);return "";});
  assert.deepEqual(commands[0],["rm",id]); assert.ok(commands[1].includes(`id=${id}`)); assert.ok(commands.every(args=>!args.includes("volume")&&!args.includes("--force")&&!args.includes("prune")));
});
test("stopped-to-running race is rejected by non-forced Docker removal", async () => {
  const commands:string[][]=[]; await assert.rejects(()=>removeManagedContainer(evidence(),owner,operation,true,async args=>{commands.push(args);throw new Error("managed_docker_failed");}));
  assert.deepEqual(commands,[["rm",id]]);
});
test("normal cleanup targets the inspected ID despite mutable name replacement", async () => {
  const commands:string[][]=[]; await removeManagedContainer(evidence({running:true,status:"running"}),owner,operation,false,async args=>{commands.push(args);return "";});
  assert.deepEqual(commands[0],["rm","--force",id]); assert.ok(commands[1].includes(`id=${id}`));
});
test("cleanup cannot be reported confirmed while the removed ID remains listed", async () => {
  let calls=0; await assert.rejects(()=>removeManagedContainer(evidence(),owner,operation,true,async()=>++calls===1?"":id),/managed_cleanup_unconfirmed/); assert.equal(calls,2);
});
test("recovery operation must be an explicit valid identity and state proof", () => {
  assert.throws(()=>assertManagedContainerFence(evidence(),owner,"pid-123",true));
  assert.throws(()=>assertManagedContainerFence(evidence(),owner,undefined,true), /managed_recovery_operation_required/);
  assert.doesNotThrow(()=>assertManagedContainerFence(evidence({status:"created"}),owner,operation,true));
  assert.doesNotThrow(()=>assertManagedContainerFence(evidence({status:"dead"}),owner,operation,true));
});

test("interrupted exec cleanup removes only its captured immutable ID", async () => {
  const commands: string[][] = [];
  await removeManagedOperationContainer(id, owner, operation, async args => {
    commands.push(args);
    if (args[0] === "inspect") return JSON.stringify(evidence({running:true,status:"running"}));
    return commands.length === 1 ? id : "";
  });
  assert.equal(commands.length, 4);
  assert.equal(commands[1].at(-1), id);
  assert.deepEqual(commands[2], ["rm", "--force", id]);
  assert.ok(commands.every(args => !args.some(arg => arg.startsWith("name=") || arg.startsWith("cg-managed-"))));
});

test("a replacement survives old exec cleanup when its captured ID is absent", async () => {
  const replacementId = "b".repeat(64), commands: string[][] = [];
  await removeManagedOperationContainer(id, owner, operation, async args => { commands.push(args); return replacementId; });
  assert.equal(commands.length, 1);
  assert.ok(commands[0].includes(`id=${id}`));
});

test("captured-ID cleanup rejects substituted ID and foreign operation before deletion", async () => {
  for (const value of [evidence({id:"b".repeat(64)}), evidence({operation:randomUUID()}), evidence({owner:randomUUID()})]) {
    const commands: string[][] = [];
    await assert.rejects(() => removeManagedOperationContainer(id, owner, operation, async args => { commands.push(args); return args[0] === "inspect" ? JSON.stringify(value) : id; }));
    assert.equal(commands.length, 2);
    assert.ok(!commands.some(args => args[0] === "rm"));
  }
});

test("captured-ID cleanup validates identities before any command", async () => {
  for (const identities of [["mutable-name", owner, operation], [id, "wrong-owner", operation], [id, owner, "wrong-operation"]]) {
    let calls = 0;
    await assert.rejects(() => removeManagedOperationContainer(identities[0], identities[1], identities[2], async () => { calls++; return ""; }));
    assert.equal(calls, 0);
  }
});

test("pre-aborted start, stop and exec do not dispatch a command", async () => {
  const runtime = ManagedCliRuntime.restore({owner, provider:"codex"}), cancellation = new AbortController();
  let calls = 0;
  (runtime as any).command = async () => { calls++; throw new Error("unexpected_dispatch"); };
  cancellation.abort();
  await assert.rejects(() => runtime.start({signal:cancellation.signal}), /docker_cancelled/);
  await assert.rejects(() => runtime.stop(false, {signal:cancellation.signal}), /docker_cancelled/);
  await assert.rejects(() => runtime.exec(["node", "-e", ""], 1000, {signal:cancellation.signal}), /docker_cancelled/);
  assert.equal(calls, 0);
});

test("cancelled create reconciles owned ID with a fresh signal and retains volumes", async () => {
  const runtime = ManagedCliRuntime.restore({owner, provider:"codex"}), cancellation = new AbortController();
  let exists = false;
  const commands: string[][] = [], cleanupSignals: AbortSignal[] = [];
  (runtime as any).command = async (args: string[], options: {signal?:AbortSignal}) => {
    commands.push(args);
    if (args[0] === "volume") return owner;
    if (args[0] === "create") { exists = true; cancellation.abort(); throw new DockerCommandError("cancelled"); }
    if (cancellation.signal.aborted) { assert.ok(options.signal && options.signal !== cancellation.signal && !options.signal.aborted); cleanupSignals.push(options.signal); }
    if (args[0] === "inspect") return JSON.stringify(evidence({operation:runtime.operationIdentity().operation,status:"created"}));
    if (args[0] === "rm") { assert.deepEqual(args,["rm","--force",id]); exists = false; return ""; }
    if (args.includes(`name=^/${runtime.container}$`)) return exists ? runtime.container : "";
    return "";
  };
  await assert.rejects(() => runtime.start({signal:cancellation.signal}), /docker_cancelled/);
  assert.equal(exists, false); assert.ok(cleanupSignals.length > 0);
  assert.ok(commands.some(args => args[0] === "rm"));
  assert.ok(!commands.some(args => args[0] === "volume" && args[1] === "rm"));
  await runtime.stop(false, {signal:new AbortController().signal});
});

test("lost create ID stays unconfirmed while absent, then resolves only on owned evidence", async () => {
  const runtime = ManagedCliRuntime.restore({owner, provider:"codex"}), cancellation = new AbortController();
  let lateCreate = false;
  const removed: string[][] = [];
  (runtime as any).command = async (args: string[]) => {
    if (args[0] === "volume") return owner;
    if (args[0] === "create") { cancellation.abort(); throw new DockerCommandError("cancelled"); }
    if (args[0] === "inspect") return JSON.stringify(evidence({operation:runtime.operationIdentity().operation,status:"created"}));
    if (args[0] === "rm") { removed.push(args); lateCreate = false; return ""; }
    return args.includes(`name=^/${runtime.container}$`) && lateCreate ? runtime.container : "";
  };
  await assert.rejects(() => runtime.start({signal:cancellation.signal}), /managed_start_cleanup_unconfirmed/);
  await assert.rejects(() => runtime.stop(), /managed_cleanup_unconfirmed/);
  await assert.rejects(() => runtime.start(), /managed_cleanup_unconfirmed/);
  assert.equal(removed.length, 0);
  lateCreate = true; await runtime.stop();
  assert.deepEqual(removed, [["rm","--force",id]]);
});

test("stop cancellation after removal cannot report confirmed cleanup", async () => {
  const cancellation = new AbortController(), commands: string[][] = [];
  await assert.rejects(() => removeManagedContainer(evidence(), owner, operation, false, async args => {
    commands.push(args); cancellation.abort(); return "";
  }, {signal:cancellation.signal}), /docker_cancelled/);
  assert.deepEqual(commands, [["rm", "--force", id]]);
});

test("start refuses an existing same-operation namespace without cleanup", async () => {
  const runtime = ManagedCliRuntime.restore({owner,provider:"codex"}), commands: string[][] = [];
  (runtime as any).command = async (args: string[]) => { commands.push(args); return args[0] === "volume" ? owner : runtime.container; };
  await assert.rejects(() => runtime.start(), /managed_profile_busy/);
  assert.ok(!commands.some(args => args[0] === "create" || args[0] === "rm"));
});
