import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { ManagedCliRuntime, ManagedPreparationError, startBridge, validateManagedRuntimeAssets, type ManagedRuntimeAssets } from "../src/managed-runtime.ts";
import type { TaskToolsRuntime } from "../src/task-runtime.ts";

const image=`node:22@sha256:${"a".repeat(64)}`;
const digest=(bytes:string)=>createHash("sha256").update(bytes).digest("hex");
async function fixture(work:(assets:ManagedRuntimeAssets,directory:string)=>Promise<void>) {
  const directory=await mkdtemp(path.join(tmpdir(),"cg-product-runtime-"));
  const bridgeRoot=path.join(directory,"assets"),binaryPath=path.join(directory,"public-cli");
  await mkdir(bridgeRoot);
  await writeFile(binaryPath,"synthetic-public-cli");
  for(const file of ["runtime-bridge.mjs","tunnel-wire.mjs","mcp.mjs","task-broker.mjs"])await writeFile(path.join(bridgeRoot,file),"export {};\n");
  const binary={binaryPath,sha256:digest("synthetic-public-cli")};
  const assets:ManagedRuntimeAssets={baseImage:image,bridgeRoot,journalRoot:path.join(directory,"journal"),binaries:{claude:{...binary},codex:{...binary}}};
  try{await work(assets,directory);}finally{await rm(directory,{recursive:true,force:true});}
}

test("product runtime requires explicit absolute trusted assets and snapshots their values",async()=>{
  await fixture(async assets=>{
    const identity={owner:randomUUID(),provider:"claude" as const};
    assert.throws(()=>ManagedCliRuntime.restore(identity,undefined as any),/managed_runtime_assets_invalid/);
    for(const bad of [{...assets,journalRoot:".local"},{...assets,bridgeRoot:"relative"},{...assets,baseImage:"node:latest"},{...assets,binaries:{...assets.binaries,codex:{binaryPath:"codex",sha256:"a".repeat(64)}}},{...assets,argv:["secret"]}]) {
      assert.throws(()=>validateManagedRuntimeAssets(bad as ManagedRuntimeAssets),/managed_runtime_assets_invalid/);
    }
    const snapshot=validateManagedRuntimeAssets(assets),hash=snapshot.binaries.claude.sha256;
    assets.binaries.claude.sha256="b".repeat(64);
    assert.equal(snapshot.binaries.claude.sha256,hash);
    assert.ok(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.binaries)&&Object.isFrozen(snapshot.binaries.claude));
    const runtime=ManagedCliRuntime.restore(identity,{assets});
    assert.equal("installCodexCodingProfile" in runtime,false);
    assert.equal(runtime.leaseIdentity(),undefined);assert.equal(runtime.journalSnapshot(),undefined);
  });
});

test("missing bridge or invalid binary digest fails before a journal or daemon mutation",async()=>{
  await fixture(async(assets,directory)=>{
    let mutations=0;
    const begin=ManagedCliRuntime.prototype.beginOperation;
    ManagedCliRuntime.prototype.beginOperation=async()=>{mutations++;throw Error("unexpected_mutation");};
    try{
      await assert.rejects(()=>ManagedCliRuntime.prepare("claude",{assets:{...assets,binaries:{...assets.binaries,claude:{...assets.binaries.claude,sha256:"b".repeat(64)}}}}),error=>{
        assert.ok(error instanceof ManagedPreparationError);assert.equal(error.cleanupVerified,true);assert.equal(error.message,"managed_binary_digest_invalid");return true;
      });
      await rm(path.join(assets.bridgeRoot,"task-broker.mjs"));
      await assert.rejects(()=>ManagedCliRuntime.prepare("codex",{assets}),error=>{
        assert.ok(error instanceof ManagedPreparationError);assert.equal(error.cleanupVerified,true);assert.equal(error.message,"managed_runtime_asset_unavailable");return true;
      });
      assert.equal(mutations,0);assert.ok(!(await readdir(directory)).includes("journal"));
    }finally{ManagedCliRuntime.prototype.beginOperation=begin;}
  });
});

test("failed preparation reports only verified independent cleanup and retains cleanup uncertainty",async()=>{
  await fixture(async assets=>{
    const begin=ManagedCliRuntime.prototype.beginOperation,destroy=ManagedCliRuntime.prototype.destroy;
    const controller=new AbortController();let cleanupCalls=0,failCleanup=false;
    ManagedCliRuntime.prototype.beginOperation=async()=>{controller.abort();throw Error("synthetic_prepare_failed");};
    ManagedCliRuntime.prototype.destroy=async options=>{
      cleanupCalls++;assert.ok(options?.signal);assert.notEqual(options.signal,controller.signal);assert.equal(options.signal.aborted,false);
      if(failCleanup)throw Error("synthetic_cleanup_uncertain");
    };
    try{
      await assert.rejects(()=>ManagedCliRuntime.prepare("claude",{assets,signal:controller.signal}),error=>{
        assert.ok(error instanceof ManagedPreparationError);assert.equal(error.cleanupVerified,true);assert.equal(error.message,"synthetic_prepare_failed");return true;
      });
      failCleanup=true;
      await assert.rejects(()=>ManagedCliRuntime.prepare("codex",{assets}),error=>{
        assert.ok(error instanceof ManagedPreparationError);assert.equal(error.cleanupVerified,false);assert.equal(error.message,"managed_prepare_cleanup_unconfirmed");return true;
      });
      assert.equal(cleanupCalls,2);
    }finally{ManagedCliRuntime.prototype.beginOperation=begin;ManagedCliRuntime.prototype.destroy=destroy;}
  });
});

test("signal-enabled Claude bridge close waits for the aborted task callback to finish cleanup", async () => {
  const controller = new AbortController();
  let started!: () => void, finishCleanup!: () => void, commandAborted = false, active = false;
  const began = new Promise<void>(resolve => { started = resolve; });
  const task = {async exec(_argv: string[], options: {signal?: AbortSignal} = {}) {
    active = true;
    return new Promise((resolve, reject) => {
      finishCleanup = () => { active = false; reject(new Error("fixture_task_cancelled")); };
      options.signal?.addEventListener("abort", () => { commandAborted = true; }, {once: true});
      started();
    });
  }} as unknown as TaskToolsRuntime;
  const child = Object.assign(new EventEmitter(), {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { setImmediate(() => child.emit("close", 0)); return true; }});
  const runtime = {provider: "claude", async retainOperation() { return () => {}; }, async verifyOperation() { return "a".repeat(64); },
    async beginNamespaceExec() { return randomUUID(); }} as unknown as ManagedCliRuntime;
  const originalSpawn = childProcess.spawn;
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    childProcess.spawn = ((command, args) => {
      assert.equal(command, "docker"); assert.ok(Array.isArray(args) && args.includes("/opt/cg/runtime-bridge.mjs"));
      setImmediate(() => child.stdout.write('{"kind":"ready"}\n')); return child as never;
    }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    bridge = await startBridge(runtime, task, controller.signal);
  } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
  try {
    child.stdout.write(JSON.stringify({kind: "task", id: "task-1", arguments: {argv: ["node", "slow-task-fixture"], timeout_ms: 30000}}) + "\n");
    await began; controller.abort("cancelled");
    let closed = false;
    const closing = Promise.resolve(bridge.close()).then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(commandAborted, true, "bridge callback must propagate the operation abort to task execution");
    assert.equal(closed, false, "close must await asynchronous task namespace cleanup");
    assert.equal(active, true);
    finishCleanup(); await closing;
    assert.equal(active, false); assert.equal(bridge.stats.task_calls, 1); assert.equal(bridge.stats.control_failure, false);
  } finally { finishCleanup?.(); await bridge.close(); }
});

test("existing bridge callers without a signal retain synchronous close", async () => {
  const child = Object.assign(new EventEmitter(), {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { setImmediate(() => child.emit("close", 0)); return true; }});
  const runtime = {provider: "codex", async retainOperation() { return () => {}; }, async verifyOperation() { return "a".repeat(64); },
    async beginNamespaceExec() { return randomUUID(); }} as unknown as ManagedCliRuntime;
  const originalSpawn = childProcess.spawn;
  try {
    childProcess.spawn = (() => { setImmediate(() => child.stdout.write('{"kind":"ready"}\n')); return child as never; }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    const bridge = await startBridge(runtime);
    assert.equal(bridge.close(), undefined);
  } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
});
