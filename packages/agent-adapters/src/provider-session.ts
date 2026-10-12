// Import-safe official provider session operations. No credential files are read.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { validateClaudeAuthorizationUrl, validateClaudeLoginCode } from "./claude-login-contract.ts";
import type { ManagedCliRuntime } from "./managed-runtime.ts";
import { BoundedJsonInput, BoundedJsonLines, LoginCompletion, ProviderFailure, RpcLifecycle, classifyProviderFailure, isRecord, validRpcId, validateClaudeStatus, validateCodexIdentity } from "./session-protocol.ts";

import { normalizeCodexQuota, sanitizeQuotaObservation } from "./index.ts";

export interface DeviceChallenge { readonly verification_url: string; readonly user_code: string }
export interface ProviderSessionOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  /** Transient user interaction only. Never persist the device code. */
  onDeviceChallenge?: (challenge: Readonly<DeviceChallenge>) => void | Promise<void>;
  /** Transient OAuth UI only. The returned code is delivered exclusively on stdin. */
  onClaudeAuthorization?: (challenge: Readonly<{authorization_url:string}>, signal: AbortSignal) => Promise<string>;
}
const assertSignal=(signal?:AbortSignal)=>{if(signal?.aborted)throw signal.reason instanceof ProviderFailure?signal.reason:new ProviderFailure("canceled");};
const sessionDeadline=(options:ProviderSessionOptions,login=false)=>{
  if(options.onDeviceChallenge!==undefined&&typeof options.onDeviceChallenge!=="function")throw new Error("managed_session_callback_invalid");
  if(options.onClaudeAuthorization!==undefined&&typeof options.onClaudeAuthorization!=="function")throw new Error("managed_session_callback_invalid");
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
export async function claudeInteractiveLogin(runtime:Pick<ManagedCliRuntime,"verifyOperation"|"exec"|"beginNamespaceExec">,options:ProviderSessionOptions={}) {
  if(!process.stdin.isTTY)throw new Error("claude_login_requires_user_terminal");
  await boundedSessionOperation(async signal=>{
    const containerId=await runtime.verifyOperation({signal});assertSignal(signal);
    await runtime.beginNamespaceExec(containerId,{signal});assertSignal(signal);
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
export async function claudeManagedLogin(runtime:Pick<ManagedCliRuntime,"verifyOperation"|"exec"|"beginNamespaceExec">,options:ProviderSessionOptions={}) {
  if(typeof options.onClaudeAuthorization!=="function")throw new ProviderFailure("unsupported");
  return boundedSessionOperation(async signal=>{
    const containerId=await runtime.verifyOperation({signal});assertSignal(signal);
    await runtime.beginNamespaceExec(containerId,{signal});assertSignal(signal);
    const child=spawn("docker",["exec","-i",containerId,"/opt/cg/claude","auth","login","--claudeai"],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
    await runClaudeLoginProtocol(child,{...options,signal});assertSignal(signal);
    return claudeStatus(runtime,{signal,deadlineMs:30_000,requireLogin:true});
  },options,true);
}
// Stream-only seam: no credential files, terminal output or code enter results.
export async function runClaudeLoginProtocol(child:ChildProcessWithoutNullStreams,options:ProviderSessionOptions={}) {
  return boundedSessionOperation(async signal=>{
    if(typeof options.onClaudeAuthorization!=="function")throw new ProviderFailure("unsupported");
    const interaction=new AbortController();
    const decoder=new StringDecoder("utf8");let buffer="",bytes=0,stderrBytes=0,challenged=false,written=false,settled=false;
    let resolve!:()=>void,reject!:(error:ProviderFailure)=>void;
    const done=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
    const fail=(error:ProviderFailure)=>{if(!settled){settled=true;interaction.abort(error);child.stdin.end();child.kill();reject(error);}};
    const aborted=()=>fail(signal.reason instanceof ProviderFailure?signal.reason:new ProviderFailure("canceled"));
    const processError=()=>fail(new ProviderFailure("process"));
    const closed=(code:number|null)=>{
      if(settled)return;
      if(code!==0){fail(new ProviderFailure("auth_required"));return;}
      if(!challenged||!written){fail(new ProviderFailure("protocol"));return;}
      settled=true;interaction.abort(new ProviderFailure("canceled"));resolve();
    };
    const stdout=(chunk:Buffer)=>{
      if(settled)return;
      bytes+=chunk.length;
      if(bytes>65_536){fail(new ProviderFailure("protocol"));return;}
      buffer+=decoder.write(chunk);
      if(buffer.length>16_384){fail(new ProviderFailure("protocol"));return;}
      let newline:number;
      while((newline=buffer.indexOf("\n"))>=0){
        // Strip complete OSC hyperlinks first: Node's generic VT regex can
        // misparse the long query in this pinned CLI's OSC-8 URL payload.
        const line=stripVTControlCharacters(buffer.slice(0,newline).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,"")).replace(/\r$/,"");buffer=buffer.slice(newline+1);
        const marker="If the browser didn't open, visit: ";
        if(!line.startsWith(marker))continue;
        if(challenged){fail(new ProviderFailure("protocol"));return;}
        let url:string;
        try{url=validateClaudeAuthorizationUrl(line.slice(marker.length));}catch{fail(new ProviderFailure("protocol"));return;}
        challenged=true;
        void Promise.resolve().then(()=>{assertSignal(signal);if(settled)throw new ProviderFailure("protocol");return options.onClaudeAuthorization!(Object.freeze({authorization_url:url}),interaction.signal);}).then(code=>{
          if(settled)return;assertSignal(signal);
          try{validateClaudeLoginCode(code,url);}catch{throw new ProviderFailure("protocol");}
          written=true;child.stdin.write(code+"\n");
        }).catch(error=>fail(error instanceof ProviderFailure?error:new ProviderFailure("protocol")));
      }
    };
    const stderr=(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>65_536)fail(new ProviderFailure("protocol"));};
    signal.addEventListener("abort",aborted,{once:true});
    child.on("error",processError);child.on("close",closed);child.stdin.on("error",processError);child.stdout.on("error",processError);child.stderr.on("error",processError);
    child.stdout.on("data",stdout);child.stderr.on("data",stderr);
    if(signal.aborted)aborted();
    try{await done;assertSignal(signal);}finally{
      interaction.abort(new ProviderFailure("canceled"));
      // Pipe errors (especially a pending write's EPIPE) may arrive after this
      // promise settles. Retain capture-free guards through process teardown.
      const ignoreLateError=()=>{};
      child.on("error",ignoreLateError);child.stdin.on("error",ignoreLateError);child.stdout.on("error",ignoreLateError);child.stderr.on("error",ignoreLateError);
      signal.removeEventListener("abort",aborted);child.off("error",processError);child.off("close",closed);
      child.stdin.off("error",processError);child.stdout.off("error",processError);child.stderr.off("error",processError);
      child.stdout.off("data",stdout);child.stderr.off("data",stderr);buffer="";child.stdin.end();child.kill();
    }
  },options,true);
}
export type CodexSessionOperation="status"|"refresh"|"logout"|"login"|"quota";
export async function codexRpc(runtime: Pick<ManagedCliRuntime,"verifyOperation"|"beginNamespaceExec">, operation: CodexSessionOperation,options:ProviderSessionOptions={}) {
  if(!["status","refresh","logout","login","quota"].includes(operation))throw new Error("managed_session_operation_invalid");
  return boundedSessionOperation(async signal=>{
    const containerId=await runtime.verifyOperation({signal});assertSignal(signal);
    await runtime.beginNamespaceExec(containerId,{signal});assertSignal(signal);
    const child=spawn("docker",["exec","-i",containerId,"/opt/cg/codex","app-server","--listen","stdio://","-c",'cli_auth_credentials_store="file"',"-c",'model_provider="openai"'],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
    return runCodexSessionProtocol(child,operation,{...options,signal});
  },options,operation==="login");
}
// Stream-only seam for deterministic protocol fixtures; production callers
// always obtain an immutable, operation-owned container ID in codexRpc first.
export async function runCodexSessionProtocol(child:ChildProcessWithoutNullStreams,operation:CodexSessionOperation,options:ProviderSessionOptions={}) {
  if(!["status","refresh","logout","login","quota"].includes(operation))throw new Error("managed_session_operation_invalid");
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
    await request("initialize",{clientInfo:{name:"commongrid_managed_auth",version:"0.1.0"},capabilities:{experimentalApi:true}});
    child.stdin.write(JSON.stringify({method:"initialized"})+"\n");
    if(operation === "logout")await request("account/logout",{});
    if(operation === "login") {
      const reply=await request("account/login/start",{type:"chatgptDeviceCode"});
      if(!isRecord(reply)||reply.type!=="chatgptDeviceCode"||reply.verificationUrl!=="https://auth.openai.com/codex/device"||typeof reply.userCode!=="string"||!/^[A-Z0-9-]{4,32}$/.test(reply.userCode))throw new ProviderFailure("protocol");
      login.bind(reply.loginId);
      // Only validated scalar fields cross this explicit, transient UI boundary.
      // Callback errors cannot expose private user-interface or device data.
      if(options.onDeviceChallenge) {
        const challenge=Object.freeze({verification_url:reply.verificationUrl,user_code:reply.userCode});
        await Promise.race([
          Promise.resolve().then(()=>{rpc.assertHealthy();return options.onDeviceChallenge!(challenge);}).catch(()=>{rpc.assertHealthy();throw new ProviderFailure("protocol");}),
          rpc.done,
        ]);
        rpc.assertHealthy();
      }
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
export async function readCodexQuota(runtime:Pick<ManagedCliRuntime,"verifyOperation"|"beginNamespaceExec">,options:ProviderSessionOptions={}) {
  const result=await codexRpc(runtime,"quota",options);
  return sanitizeQuotaObservation("quota_snapshot" in result?result.quota_snapshot:undefined);
}
