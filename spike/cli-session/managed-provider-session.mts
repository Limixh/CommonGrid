// Import-safe official provider session operations. No credential files are read.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ManagedCliRuntime } from "./managed-runtime.mts";
import { BoundedJsonInput, BoundedJsonLines, LoginCompletion, ProviderFailure, RpcLifecycle, classifyProviderFailure, isRecord, validRpcId, validateClaudeStatus, validateCodexIdentity } from "../../packages/agent-adapters/src/session-protocol.ts";

import { normalizeCodexQuota, sanitizeQuotaObservation } from "@commongrid/agent-adapters";

export interface ProviderSessionOptions { signal?: AbortSignal; deadlineMs?: number }
const assertSignal=(signal?:AbortSignal)=>{if(signal?.aborted)throw signal.reason instanceof ProviderFailure?signal.reason:new ProviderFailure("canceled");};
const sessionDeadline=(options:ProviderSessionOptions,login=false)=>{
  const value=options.deadlineMs??(login?600_000:30_000);
  if(!Number.isSafeInteger(value)||value<1||value>(login?600_000:30_000))throw new Error("managed_session_deadline_invalid");
  return value;
};
export async function boundedSessionOperation<T>(operation:(signal:AbortSignal)=>Promise<T>,options:ProviderSessionOptions={},login=false):Promise<T> {
  const deadline=sessionDeadline(options,login),controller=new AbortController();
  const externalAbort=()=>controller.abort(options.signal?.reason instanceof ProviderFailure?options.signal.reason:new ProviderFailure("canceled"));
  options.signal?.addEventListener("abort",externalAbort,{once:true});if(options.signal?.aborted)externalAbort();
  const timer=setTimeout(()=>controller.abort(new ProviderFailure("deadline")),deadline);
  let onAbort!:()=>void;
  const interrupted=new Promise<never>((_resolve,reject)=>{onAbort=()=>reject(controller.signal.reason);controller.signal.addEventListener("abort",onAbort,{once:true});});
  try{assertSignal(controller.signal);return await Promise.race([Promise.resolve().then(()=>{assertSignal(controller.signal);return operation(controller.signal);}),interrupted]);}
  finally{clearTimeout(timer);controller.signal.removeEventListener("abort",onAbort);options.signal?.removeEventListener("abort",externalAbort);}
}
export async function claudeStatus(runtime: Pick<ManagedCliRuntime,"exec">,options:ProviderSessionOptions & {requireLogin?:boolean;requireLogout?:boolean}={}) {
  return boundedSessionOperation(async signal=>{
    const status=await runtime.exec(["/opt/cg/claude","auth","status","--json"],options.deadlineMs??15_000,{signal,maxBytes:262_144});
    assertSignal(signal);return validateClaudeStatus(status.stdout,status.code,options.requireLogin,options.requireLogout);
  },{...options,deadlineMs:options.deadlineMs??15_000});
}
export async function claudeInteractiveLogin(runtime:Pick<ManagedCliRuntime,"verifyOperation"|"exec">,options:ProviderSessionOptions={}) {
  if(!process.stdin.isTTY)throw new Error("claude_login_requires_user_terminal");
  await boundedSessionOperation(async signal=>{
    const containerId=await runtime.verifyOperation({signal});assertSignal(signal);
    const child=spawn("docker",["exec","-it",containerId,"/opt/cg/claude","auth","login","--claudeai"],{windowsHide:true,stdio:"inherit"});
    let onAbort!:()=>void;
    try{await new Promise<void>((resolve,reject)=>{
      onAbort=()=>{child.kill();reject(signal.reason instanceof ProviderFailure?signal.reason:new ProviderFailure("canceled"));};
      signal.addEventListener("abort",onAbort,{once:true});if(signal.aborted)onAbort();
      child.on("error",()=>reject(new ProviderFailure("process")));
      child.on("close",code=>code===0?resolve():reject(new ProviderFailure("auth_required")));
    });}finally{signal.removeEventListener("abort",onAbort);child.kill();}
  },options,true);
  return claudeStatus(runtime,{signal:options.signal,requireLogin:true});
}
export type CodexSessionOperation="status"|"refresh"|"logout"|"login"|"quota";
export async function codexRpc(runtime: Pick<ManagedCliRuntime,"verifyOperation">, operation: CodexSessionOperation,options:ProviderSessionOptions={}) {
  if(!["status","refresh","logout","login","quota"].includes(operation))throw new Error("managed_session_operation_invalid");
  return boundedSessionOperation(async signal=>{
    const containerId=await runtime.verifyOperation({signal});assertSignal(signal);
    const child=spawn("docker",["exec","-i",containerId,"/opt/cg/codex","app-server","--listen","stdio://","-c",'cli_auth_credentials_store="file"',"-c",'model_provider="openai"'],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
    return runCodexSessionProtocol(child,operation,{...options,signal});
  },options,operation==="login");
}
// Stream-only seam for deterministic protocol fixtures; production callers
// always obtain an immutable, operation-owned container ID in codexRpc first.
export async function runCodexSessionProtocol(child:ChildProcessWithoutNullStreams,operation:CodexSessionOperation,options:ProviderSessionOptions={}) {
  const deadline=sessionDeadline(options,operation==="login");
  const rpc=new RpcLifecycle(line=>child.stdin.write(line),deadline,()=>{child.stdin.end();child.kill();});
  const cancel=()=>rpc.fail(new ProviderFailure("canceled"));process.on("SIGINT",cancel);process.on("SIGTERM",cancel);
  const abort=()=>rpc.fail(options.signal?.reason instanceof ProviderFailure?options.signal.reason:new ProviderFailure("canceled"));options.signal?.addEventListener("abort",abort,{once:true});
  if(options.signal?.aborted)abort();
  const decoder=new BoundedJsonLines(2_097_152,262_144),login=new LoginCompletion();
  child.on("error",()=>rpc.fail(new ProviderFailure("process")));child.on("close",()=>rpc.processExit());child.stdin.on("error",()=>rpc.fail(new ProviderFailure("process")));child.stdout.on("error",()=>rpc.fail(new ProviderFailure("process")));child.stderr.on("data",()=>{});
  const input=new BoundedJsonInput(2_097_152,262_144);input.on("error",()=>rpc.fail(new ProviderFailure("protocol")));
  const lines=createInterface({input,crlfDelay:Infinity});child.stdout.pipe(input);
  lines.on("error",()=>rpc.fail(new ProviderFailure("protocol")));
  lines.on("line",line=>{
    try {
      const event=decoder.decode(line);
      if(rpc.response(event))return;
      if(typeof event.method!=="string"||!event.method||!isRecord(event.params))throw new ProviderFailure("protocol");
      if(Object.hasOwn(event,"id")) {
        if(!validRpcId(event.id))throw new ProviderFailure("protocol");
        child.stdin.write(JSON.stringify({id:event.id,error:{code:-32601,message:"No callbacks in auth command"}})+"\n");
        throw new ProviderFailure("protocol");
      }
      if(event.method==="account/login/completed") {
        if(operation!=="login")throw new ProviderFailure("protocol");
        login.receive(event.params);
      }
      if(event.method==="error")throw new ProviderFailure(classifyProviderFailure(event.params.error??event.params));
    }catch(error){rpc.fail(error instanceof ProviderFailure?error:new ProviderFailure("protocol"));}
  });
  // A device login may wait ten minutes for its completion notification, but
  // every individual RPC is still bounded to thirty seconds.
  const request=async(method:string,params:unknown)=>{
    const timer=setTimeout(()=>rpc.fail(new ProviderFailure("deadline")),Math.min(deadline,30_000));
    try{return await rpc.request(method,params);}finally{clearTimeout(timer);}
  };
  try {
    await request("initialize",{clientInfo:{name:"commongrid_managed_auth_spike",version:"0.1.0"},capabilities:{experimentalApi:true}});
    child.stdin.write(JSON.stringify({method:"initialized"})+"\n");
    if(operation === "logout")await request("account/logout",{});
    if(operation === "login") {
      const reply=await request("account/login/start",{type:"chatgptDeviceCode"});
      if(!isRecord(reply)||reply.type!=="chatgptDeviceCode"||reply.verificationUrl!=="https://auth.openai.com/codex/device"||typeof reply.userCode!=="string"||!/^[A-Z0-9-]{4,32}$/.test(reply.userCode))throw new ProviderFailure("protocol");
      login.bind(reply.loginId);
      // Short-lived device code is displayed only, never in report/state files.
      console.log(`Open ${reply.verificationUrl} and enter ${reply.userCode}. Approve only your own login. Waiting up to 10 minutes.`);
      await Promise.race([login.done,rpc.done]);rpc.assertHealthy();
    }
    const account=await request("account/read",{refreshToken:operation === "refresh"});
    const identity=validateCodexIdentity(account,operation==="quota"?"login":operation);
    if(operation==="quota"){
      try{const quota=normalizeCodexQuota(await request("account/rateLimits/read",{}));rpc.finish();return {quota_snapshot:quota};}
      catch(error){if(error instanceof ProviderFailure&&error.category==="unsupported")return {quota_snapshot:{state:"unknown",source:"official_codex_account_rate_limits_read",reason:"unsupported_method",windows:[]}};throw error;}
    }
    rpc.finish();
    return {...identity,refresh_requested:operation === "refresh",logout_verified:operation === "logout"};
  }finally{options.signal?.removeEventListener("abort",abort);process.off("SIGINT",cancel);process.off("SIGTERM",cancel);rpc.dispose();lines.close();child.stdout.unpipe(input);input.destroy();child.stdin.end();child.kill();}
}
export async function readCodexQuota(runtime:Pick<ManagedCliRuntime,"verifyOperation">,options:ProviderSessionOptions={}) {
  const result=await codexRpc(runtime,"quota",options);
  return sanitizeQuotaObservation("quota_snapshot" in result?result.quota_snapshot:undefined);
}
