import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCodexQuota, sanitizeQuotaObservation } from "@commongrid/agent-adapters";

const snapshot={rateLimits:{primary:{usedPercent:0,windowDurationMins:300,resetsAt:1_800_000_000},secondary:null,credits:{balance:"private"},limitId:"private"},accountId:"private",rateLimitsByLimitId:{private:{primary:{usedPercent:100,windowDurationMins:null,resetsAt:null,extra:"private"},secondary:null,credits:{balance:"private"}}}};

test("numeric quota normalization strips all labels, account identifiers, credits and unknown fields",()=>{
  const value=normalizeCodexQuota(snapshot);
  assert.deepEqual(value,{state:"available",source:"official_codex_account_rate_limits_read",windows:[{primary:{usedPercent:100,windowDurationMins:null,resetsAt:null},secondary:null}]});
  assert.equal(JSON.stringify(value).includes("private"),false);assert.deepEqual(sanitizeQuotaObservation({...value,accountId:"private"}),value);
});
test("null or missing quota windows remain unknown rather than zero usage",()=>{
  for(const rateLimits of [{},{primary:null,secondary:null},{primary:undefined,secondary:undefined}]){
    const value=normalizeCodexQuota({rateLimits});
    assert.deepEqual(value,{state:"unknown",source:"official_codex_account_rate_limits_read",reason:"no_windows",windows:[{primary:null,secondary:null}]});
    assert.deepEqual(sanitizeQuotaObservation(value),value);
  }
  assert.deepEqual(sanitizeQuotaObservation({state:"unknown",source:"official_codex_account_rate_limits_read",reason:"no_windows",windows:[]}),{state:"unknown",source:"official_codex_account_rate_limits_read",reason:"no_windows",windows:[]});
});

test("invalid percentages, duration/reset values, shapes and hidden malformed legacy buckets fail hard",()=>{
  for(const usedPercent of [undefined,null,"12",true,-1,101,NaN,Infinity,1.2])assert.throws(()=>normalizeCodexQuota({rateLimits:{primary:{usedPercent}}}),/managed_provider_protocol/);
  for(const [key,values] of [["windowDurationMins",[0,-1,1.2,"300",true,Infinity,Number.MAX_SAFE_INTEGER+1]],["resetsAt",[-1,1.2,"123",true,Infinity,Number.MAX_SAFE_INTEGER+1]]] as const){
    for(const value of values)assert.throws(()=>normalizeCodexQuota({rateLimits:{primary:{usedPercent:5,[key]:value}}}),/managed_provider_protocol/);
  }
  for(const value of [null,[],{}, {rateLimits:null},{rateLimits:[]},{rateLimits:{primary:[]}},{rateLimits:{},rateLimitsByLimitId:[]},{rateLimits:{},rateLimitsByLimitId:{a:null}},{rateLimits:{primary:{usedPercent:NaN}},rateLimitsByLimitId:{a:{primary:{usedPercent:0}}}},{rateLimits:{},rateLimitsByLimitId:Object.fromEntries(Array.from({length:129},(_,i)=>[i,{}]))}])assert.throws(()=>normalizeCodexQuota(value),/managed_provider_protocol/);
  for(const patch of [{state:"available",reason:"no_windows"},{state:"unknown"},{source:"other"},{windows:[null]},{windows:[{primary:{usedPercent:"0"}}]}])assert.throws(()=>sanitizeQuotaObservation({...normalizeCodexQuota(snapshot),...patch}),/managed_provider_protocol/);
});
