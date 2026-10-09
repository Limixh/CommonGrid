// Import-safe runner helpers only. No CLI, Docker, account or model operations.
import assert from "node:assert/strict";
import test from "node:test";
import { prepareManagedTaskReply, managedProviderCompletion, assertManagedCandidateAccepted, managedTaskMain } from "./managed-task.mts";
import { ProviderFailure, failureCode } from "../../packages/agent-adapters/src/session-protocol.ts";

const privateMarker="fixture-private-argv-provider-payload";
test("managed task entry is import-safe and exposes only explicit execution",()=>{
  assert.equal(typeof managedTaskMain,"function");
});
test("callback success reconstructs fixed evidence and counts UTF-8 bytes",()=>{
  const prepared=prepareManagedTaskReply({exit_code:0,stdout:"✓",stderr:"😀",argv:[privateMarker],provider_payload:privateMarker});
  assert.deepEqual(prepared.evidence,{outcome:"success",exit_code:0,stdout_bytes:3,stderr_bytes:4});
  assert.equal(prepared.result.success,true);
  assert.deepEqual(JSON.parse(prepared.result.contentItems[0].text),{exit_code:0,stdout:"✓",stderr:"😀"});
  assert.equal(JSON.stringify(prepared).includes(privateMarker),false);
});
test("nonzero task exit stays distinct from transport or protocol failure",()=>{
  const prepared=prepareManagedTaskReply({exit_code:7,stdout:privateMarker,stderr:privateMarker});
  assert.deepEqual(prepared.evidence,{outcome:"nonzero_exit",exit_code:7,stdout_bytes:Buffer.byteLength(privateMarker),stderr_bytes:Buffer.byteLength(privateMarker)});
  assert.equal(prepared.result.success,false);
  assert.equal(JSON.stringify(prepared.evidence).includes(privateMarker),false);
});
test("tool errors never persist or forward attacker-controlled error strings",()=>{
  const prepared=prepareManagedTaskReply({error:privateMarker,argv:[privateMarker],provider_payload:privateMarker});
  assert.deepEqual(prepared.evidence,{outcome:"tool_failed",exit_code:null,stdout_bytes:null,stderr_bytes:null});
  assert.equal(prepared.result.success,false);
  assert.deepEqual(JSON.parse(prepared.result.contentItems[0].text),{error:"task_tool_failed"});
  assert.equal(JSON.stringify(prepared).includes(privateMarker),false);
});
test("oversized successful output yields an unsuccessful bounded callback with actual byte counts",()=>{
  const prepared=prepareManagedTaskReply({exit_code:0,stdout:privateMarker.repeat(2000),stderr:""});
  assert.equal(prepared.evidence.outcome,"output_limit");
  assert.equal(prepared.evidence.exit_code,0);
  assert.equal(prepared.evidence.stdout_bytes,Buffer.byteLength(privateMarker.repeat(2000)));
  assert.equal(prepared.evidence.stderr_bytes,0);
  assert.equal(prepared.result.success,false);
  assert.equal(prepared.result.contentItems[0].text,'{"error":"task_output_limit"}');
  assert.equal(JSON.stringify(prepared).includes(privateMarker),false);
});
test("JSON escaping and explicit output-limit errors also suppress callback success",()=>{
  const escaped=prepareManagedTaskReply({exit_code:0,stdout:'"'.repeat(24_000),stderr:""});
  assert.equal(escaped.evidence.stdout_bytes,24_000);assert.equal(escaped.evidence.outcome,"output_limit");assert.equal(escaped.result.success,false);
  const explicit=prepareManagedTaskReply({exit_code:0,error:"task_output_limit"});
  assert.equal(explicit.evidence.outcome,"output_limit");assert.equal(explicit.result.success,false);
  assert.equal(explicit.result.contentItems[0].text,'{"error":"task_output_limit"}');
});
test("malformed replies are closed invalid-reply evidence with no raw contents",()=>{
  for(const value of [null,[],{}, {exit_code:"0",stdout:"",stderr:""},{exit_code:NaN,stdout:"",stderr:""},{exit_code:0,stdout:{secret:privateMarker},stderr:""}]){
    const prepared=prepareManagedTaskReply(value);assert.equal(prepared.evidence.outcome,"invalid_reply");assert.equal(prepared.result.success,false);
    assert.deepEqual(JSON.parse(prepared.result.contentItems[0].text),{error:"task_tool_failed"});
    assert.equal(JSON.stringify(prepared).includes(privateMarker),false);
  }
});
test("provider completion keeps only known terminal states and strips payloads",()=>{
  for(const status of ["completed","failed","interrupted"]){
    assert.equal(managedProviderCompletion("codex",{status,error:{message:privateMarker},threadId:privateMarker}),status);
  }
  assert.equal(managedProviderCompletion("claude",{type:"result",subtype:"success",is_error:false,result:privateMarker}),"completed");
  for(const subtype of ["error_during_execution","error_max_turns","error_max_budget_usd","error_max_structured_output_retries"]){
    assert.equal(managedProviderCompletion("claude",{type:"result",subtype,is_error:true,errors:[privateMarker]}),"failed");
  }
  for(const value of [null,[],{}, {status:privateMarker},{status:"running"},{type:"result",subtype:"success",is_error:true},{type:"result",subtype:privateMarker,is_error:true}]){
    assert.equal(managedProviderCompletion("codex",value),"unknown");assert.equal(managedProviderCompletion("claude",value),"unknown");
  }
});
test("verifier rejection retains its fixed failure code and cannot become acceptance",()=>{
  assert.doesNotThrow(()=>assertManagedCandidateAccepted({passed:true}));
  let observed:unknown;
  assert.throws(()=>assertManagedCandidateAccepted({passed:false,private_payload:privateMarker}),error=>{observed=error;return error instanceof Error&&error.message==="managed_candidate_rejected";});
  assert.equal(failureCode(observed),"managed_candidate_rejected");
  assert.equal(JSON.stringify(observed).includes(privateMarker),false);
  for(const value of [null,[],{}, {passed:"false"},{passed:undefined}]){
    assert.throws(()=>assertManagedCandidateAccepted(value),error=>error instanceof ProviderFailure&&error.category==="protocol");
  }
});
