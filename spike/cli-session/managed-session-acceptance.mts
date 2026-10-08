// Explicit opt-in F0 continuity check. No inference, logout, credential access,
// forced Claude refresh, or product execution gate is enabled here.
import { open, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ProviderFailure, assertBridgeHealthy, failureCode, isRecord } from "../../packages/agent-adapters/src/session-protocol.ts";
import { claudeStatus, codexRpc, readCodexQuota, sanitizeQuotaObservation } from "./managed-provider-session.mts";

export type AcceptanceProvider="claude"|"codex";
export interface AcceptanceIdentity {provider:AcceptanceProvider;owner:string}
export interface SessionCheckpoint extends AcceptanceIdentity {
  schema_version:"1.0";kind:"managed_session_continuity_checkpoint";
  first_authenticated_at:string;last_authenticated_at:string;successful_runs:number;
  renewal_observed:false;credential_files_copied:false;execution_enabled:false;isolation_gate:"not_evaluated";
}
export interface AcceptanceEnvironment {
  start(signal:AbortSignal):Promise<void>;
  stop(signal?:AbortSignal):Promise<void>;
  status(signal:AbortSignal):Promise<unknown>;
  refresh(signal:AbortSignal):Promise<unknown>;
  readQuota?(signal:AbortSignal):Promise<unknown>;
  assertHealthy():void;
  now?():number;
}
export interface AcceptanceOptions extends AcceptanceIdentity {realAccount:boolean;checkpoint?:unknown;signal?:AbortSignal;deadlineMs?:number;cleanupDeadlineMs?:number}
const ownerPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validateIdentity(value:AcceptanceIdentity) {
  if(!["claude","codex"].includes(value.provider)||!ownerPattern.test(value.owner))throw new Error("managed_identity_invalid");
}
const timestamp=(value:unknown)=>typeof value==="string"&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
export function validateSessionCheckpoint(value:unknown,identity:AcceptanceIdentity,now:number):SessionCheckpoint {
  validateIdentity(identity);
  const keys=["schema_version","kind","provider","owner","first_authenticated_at","last_authenticated_at","successful_runs","renewal_observed","credential_files_copied","execution_enabled","isolation_gate"];
  if(!Number.isFinite(now)||!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(value,key))||value.schema_version!=="1.0"||value.kind!=="managed_session_continuity_checkpoint"||value.provider!==identity.provider||value.owner!==identity.owner||!timestamp(value.first_authenticated_at)||!timestamp(value.last_authenticated_at)||Date.parse(value.first_authenticated_at)>Date.parse(value.last_authenticated_at)||Date.parse(value.last_authenticated_at)>now||!Number.isSafeInteger(value.successful_runs)||value.successful_runs<1||value.successful_runs>1_000_000||value.renewal_observed!==false||value.credential_files_copied!==false||value.execution_enabled!==false||value.isolation_gate!=="not_evaluated")throw new Error("managed_checkpoint_invalid");
  // Reconstruct allowed public fields rather than returning the parsed object.
  return {schema_version:"1.0",kind:"managed_session_continuity_checkpoint",provider:identity.provider,owner:identity.owner,first_authenticated_at:value.first_authenticated_at,last_authenticated_at:value.last_authenticated_at,successful_runs:value.successful_runs,renewal_observed:false,credential_files_copied:false,execution_enabled:false,isolation_gate:"not_evaluated"};
}
export function parseAcceptanceArgs(args:string[]) {
  const [provider,owner,...flags]=args;
  if(!flags.includes("--real-account")||flags.some(flag=>!["--real-account","--resume"].includes(flag))||new Set(flags).size!==flags.length)throw new Error("managed_acceptance_requires_explicit_real_account_opt_in");
  const identity={provider:provider as AcceptanceProvider,owner};validateIdentity(identity);
  return {...identity,realAccount:true,resume:flags.includes("--resume")};
}
export async function runSessionAcceptance(options:AcceptanceOptions,environment:AcceptanceEnvironment) {
  validateIdentity(options);if(options.realAccount!==true)throw new Error("managed_acceptance_requires_explicit_real_account_opt_in");
  const deadlineMs=options.deadlineMs??300_000;
  if(!Number.isSafeInteger(deadlineMs)||deadlineMs<1_000||deadlineMs>300_000)throw new Error("managed_acceptance_deadline_invalid");
  const cleanupDeadlineMs=options.cleanupDeadlineMs??30_000;
  if(!Number.isSafeInteger(cleanupDeadlineMs)||cleanupDeadlineMs<1||cleanupDeadlineMs>30_000)throw new Error("managed_acceptance_cleanup_deadline_invalid");
  const now=environment.now??Date.now,started=now();
  const previous=options.checkpoint===undefined?undefined:validateSessionCheckpoint(options.checkpoint,options,started);
  if(previous?.successful_runs===1_000_000)throw new Error("managed_checkpoint_run_limit");
  const controller=new AbortController();
  let abortFailure:ProviderFailure|undefined;
  const abort=(error:ProviderFailure)=>{abortFailure??=error;controller.abort(abortFailure);};
  const externalAbort=()=>abort(new ProviderFailure("canceled"));
  options.signal?.addEventListener("abort",externalAbort,{once:true});if(options.signal?.aborted)externalAbort();
  const timer=setTimeout(()=>abort(new ProviderFailure("deadline")),deadlineMs);
  const active=()=>{if(abortFailure)throw abortFailure;};
  const expectedMethod=options.provider==="codex"?"chatgpt":"claude.ai";
  const authenticated=(value:unknown,refresh=false)=>{
    if(!isRecord(value)||value.authenticated!==true)throw new ProviderFailure("auth_required");
    if(value.method!==expectedMethod)throw new ProviderFailure("identity");
    if(refresh&&value.refresh_requested!==true)throw new ProviderFailure("protocol");
    return {authenticated:true,method:expectedMethod,...(refresh?{refresh_requested:true}:{})};
  };
  const report:Record<string,any>={schema_version:"1.0",phase:"F0",production_use:false,commercial_auth_accepted:false,auth_scope:"historical_local_lab_only",purpose:"controlled_real_subscription_session_continuity",provider:options.provider,owner:options.owner,checked_at:new Date(started).toISOString(),credential_files_copied:false,paid_api_fallback:false,execution_enabled:false,isolation_gate:"not_evaluated",real_model_inference_attempted:false,logout_attempted:false,success:false,cleanup_confirmed:false,resumed:!!previous,elapsed_since_first_authenticated_ms:previous?started-Date.parse(previous.first_authenticated_at):0,checkpoint_is_provider_renewal_proof:false,intervening_session_activity_unobserved:!!previous,actual_token_rotation_observed:false,real_provider_expiry_acceptance:"pending",claude_natural_expiry_evidence:options.provider==="claude"?"pending":"not_applicable",claude_force_refresh_supported:false,official_codex_refresh_requested:false,quota_snapshot:{state:"unknown",reason:options.provider==="claude"?"claude_structured_quota_not_verified":"not_requested",windows:[]},quota_exhaustion_verified:false,concurrent_account_usage_verified:false,deadline_ms:deadlineMs,cleanup_deadline_ms:cleanupDeadlineMs,stages:[]};
  let firstAuthenticated=previous?.first_authenticated_at,lastAuthenticated:string|undefined,namespaceAttempted=false;
  report.quota_observation_is_usage_permission=false;
  const pending=new Set<Promise<unknown>>();
  const bounded=async(operation:()=>Promise<unknown>,signal:AbortSignal)=>{
    if(signal.aborted)throw signal.reason;
    let rejectAbort!:(reason:unknown)=>void;
    const interrupted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
    const onAbort=()=>rejectAbort(signal.reason instanceof ProviderFailure?signal.reason:new ProviderFailure("canceled"));
    signal.addEventListener("abort",onAbort,{once:true});
    const work=Promise.resolve().then(()=>{if(signal.aborted)throw signal.reason;return operation();});pending.add(work);
    work.then(()=>pending.delete(work),()=>pending.delete(work));
    try{return await Promise.race([work,interrupted]);}finally{signal.removeEventListener("abort",onAbort);}
  };
  const stage=async(name:string,operation:()=>Promise<unknown>)=>{
    active();const at=now();
    try{const result=await bounded(operation,controller.signal);active();report.stages.push({stage:name,checked_at:new Date(at).toISOString(),elapsed_ms:Math.max(0,now()-at),success:true,...(isRecord(result)&&Object.hasOwn(result,"authenticated")?result:{})});return result;}
    catch(error){report.stages.push({stage:name,checked_at:new Date(at).toISOString(),elapsed_ms:Math.max(0,now()-at),success:false,failure:failureCode(error)});throw error;}
  };
  const status=async()=>{const value=await environment.status(controller.signal);active();const result=authenticated(value);environment.assertHealthy();lastAuthenticated=new Date(now()).toISOString();firstAuthenticated??=lastAuthenticated;return result;};
  try {
    await stage("namespace_start",async()=>{namespaceAttempted=true;await environment.start(controller.signal);environment.assertHealthy();});
    await stage("initial_authenticated_status",status);
    await stage("namespace_stop_for_restart",async()=>{environment.assertHealthy();await environment.stop(controller.signal);environment.assertHealthy();});
    await stage("namespace_restart",async()=>{await environment.start(controller.signal);environment.assertHealthy();});
    await stage("restart_authenticated_status",status);
    if(options.provider==="codex"){
      await stage("official_codex_refresh_request",async()=>{report.official_codex_refresh_requested=true;const value=await environment.refresh(controller.signal);active();const result=authenticated(value,true);environment.assertHealthy();return result;});
      await stage("post_refresh_authenticated_status",status);
      await stage("read_only_codex_quota_snapshot",async()=>{if(!environment.readQuota)throw new ProviderFailure("protocol");const value=await environment.readQuota(controller.signal);active();report.quota_snapshot=sanitizeQuotaObservation(value);environment.assertHealthy();});
    }
    active();environment.assertHealthy();report.success=true;
  }catch(error){report.failure=failureCode(error);if(error instanceof ProviderFailure)report.provider_error_category=error.category;}
  finally {
    // Cleanup has its own bounded signal after cancellation/deadline. An
    // outstanding operation can still create resources, so never certify it.
    if(namespaceAttempted){
      const cleanup=new AbortController(),cleanupTimer=setTimeout(()=>cleanup.abort(new ProviderFailure("deadline")),cleanupDeadlineMs);
      try{await bounded(()=>environment.stop(cleanup.signal),cleanup.signal);report.cleanup_confirmed=pending.size===0;if(!report.cleanup_confirmed)report.failure??="managed_acceptance_operation_pending";}
      catch{report.cleanup_confirmed=false;report.failure??="managed_acceptance_cleanup_failed";}
      finally{clearTimeout(cleanupTimer);}
      try{environment.assertHealthy();}catch{report.failure??="managed_bridge_control_failed";report.success=false;}
    }
    if(abortFailure){report.failure=abortFailure.message;report.provider_error_category=abortFailure.category;report.success=false;}
    report.success=report.success===true&&report.cleanup_confirmed===true;
    report.elapsed_ms=Math.max(0,now()-started);
    clearTimeout(timer);options.signal?.removeEventListener("abort",externalAbort);
  }
  const checkpoint:SessionCheckpoint|undefined=report.success&&firstAuthenticated&&lastAuthenticated?{schema_version:"1.0",kind:"managed_session_continuity_checkpoint",provider:options.provider,owner:options.owner,first_authenticated_at:firstAuthenticated,last_authenticated_at:lastAuthenticated,successful_runs:(previous?.successful_runs??0)+1,renewal_observed:false,credential_files_copied:false,execution_enabled:false,isolation_gate:"not_evaluated"}:undefined;
  return {report,checkpoint};
}

async function readPublicJson(filename:string) {
  const file=await open(filename,"r");
  try{const data=Buffer.alloc(8_193);const {bytesRead}=await file.read(data,0,data.length,0);if(bytesRead>8_192)throw new Error("managed_public_manifest_invalid");return JSON.parse(data.subarray(0,bytesRead).toString("utf8")) as unknown;}
  finally{await file.close();}
}
export async function acceptanceMain(args=process.argv.slice(2)) {
  const options=parseAcceptanceArgs(args),root=fileURLToPath(new URL("../../",import.meta.url));
  const directory=path.join(root,".local/managed-session"),checkpointPath=path.join(directory,`${options.owner}-acceptance.checkpoint.json`);
  const manifest=await readPublicJson(path.join(directory,`${options.owner}.json`));
  if(!isRecord(manifest)||manifest.owner!==options.owner||manifest.provider!==options.provider||manifest.credential_files_copied!==false)throw new Error("managed_public_manifest_invalid");
  let checkpoint:unknown;
  if(options.resume)checkpoint=await readPublicJson(checkpointPath);
  else try{await readPublicJson(checkpointPath);throw new Error("managed_checkpoint_exists_use_resume");}catch(error:any){if(error.code!=="ENOENT")throw error;}
  // Runtime loading reads only pinned public manifests; no runtime/auth action
  // occurs when this module is imported by the deterministic fixture suite.
  const {ManagedCliRuntime,startBridge}=await import("./managed-runtime.mts");
  const runtime=ManagedCliRuntime.restore(options);
  let bridge:Awaited<ReturnType<typeof startBridge>>|undefined;
  const controller=new AbortController(),cancel=()=>controller.abort(new ProviderFailure("canceled"));process.on("SIGINT",cancel);process.on("SIGTERM",cancel);
  try {
    const result=await runSessionAcceptance({...options,checkpoint,signal:controller.signal},{
      start:async signal=>{if(signal.aborted)throw signal.reason;await runtime.start({signal});if(signal.aborted)throw signal.reason;bridge=await startBridge(runtime);if(signal.aborted){bridge.close();throw signal.reason;}},
      stop:async signal=>{bridge?.close();await runtime.stop(false,{signal});},
      status:signal=>options.provider==="codex"?codexRpc(runtime,"status",{signal}):claudeStatus(runtime,{signal,requireLogin:true}),
      refresh:signal=>{if(options.provider!=="codex")throw new Error("claude_managed_refresh_requires_expiry_and_real_turn_test");return codexRpc(runtime,"refresh",{signal});},
      ...(options.provider==="codex"?{readQuota:(signal:AbortSignal)=>readCodexQuota(runtime,{signal})}:{}),
      assertHealthy:()=>{if(bridge)assertBridgeHealthy(bridge.stats);},
    });
    await mkdir(directory,{recursive:true});
    const reportPath=path.join(directory,`${options.owner}-${randomUUID()}-acceptance.report.json`);
    if(result.checkpoint){
      const temporary=`${checkpointPath}.${randomUUID()}.tmp`;
      try{await writeFile(temporary,JSON.stringify(result.checkpoint,null,2)+"\n",{flag:"wx"});await rename(temporary,checkpointPath);}
      finally{await unlink(temporary).catch(()=>{});}
    }
    await writeFile(reportPath,JSON.stringify(result.report,null,2)+"\n",{flag:"wx"});
    if(!result.report.success)process.exitCode=1;
    console.log(`Managed ${options.provider} session continuity: success=${result.report.success}, cleanup=${result.report.cleanup_confirmed}`);
    console.log(`Report: ${reportPath}`);if(result.checkpoint)console.log(`Checkpoint: ${checkpointPath}`);
    return {reportPath,checkpointPath,...result};
  }finally{process.off("SIGINT",cancel);process.off("SIGTERM",cancel);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))acceptanceMain().catch(error=>{console.error(failureCode(error));process.exitCode=1;});
