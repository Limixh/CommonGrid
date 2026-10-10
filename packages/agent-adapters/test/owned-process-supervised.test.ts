import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CommandError, runOwnedCommand } from "../src/owned-process.ts";

test("native POSIX supervision keeps children in its group and cancellation never kills an unowned group",async()=>{
  const platform=Object.getOwnPropertyDescriptor(process,"platform")!;
  const spawn=childProcess.spawn,kill=process.kill,previous=process.env.CG_NATIVE_SUPERVISED;
  const child=new EventEmitter() as any;
  child.pid=42;child.exitCode=null;child.signalCode=null;
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=null;
  let rootKills=0,groupKills=0,spawnCalls=0;
  child.kill=()=>{rootKills++;child.signalCode="SIGKILL";child.emit("exit",null,"SIGKILL");child.emit("close",null,"SIGKILL");return true;};
  Object.defineProperty(process,"platform",{...platform,value:"linux"});
  process.env.CG_NATIVE_SUPERVISED="1";
  childProcess.spawn=((command:any,args:any,options:any)=>{
    spawnCalls++;assert.equal(command,"trusted-fixture");assert.deepEqual(args,["fixed"]);assert.equal(options.detached,false);assert.equal(options.windowsHide,true);return child;
  }) as typeof childProcess.spawn;
  process.kill=((pid:number)=>{if(pid<0)groupKills++;throw Error("unowned_group");}) as typeof process.kill;
  syncBuiltinESMExports();
  try{
    const controller=new AbortController();let failure:CommandError|undefined;
    const running=runOwnedCommand("trusted-fixture",["fixed"],{signal:controller.signal});
    controller.abort();
    await assert.rejects(running,error=>{assert.ok(error instanceof CommandError);failure=error;return true;});
    assert.deepEqual(await failure!.cleanup,{method:"owned_root_handle",status:"unconfirmed"});
    assert.equal(rootKills,1);assert.equal(groupKills,0);assert.equal(spawnCalls,1);
  }finally{
    childProcess.spawn=spawn;process.kill=kill;Object.defineProperty(process,"platform",platform);
    if(previous===undefined)delete process.env.CG_NATIVE_SUPERVISED;else process.env.CG_NATIVE_SUPERVISED=previous;
    syncBuiltinESMExports();child.stdout.destroy();child.stderr.destroy();
  }
});
