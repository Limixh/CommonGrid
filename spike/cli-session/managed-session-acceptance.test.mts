import assert from "node:assert/strict";
import test from "node:test";
import { ProviderFailure } from "../../packages/agent-adapters/src/session-protocol.ts";
import { runSessionAcceptance, parseAcceptanceArgs, validateSessionCheckpoint, type AcceptanceEnvironment, type AcceptanceProvider } from "./managed-session-acceptance.mts";
import { normalizeCodexQuota } from "./managed-provider-session.mts";

const owner="11111111-1111-4111-8111-111111111111",clock=Date.parse("2026-10-08T10:00:00.000Z");
const options={provider:"codex" as const,owner,realAccount:true,cleanupDeadlineMs:25};
const quota=()=>normalizeCodexQuota({rateLimits:{primary:{usedPercent:17,windowDurationMins:null,resetsAt:null},accountId:"private",credits:{balance:"private"}}});
function fixture(provider:AcceptanceProvider="codex") {
  const calls:string[]=[];
  const environment:AcceptanceEnvironment={
    start:async()=>{calls.push("start");},stop:async()=>{calls.push("stop");},
    status:async()=>{calls.push("status");return {authenticated:true,method:provider==="codex"?"chatgpt":"claude.ai",email:"private@example.test",accountId:"private"};},
    refresh:async()=>{calls.push("refresh");return {authenticated:true,method:"chatgpt",refresh_requested:true,credential:"private"};},
    readQuota:async()=>{calls.push("quota");return {...quota(),accountId:"private",credits:"private"};},
    assertHealthy:()=>{},now:()=>clock,
  };
  return {calls,environment};
}

test("explicit opt-in, identity and checkpoint validation precede all environment operations",async()=>{
  const f=fixture();
  await assert.rejects(runSessionAcceptance({...options,realAccount:false},f.environment),/explicit_real_account_opt_in/);
  await assert.rejects(runSessionAcceptance({...options,owner:"bad"},f.environment),/managed_identity_invalid/);
  await assert.rejects(runSessionAcceptance({...options,checkpoint:{}},f.environment),/managed_checkpoint_invalid/);
  assert.deepEqual(f.calls,[]);
  assert.throws(()=>parseAcceptanceArgs(["codex",owner]),/explicit_real_account_opt_in/);
  assert.throws(()=>parseAcceptanceArgs(["codex",owner,"--real-account","--real-account"]));
  assert.throws(()=>parseAcceptanceArgs(["codex",owner,"--real-account","--force"]));
  assert.deepEqual(parseAcceptanceArgs(["claude",owner,"--resume","--real-account"]),{provider:"claude",owner,realAccount:true,resume:true});
});

test("Codex acceptance orders official status, namespace restart, official refresh, status and readonly quota",async()=>{
  const f=fixture(),{report,checkpoint}=await runSessionAcceptance(options,f.environment);
  assert.deepEqual(f.calls,["start","status","stop","start","status","refresh","status","quota","stop"]);
  assert.equal(report.success,true);assert.equal(report.cleanup_confirmed,true);assert.equal(report.official_codex_refresh_requested,true);
  assert.deepEqual(report.stages.map((stage:any)=>stage.stage),["namespace_start","initial_authenticated_status","namespace_stop_for_restart","namespace_restart","restart_authenticated_status","official_codex_refresh_request","post_refresh_authenticated_status","read_only_codex_quota_snapshot"]);
  assert.equal(report.execution_enabled,false);assert.equal(report.isolation_gate,"not_evaluated");assert.equal(report.commercial_auth_accepted,false);assert.equal(report.production_use,false);assert.equal(report.phase,"F0");
  assert.equal(report.real_provider_expiry_acceptance,"pending");assert.equal(report.actual_token_rotation_observed,false);assert.equal(report.quota_exhaustion_verified,false);
  assert.equal(report.logout_attempted,false);assert.equal(report.real_model_inference_attempted,false);assert.equal(report.paid_api_fallback,false);
  assert.equal(JSON.stringify({report,checkpoint}).includes("private"),false);assert.equal(checkpoint?.renewal_observed,false);
  assert.deepEqual(report.quota_snapshot,quota());
});

test("Claude uses authenticated status across restart without refresh or quota inference",async()=>{
  const f=fixture("claude"),{report,checkpoint}=await runSessionAcceptance({...options,provider:"claude"},f.environment);
  assert.deepEqual(f.calls,["start","status","stop","start","status","stop"]);
  assert.equal(report.success,true);assert.equal(report.official_codex_refresh_requested,false);assert.equal(report.claude_natural_expiry_evidence,"pending");
  assert.equal(report.quota_snapshot.state,"unknown");assert.equal(report.quota_snapshot.reason,"claude_structured_quota_not_verified");assert.ok(checkpoint);
});

test("authentication failures and provider text fail closed before refresh and always clean up",async()=>{
  for(const value of [{authenticated:false,method:"none"},{authenticated:true,method:"apiKey"}]){
    const f=fixture();f.environment.status=async()=>value;
    const {report,checkpoint}=await runSessionAcceptance(options,f.environment);
    assert.equal(report.success,false);assert.equal(report.cleanup_confirmed,true);assert.equal(checkpoint,undefined);assert.deepEqual(f.calls,["start","stop"]);
    assert.match(report.failure,/managed_provider_(auth_required|identity)/);
  }
  const f=fixture();f.environment.status=async()=>{throw Error("private@example.test Bearer private credential");};
  const {report}=await runSessionAcceptance(options,f.environment);
  assert.equal(report.failure,"managed_validation_failed");assert.equal(JSON.stringify(report).includes("private"),false);
});

test("failed start and failed bridge validation still invoke mandatory cleanup",async()=>{
  for(const target of ["start","bridge"]){
    const f=fixture();
    if(target==="start")f.environment.start=async()=>{f.calls.push("start");throw Error("private");};
    else f.environment.assertHealthy=()=>{throw Error("managed_bridge_control_failed");};
    const {report,checkpoint}=await runSessionAcceptance(options,f.environment);
    assert.deepEqual(f.calls,["start","stop"]);assert.equal(report.success,false);assert.equal(checkpoint,undefined);
  }
});

test("Codex refresh must confirm its requested official operation; quota is mandatory and malformed quota is failure",async()=>{
  for(const mode of ["refresh","missing_quota","bad_quota"]){
    const f=fixture();
    if(mode==="refresh")f.environment.refresh=async()=>({authenticated:true,method:"chatgpt"});
    if(mode==="missing_quota")delete f.environment.readQuota;
    if(mode==="bad_quota")f.environment.readQuota=async()=>({...quota(),windows:[{primary:{usedPercent:NaN},secondary:null}]});
    const {report,checkpoint}=await runSessionAcceptance(options,f.environment);
    assert.equal(report.success,false);assert.equal(report.failure,"managed_provider_protocol");assert.equal(report.cleanup_confirmed,true);assert.equal(checkpoint,undefined);
    assert.equal(f.calls.at(-1),"stop");
  }
});

test("unsupported readonly quota remains explicitly unknown without retry, fallback or authentication probing",async()=>{
  const f=fixture();f.environment.readQuota=async()=>({state:"unknown",source:"official_codex_account_rate_limits_read",reason:"unsupported_method",windows:[],email:"private"});
  const {report}=await runSessionAcceptance(options,f.environment);
  assert.equal(report.success,true);assert.deepEqual(report.quota_snapshot,{state:"unknown",source:"official_codex_account_rate_limits_read",reason:"unsupported_method",windows:[]});
  assert.deepEqual(f.calls,["start","status","stop","start","status","refresh","status","stop"]);
});

test("cleanup failure suppresses success and checkpoint",async()=>{
  const f=fixture();let stops=0;f.environment.stop=async()=>{if(++stops===2)throw Error("private");};
  const {report,checkpoint}=await runSessionAcceptance(options,f.environment);
  assert.equal(report.cleanup_confirmed,false);assert.equal(report.success,false);assert.equal(report.failure,"managed_acceptance_cleanup_failed");assert.equal(checkpoint,undefined);
});

test("pre-cancellation prevents namespace/authentication operations",async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  const {report,checkpoint}=await runSessionAcceptance({...options,signal:controller.signal},f.environment);
  assert.deepEqual(f.calls,[]);assert.equal(report.failure,"managed_provider_canceled");assert.equal(report.success,false);assert.equal(checkpoint,undefined);
});

test("cancellation aborts an active operation and cleanup receives an independent live signal",async()=>{
  const f=fixture(),controller=new AbortController();let cleanupSignal:AbortSignal|undefined;
  f.environment.status=async signal=>new Promise((_resolve,reject)=>{signal.addEventListener("abort",()=>reject(signal.reason),{once:true});controller.abort();});
  f.environment.stop=async signal=>{cleanupSignal=signal;};
  const {report}=await runSessionAcceptance({...options,signal:controller.signal},f.environment);
  assert.equal(report.failure,"managed_provider_canceled");assert.equal(report.cleanup_confirmed,true);assert.equal(cleanupSignal?.aborted,false);assert.equal(report.success,false);
});

test("deadline returns even when a provider ignores cancellation and never certifies an outstanding operation",async()=>{
  const f=fixture();f.environment.status=async()=>new Promise(()=>{});
  const {report,checkpoint}=await runSessionAcceptance({...options,deadlineMs:1000},f.environment);
  assert.equal(report.failure,"managed_provider_deadline");assert.equal(report.cleanup_confirmed,false);assert.equal(report.success,false);assert.equal(checkpoint,undefined);assert.equal(f.calls.at(-1),"stop");
});

test("cleanup itself is bounded and reports no confirmation for a hanging stop",async()=>{
  const f=fixture();let stops=0;f.environment.stop=async()=>{if(++stops===2)return new Promise(()=>{});};
  const {report}=await runSessionAcceptance(options,f.environment);
  assert.equal(report.success,false);assert.equal(report.cleanup_confirmed,false);assert.equal(report.failure,"managed_acceptance_cleanup_failed");
});

test("resume checkpoint binds provider, owner and time; elapsed continuity never becomes token renewal evidence",async()=>{
  const initial=await runSessionAcceptance(options,fixture().environment);assert.ok(initial.checkpoint);
  const previous={...initial.checkpoint,first_authenticated_at:new Date(clock-86_400_000).toISOString(),last_authenticated_at:new Date(clock-43_200_000).toISOString()};
  const resumed=await runSessionAcceptance({...options,checkpoint:previous},fixture().environment);
  assert.equal(resumed.report.resumed,true);assert.equal(resumed.report.elapsed_since_first_authenticated_ms,86_400_000);assert.equal(resumed.report.checkpoint_is_provider_renewal_proof,false);assert.equal(resumed.report.intervening_session_activity_unobserved,true);assert.equal(resumed.checkpoint?.successful_runs,2);
  for(const patch of [{provider:"claude"},{owner:"22222222-2222-4222-8222-222222222222"},{last_authenticated_at:new Date(clock+1).toISOString()},{first_authenticated_at:new Date(clock).toISOString()},{successful_runs:0},{successful_runs:1.5},{successful_runs:1_000_001},{credential:"private"},{renewal_observed:true},{execution_enabled:true},{first_authenticated_at:"2026-02-30T00:00:00.000Z"}])assert.throws(()=>validateSessionCheckpoint({...previous,...patch},options,clock),/managed_checkpoint_invalid/);
  const boundary=await runSessionAcceptance({...options,checkpoint:{...previous,successful_runs:999_999}},fixture().environment);
  assert.equal(boundary.checkpoint?.successful_runs,1_000_000);assert.ok(validateSessionCheckpoint(boundary.checkpoint,options,clock));
  const next=fixture();await assert.rejects(runSessionAcceptance({...options,checkpoint:boundary.checkpoint},next.environment),/managed_checkpoint_run_limit/);assert.deepEqual(next.calls,[]);
});

test("imports expose helpers without invoking CLI commands",async()=>{
  const session=await import("./managed-session.mts");
  assert.equal(typeof session.managedSessionMain,"function");
  assert.equal(typeof (await import("./managed-session-acceptance.mts")).acceptanceMain,"function");
});
