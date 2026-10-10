import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { codexRpc, runCodexSessionProtocol, type DeviceChallenge } from "../src/provider-session.ts";
import { ProviderFailure } from "../src/session-protocol.ts";

const device = {type:"chatgptDeviceCode", loginId:"fixture-login", verificationUrl:"https://auth.openai.com/codex/device", userCode:"ABCD-1234", privateField:"PRIVATE_EXTRA"};
const account = {account:{type:"chatgpt", email:"PRIVATE_IDENTITY"}};

function fixture(challenge:unknown=device, complete=true) {
  const requests:Record<string,any>[]=[];
  let kills=0;
  const child=Object.assign(new EventEmitter(),{
    stdin:new PassThrough(), stdout:new PassThrough(), stderr:new PassThrough(),
    kill(){kills++;return true;},
  });
  child.stdin.on("data",chunk=>{
    for(const line of chunk.toString().trim().split("\n")) {
      const request=JSON.parse(line);requests.push(request);
      if(request.id===undefined)continue;
      const result=request.method==="account/login/start"?challenge:request.method==="account/read"?
        (requests.some(item=>item.method==="account/logout")?{account:null}:account):
        request.method==="account/rateLimits/read"?{rateLimits:{primary:null,secondary:null}}:{};
      queueMicrotask(()=>{
        child.stdout.write(JSON.stringify({id:request.id,result})+"\n");
        if(request.method==="account/login/start"&&complete)child.stdout.write(JSON.stringify({method:"account/login/completed",params:{loginId:"fixture-login",success:true}})+"\n");
      });
    }
  });
  return {child:child as unknown as ChildProcessWithoutNullStreams,requests,get kills(){return kills;}};
}

test("product device login emits only the validated transient challenge through an explicit callback",async context=>{
  const logs=[context.mock.method(console,"log",()=>{}),context.mock.method(console,"error",()=>{}),context.mock.method(console,"warn",()=>{})];
  const f=fixture();const challenges:Readonly<DeviceChallenge>[]=[];
  const result=await runCodexSessionProtocol(f.child,"login",{onDeviceChallenge:async challenge=>{
    await Promise.resolve();challenges.push(challenge);assert.equal(Object.isFrozen(challenge),true);
    assert.equal(f.requests.some(request=>request.method==="account/read"),false);
  }});
  assert.deepEqual(challenges,[{verification_url:device.verificationUrl,user_code:device.userCode}]);
  assert.deepEqual(result,{authenticated:true,method:"chatgpt",refresh_requested:false,logout_verified:false});
  assert.equal(JSON.stringify(result).includes(device.userCode),false);
  assert.equal(JSON.stringify(result).includes("PRIVATE"),false);
  assert.deepEqual(f.requests.map(request=>request.method),["initialize","initialized","account/login/start","account/read"]);
  assert.ok(logs.every(log=>log.mock.callCount()===0));assert.ok(f.kills>=1);
});

test("product login is silent by default and status operations never invoke device UI",async context=>{
  const logs=[context.mock.method(console,"log",()=>{}),context.mock.method(console,"error",()=>{}),context.mock.method(console,"warn",()=>{})];
  await runCodexSessionProtocol(fixture().child,"login");
  let callbacks=0;
  for(const operation of ["status","refresh","logout","quota"] as const) {
    const f=fixture();
    await runCodexSessionProtocol(f.child,operation,{onDeviceChallenge:()=>{callbacks++;}});
  }
  assert.equal(callbacks,0);assert.ok(logs.every(log=>log.mock.callCount()===0));
});

test("device URL, code and login identity validate before invoking user interaction",async()=>{
  const invalid=[
    {...device,verificationUrl:"https://auth.openai.com.evil.test/codex/device"},
    {...device,verificationUrl:"https://auth.openai.com/codex/device?code=PRIVATE"},
    {...device,verificationUrl:"http://auth.openai.com/codex/device"},
    {...device,userCode:"abc-def"}, {...device,userCode:"ABC\n123"},
    {...device,userCode:"ABC"}, {...device,userCode:"A".repeat(33)},
    {...device,userCode:null}, {...device,loginId:""}, {...device,type:"chatgpt"},
  ];
  for(const challenge of invalid) {
    const f=fixture(challenge,false);let callbacks=0;
    await assert.rejects(runCodexSessionProtocol(f.child,"login",{onDeviceChallenge:()=>{callbacks++;}}),/managed_provider_protocol/);
    assert.equal(callbacks,0);assert.equal(f.requests.some(request=>request.method==="account/read"),false);assert.ok(f.kills>=1);
  }
});

test("synchronous and asynchronous challenge callback errors are sanitized and stop login",async context=>{
  const log=context.mock.method(console,"error",()=>{});
  for(const callback of [()=>{throw Error("PRIVATE_UI_ERROR ABCD-1234");},async()=>{throw Error("PRIVATE_UI_ERROR ABCD-1234");}]) {
    const f=fixture();
    await assert.rejects(runCodexSessionProtocol(f.child,"login",{onDeviceChallenge:callback}),error=>{
      assert.ok(error instanceof ProviderFailure);assert.equal(error.message,"managed_provider_protocol");
      assert.equal(error.cause,undefined);return true;
    });
    assert.equal(f.requests.some(request=>request.method==="account/read"),false);assert.ok(f.kills>=1);
  }
  assert.equal(log.mock.callCount(),0);
});

test("cancel while displaying a device challenge terminates transport and restores process listeners",async()=>{
  const before=[process.listenerCount("SIGINT"),process.listenerCount("SIGTERM")];
  const f=fixture(device,false),controller=new AbortController();
  await assert.rejects(runCodexSessionProtocol(f.child,"login",{signal:controller.signal,onDeviceChallenge:()=>{
    controller.abort(Error("PRIVATE_CANCEL_REASON"));return new Promise<void>(()=>{});
  }}),/managed_provider_canceled/);
  assert.equal(f.requests.some(request=>request.method==="account/read"),false);assert.ok(f.kills>=1);
  assert.deepEqual([process.listenerCount("SIGINT"),process.listenerCount("SIGTERM")],before);
});

test("hanging device UI is bounded by the login deadline",async context=>{
  context.mock.timers.enable({apis:["setTimeout"]});
  const f=fixture(device,false);let displayed!:()=>void;
  const started=new Promise<void>(resolve=>{displayed=resolve;});
  const pending=runCodexSessionProtocol(f.child,"login",{deadlineMs:50,onDeviceChallenge:()=>{displayed();return new Promise<void>(()=>{});}});
  await started;context.mock.timers.tick(50);
  await assert.rejects(pending,/managed_provider_deadline/);assert.ok(f.kills>=1);
});

test("pre-cancelled or invalid callback options never dispatch or display a challenge",async()=>{
  const controller=new AbortController();controller.abort();
  const f=fixture();let callbacks=0;
  await assert.rejects(runCodexSessionProtocol(f.child,"login",{signal:controller.signal,onDeviceChallenge:()=>{callbacks++;}}),/managed_provider_canceled/);
  assert.equal(f.requests.length,0);assert.equal(callbacks,0);
  let checks=0;
  const runtime={verifyOperation:async()=>{checks++;throw Error("NO_SPAWN");},beginNamespaceExec:async()=>{throw Error("NO_JOURNAL");}};
  await assert.rejects(codexRpc(runtime,"login",{onDeviceChallenge:"PRIVATE_INVALID" as unknown as ()=>void}),/managed_session_callback_invalid/);
  assert.equal(checks,0);
});
