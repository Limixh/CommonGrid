// Explicit local developer commands. Never enabled through desktop/HTTP or CI.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ManagedCliRuntime, startBridge, type SessionIdentity } from "./managed-runtime.mts";
import { ProviderFailure, assertBridgeHealthy, failureCode, isRecord } from "../../packages/agent-adapters/src/session-protocol.ts";
import { codexRpc, claudeStatus, claudeInteractiveLogin, boundedSessionOperation } from "./managed-provider-session.mts";

const root=fileURLToPath(new URL("../../",import.meta.url));
export function parseManagedSessionArgs(args:string[]) {
  const [command,provider,...rest]=args;
  if(!["prepare","install-trust","install-host-trust","install-coding-profile","status","login","refresh","logout","destroy"].includes(command)||!['claude','codex'].includes(provider))throw new Error("managed_session_args_invalid");
  const owner=command==="prepare"?undefined:rest.shift();
  if(command!=="prepare"&&(typeof owner!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner)))throw new Error("managed_session_args_invalid");
  let hostTrust: {pemPath:string;proofPath:string}|undefined;
  if(rest.length){
    if(provider!=="claude"||!["prepare","install-host-trust"].includes(command)||rest.length!==4)throw new Error("managed_session_args_invalid");
    const paths:Record<string,string>={};
    for(let i=0;i<rest.length;i+=2){
      const flag=rest[i],value=rest[i+1];
      if(!["--host-trust-pem","--host-trust-proof"].includes(flag)||Object.hasOwn(paths,flag)||!value?.trim()||value.startsWith("--")||/[\x00\r\n]/.test(value))throw new Error("managed_session_args_invalid");
      paths[flag]=value;
    }
    hostTrust={pemPath:paths['--host-trust-pem'],proofPath:paths['--host-trust-proof']};
  }
  if(command==="install-host-trust"&&!hostTrust)throw new Error("managed_host_trust_selection_required");
  return {command,provider:provider as "claude"|"codex",owner,hostTrust};
}
export async function managedSessionMain(args=process.argv.slice(2)) {
const {command,provider,owner,hostTrust}=parseManagedSessionArgs(args);
const directory=path.join(root,".local/managed-session"); await mkdir(directory,{recursive:true});
let runtime!: ManagedCliRuntime;
let operationFinalized=false;
try {
if(command === "prepare") {
  runtime=await ManagedCliRuntime.prepare(provider,{hostTrust});
  await writeFile(path.join(directory,`${runtime.owner}.json`),JSON.stringify({schema_version:"1.0",...runtime.identity(),created_at:new Date().toISOString(),credential_files_copied:false},null,2)+"\n");
  console.log(`Prepared ${provider}: ${runtime.owner}. Private auth volume is empty; official login required.`);
  console.log(`npm run spike:managed-session -- login ${provider} ${runtime.owner}`);
  return runtime.owner;
}
runtime=ManagedCliRuntime.restore({owner:owner!,provider});
const saved=JSON.parse(await readFile(path.join(directory,`${runtime.owner}.json`),"utf8")) as SessionIdentity;
assert.ok(isRecord(saved),"managed_public_manifest_invalid");assert.equal(saved.owner,owner);assert.equal(saved.provider,provider);
runtime=ManagedCliRuntime.restore({owner:owner!,provider,trust:saved.trust});
await runtime.beginOperation();
// The immutable trust selection was loaded before claiming the profile. Reject
// a changed manifest rather than acting on a stale public trust selection.
assert.deepEqual(JSON.parse(await readFile(path.join(directory,`${runtime.owner}.json`),"utf8")),saved,"managed_public_manifest_changed");
if(command === "destroy") {await runtime.destroy();console.log("Owned CLI/auth/tools resources removed; native login unchanged.");return;}
if(command === "install-trust") {await runtime.installTrustBundle();console.log("Public CA bundle installed from the pinned Node image. TLS verification remains enabled.");return;}
if(command === "install-host-trust") {
  await runtime.installClaudeHostTrust(hostTrust!);
  const target=path.join(directory,`${runtime.owner}.json`),temporary=target+`.${randomUUID()}.tmp`;
  try{await writeFile(temporary,JSON.stringify({...saved,...runtime.identity()},null,2)+"\n",{flag:"wx"});await rename(temporary,target);}
  finally{await unlink(temporary).catch(error=>{if(error.code!=="ENOENT")throw error;});}
  console.log("Explicit public CA pinned to this Claude profile; no private key exported.");return;
}
if(command === "install-coding-profile") {await runtime.installCodexCodingProfile();console.log("Fixture-verified public Codex direct-tool profile installed; provider and auth unchanged.");return;}


let bridge: Awaited<ReturnType<typeof startBridge>>|undefined;
const controller=new AbortController(),cancel=()=>controller.abort(new ProviderFailure("canceled"));process.on("SIGINT",cancel);process.on("SIGTERM",cancel);
const report:Record<string,unknown>={phase:"F0",production_use:false,commercial_auth_accepted:false,auth_scope:"historical_local_lab_only",checked_at:new Date().toISOString(),provider,operation:command,credential_files_copied:false,execution_enabled:false,isolation_gate:"not_evaluated",success:false,cleanup_confirmed:false};
try {
  await runtime.start({signal:controller.signal});if(controller.signal.aborted)throw controller.signal.reason;bridge=await startBridge(runtime);if(controller.signal.aborted)throw controller.signal.reason;
  let result:Record<string,unknown>;
  if(provider === "codex")result=await codexRpc(runtime,command as "status"|"refresh"|"logout"|"login",{signal:controller.signal});
  else if(command === "login") {
    result=await claudeInteractiveLogin(runtime,{signal:controller.signal});
  }else {
    if(command === "refresh")throw new Error("claude_managed_refresh_requires_expiry_and_real_turn_test");
    if(command === "logout")assert.equal((await runtime.exec(["/opt/cg/claude","auth","logout"],30_000,{signal:controller.signal})).code,0);
    result={...await claudeStatus(runtime,{signal:controller.signal,requireLogout:command === "logout"}),logout_verified:command === "logout"};
  }
  assertBridgeHealthy(bridge.stats);Object.assign(report,result,{success:true});
}catch(error){report.failure=failureCode(error);if(error instanceof ProviderFailure)report.provider_error_category=error.category;process.exitCode=1;}
finally{
  report.network=bridge?.stats;bridge?.close();
  try{await boundedSessionOperation(async signal=>runtime.stop(false,{signal}));report.cleanup_confirmed=true;}catch{report.cleanup_confirmed=false;process.exitCode=1;}
  if(bridge)try{assertBridgeHealthy(bridge.stats);}catch{report.failure??="managed_bridge_control_failed";report.success=false;process.exitCode=1;}
  operationFinalized=true;
  try{await boundedSessionOperation(signal=>runtime.finishOperation({signal}));}catch(error){report.cleanup_confirmed=false;report.failure??=failureCode(error);process.exitCode=1;}
  report.success=report.success===true&&report.cleanup_confirmed===true;
  process.off("SIGINT",cancel);process.off("SIGTERM",cancel);
  await writeFile(path.join(directory,`${owner}-${command}.report.json`),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report));
}
return report;
}finally{
  // Includes prepare/install early returns and failed manifest publication.
  // stop above removes only the namespace; the command releases last.
  if(runtime&&!operationFinalized)await boundedSessionOperation(async signal=>runtime!.finishOperation({signal}));
}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))managedSessionMain().catch(error=>{console.error(failureCode(error));process.exitCode=1;});
