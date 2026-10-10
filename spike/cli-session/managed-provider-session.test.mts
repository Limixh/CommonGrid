import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ProviderFailure } from "../../packages/agent-adapters/src/session-protocol.ts";
import { boundedSessionOperation, claudeStatus, codexRpc, runCodexSessionProtocol, type CodexSessionOperation } from "./managed-provider-session.mts";

import { normalizeCodexQuota } from "@commongrid/agent-adapters";

function fixture(respond:(request:any)=>unknown|undefined) {
  const requests:any[]=[];let kills=0;
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){kills++;return true;}});
  child.stdin.on("data",chunk=>{for(const line of chunk.toString().trim().split("\n")){
    const request=JSON.parse(line);requests.push(request);
    if(request.id!==undefined){const response=respond(request);if(response!==undefined)queueMicrotask(()=>child.stdout.write(JSON.stringify({id:request.id,...(response as object)})+"\n"));}
  }});
  return {child:child as unknown as ChildProcessWithoutNullStreams,requests,get kills(){return kills;}};
}
const account={account:{type:"chatgpt",email:"private@example.test",id:"private"}};
const snapshot={rateLimits:{primary:{usedPercent:0,windowDurationMins:300,resetsAt:1_800_000_000},secondary:null,credits:{balance:"private"},limitId:"private"},accountId:"private",rateLimitsByLimitId:{private:{primary:{usedPercent:100,windowDurationMins:null,resetsAt:null,extra:"private"},secondary:null,credits:{balance:"private"}}}};

test("official readonly Codex quota performs initialize, account/read(false), rateLimits/read only",async()=>{
  const f=fixture(request=>({result:request.method==="initialize"?{}:request.method==="account/read"?account:snapshot}));
  (f.child.stderr as PassThrough).write("private@example.test Bearer private raw-provider-error\n");
  const result=await runCodexSessionProtocol(f.child,"quota");
  assert.deepEqual(f.requests.map(request=>request.method),["initialize","initialized","account/read","account/rateLimits/read"]);
  assert.deepEqual(f.requests[2].params,{refreshToken:false});assert.deepEqual(result,{quota_snapshot:normalizeCodexQuota(snapshot)});assert.equal(JSON.stringify(result).includes("private"),false);assert.ok(f.kills>=1);
});

test("official status and refresh account reads are distinct and return no account identity fields",async()=>{
  for(const operation of ["status","refresh"] as const){
    const f=fixture(request=>({result:request.method==="initialize"?{}:account}));
    const result=await runCodexSessionProtocol(f.child,operation);
    assert.deepEqual(f.requests.map(request=>request.method),["initialize","initialized","account/read"]);assert.equal(f.requests[2].params.refreshToken,operation==="refresh");
    assert.deepEqual(result,{authenticated:true,method:"chatgpt",refresh_requested:operation==="refresh",logout_verified:false});assert.ok(f.kills>=1);
  }
});

test("only method-not-found produces explicitly unknown quota, and no auth probe or retry follows",async()=>{
  const f=fixture(request=>request.method==="account/rateLimits/read"?{error:{code:-32601,message:"private raw-provider-text"}}:{result:request.method==="initialize"?{}:account});
  const result=await runCodexSessionProtocol(f.child,"quota");
  assert.deepEqual(result,{quota_snapshot:{state:"unknown",source:"official_codex_account_rate_limits_read",reason:"unsupported_method",windows:[]}});
  assert.equal(f.requests.length,4);assert.equal(JSON.stringify(result).includes("private"),false);assert.ok(f.kills>=1);
  const bad=fixture(request=>request.method==="account/rateLimits/read"?{error:{code:-32000,message:"unknown private method"}}:{result:request.method==="initialize"?{}:account});
  await assert.rejects(runCodexSessionProtocol(bad.child,"quota"),/managed_provider_unclassified/);
});

test("quota requires an authenticated ChatGPT account before any quota call",async()=>{
  for(const invalid of [{account:null},{account:{type:"apiKey",key:"private"}}]){
    const f=fixture(request=>({result:request.method==="initialize"?{}:invalid}));
    await assert.rejects(runCodexSessionProtocol(f.child,"quota"),/managed_provider_(auth_required|identity)/);
    assert.equal(f.requests.some(request=>request.method==="account/rateLimits/read"),false);assert.ok(f.kills>=1);
  }
});

test("malformed quota response is a protocol failure and destroys its transport",async()=>{
  const f=fixture(request=>({result:request.method==="initialize"?{}:request.method==="account/read"?account:{rateLimits:{primary:{usedPercent:Infinity}}}}));
  await assert.rejects(runCodexSessionProtocol(f.child,"quota"),/managed_provider_protocol/);assert.ok(f.kills>=1);
});

test("protocol callbacks and malformed response streams fail closed without executing provider tools",async()=>{
  for(const value of [{id:99,method:"item/tool/call",params:{tool:"private"}},{id:99,result:{}},[],{method:"error",params:{message:"private raw-provider-text"}}]){
    const f=fixture(()=>undefined),result=runCodexSessionProtocol(f.child,"status");
    (f.child.stdout as PassThrough).write(JSON.stringify(value)+"\n");
    await assert.rejects(result,/managed_provider_(protocol|unclassified)/);assert.ok(f.kills>=1);
  }
});

test("deadline and cancellation destroy the provider transport and remove signal listeners",async()=>{
  const before=[process.listenerCount("SIGINT"),process.listenerCount("SIGTERM")];
  for(const mode of ["deadline","cancel"]){
    const f=fixture(()=>undefined),controller=new AbortController();
    const result=runCodexSessionProtocol(f.child,"status",{signal:controller.signal,deadlineMs:20});
    if(mode==="cancel")controller.abort();
    await assert.rejects(result,new RegExp(`managed_provider_${mode==="cancel"?"canceled":"deadline"}`));assert.ok(f.kills>=1);
  }
  assert.deepEqual([process.listenerCount("SIGINT"),process.listenerCount("SIGTERM")],before);
});

test("a ten minute device-login allowance never extends an individual RPC past thirty seconds",async context=>{
  context.mock.timers.enable({apis:["setTimeout"]});
  const f=fixture(()=>undefined),result=runCodexSessionProtocol(f.child,"login");
  context.mock.timers.tick(29_999);assert.equal(f.kills,0);
  context.mock.timers.tick(1);await assert.rejects(result,/managed_provider_deadline/);assert.ok(f.kills>=1);
});

test("pre-cancellation and invalid deadline prevent all operation ownership checks and Docker spawning",async()=>{
  let calls=0;const runtime={verifyOperation:async()=>{calls++;throw Error("fixture_must_not_spawn");},beginNamespaceExec:async()=>{throw Error("fixture_must_not_journal");}};
  const controller=new AbortController();controller.abort();
  await assert.rejects(codexRpc(runtime,"status",{signal:controller.signal}),/managed_provider_canceled/);
  for(const deadlineMs of [0,-1,NaN,Infinity,1.5,30_001])await assert.rejects(codexRpc(runtime,"status",{deadlineMs}),/managed_session_deadline_invalid/);
  assert.equal(calls,0);
});

test("ownership verification and generic provider operations have bounded cancellation even if a fixture hangs",async()=>{
  let calls=0;
  await assert.rejects(codexRpc({verifyOperation:async()=>{calls++;return new Promise(()=>{});},beginNamespaceExec:async()=>{throw Error("fixture_must_not_journal");}},"status",{deadlineMs:10}),/managed_provider_deadline/);assert.equal(calls,1);
  await assert.rejects(boundedSessionOperation(async()=>new Promise(()=>{}),{deadlineMs:10}),/managed_provider_deadline/);
});

test("provider launch stops when its write-ahead exec intent cannot be persisted",async()=>{
  const calls:string[]=[];
  await assert.rejects(codexRpc({
    verifyOperation:async()=>{calls.push("verify");return "a".repeat(64);},
    beginNamespaceExec:async()=>{calls.push("journal");throw Error("managed_operation_journal_failed");},
  },"status"),/managed_operation_journal_failed/);
  assert.deepEqual(calls,["verify","journal"]);
});

test("Claude auth status uses only the official JSON status command and sanitizes identity",async()=>{
  const commands:string[][]=[];
  const runtime={exec:async(args:string[],timeout?:number,settings?:{signal?:AbortSignal;maxBytes?:number})=>{
    commands.push(args);assert.equal(timeout,15_000);assert.equal(settings?.maxBytes,262_144);assert.equal(settings?.signal?.aborted,false);
    return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod:"claude.ai",email:"private",organizationId:"private"}),stderr:"private"};
  }};
  assert.deepEqual(await claudeStatus(runtime,{requireLogin:true}),{authenticated:true,method:"claude.ai"});assert.deepEqual(commands,[["/opt/cg/claude","auth","status","--json"]]);
});

test("Claude status failure text stays out of errors and aborted status never dispatches",async()=>{
  let calls=0;const runtime={exec:async()=>{calls++;return {code:0,stdout:"private provider error",stderr:"private"};}};
  await assert.rejects(claudeStatus(runtime),/managed_provider_protocol/);
  const controller=new AbortController();controller.abort(new ProviderFailure("canceled"));
  await assert.rejects(claudeStatus(runtime,{signal:controller.signal}),/managed_provider_canceled/);assert.equal(calls,1);
});
