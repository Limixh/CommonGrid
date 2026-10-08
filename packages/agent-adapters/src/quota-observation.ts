// Pure public quota evidence normalization. No CLI, authentication or runtime access.
import { ProviderFailure, isRecord } from "./session-protocol.ts";

export interface QuotaWindow {usedPercent:number;windowDurationMins:number|null;resetsAt:number|null}
export interface QuotaObservation {state:"available"|"unknown";source:"official_codex_account_rate_limits_read";reason?:"unsupported_method"|"no_windows";windows:{primary:QuotaWindow|null;secondary:QuotaWindow|null}[]}
// Pinned rust-v0.157.1 GetAccountRateLimitsResponse schema: usedPercent is an
// integer; duration/reset are optional nullable integers. Labels/account/credits
// and every unknown field are deliberately discarded.
// https://raw.githubusercontent.com/openai/codex/rust-v0.157.1/codex-rs/app-server-protocol/schema/json/v2/GetAccountRateLimitsResponse.json
function quotaWindow(value:unknown):QuotaWindow|null {
  if(value===null||value===undefined)return null;
  if(!isRecord(value)||!Number.isInteger(value.usedPercent)||value.usedPercent<0||value.usedPercent>100)throw new ProviderFailure("protocol");
  for(const key of ["windowDurationMins","resetsAt"]){const number=value[key];if(number!==null&&number!==undefined&&(!Number.isSafeInteger(number)||number<(key==="windowDurationMins"?1:0)))throw new ProviderFailure("protocol");}
  return {usedPercent:value.usedPercent,windowDurationMins:value.windowDurationMins??null,resetsAt:value.resetsAt??null};
}
export function normalizeCodexQuota(value:unknown):QuotaObservation {
  if(!isRecord(value)||!isRecord(value.rateLimits)||value.rateLimitsByLimitId!==null&&value.rateLimitsByLimitId!==undefined&&!isRecord(value.rateLimitsByLimitId))throw new ProviderFailure("protocol");
  const buckets=isRecord(value.rateLimitsByLimitId)&&Object.keys(value.rateLimitsByLimitId).length?Object.values(value.rateLimitsByLimitId):[value.rateLimits];
  if(buckets.length>128)throw new ProviderFailure("protocol");
  // Validate the legacy view too: malformed available windows are never hidden
  // by a separately valid multi-bucket response.
  quotaWindow(value.rateLimits.primary);quotaWindow(value.rateLimits.secondary);
  const windows=buckets.map(bucket=>{if(!isRecord(bucket))throw new ProviderFailure("protocol");return {primary:quotaWindow(bucket.primary),secondary:quotaWindow(bucket.secondary)};});
  return {state:windows.some(window=>window.primary||window.secondary)?"available":"unknown",source:"official_codex_account_rate_limits_read",...(windows.every(window=>!window.primary&&!window.secondary)?{reason:"no_windows" as const}:{}),windows};
}
export function sanitizeQuotaObservation(value:unknown):QuotaObservation {
  if(!isRecord(value)||value.source!=="official_codex_account_rate_limits_read"||!Array.isArray(value.windows)||value.windows.length>128)throw new ProviderFailure("protocol");
  if(value.state==="unknown"&&value.reason==="unsupported_method"&&value.windows.length===0)return {state:"unknown",source:"official_codex_account_rate_limits_read",reason:"unsupported_method",windows:[]};
  const windows=value.windows.map((window:unknown)=>{if(!isRecord(window))throw new ProviderFailure("protocol");return {primary:quotaWindow(window.primary),secondary:quotaWindow(window.secondary)};});
  const available=windows.some((window:{primary:QuotaWindow|null;secondary:QuotaWindow|null})=>window.primary||window.secondary);
  if(value.state!==(available?"available":"unknown")||value.reason!==(available?undefined:"no_windows"))throw new ProviderFailure("protocol");
  return {state:available?"available":"unknown",source:"official_codex_account_rate_limits_read",...(!available?{reason:"no_windows" as const}:{}),windows};
}
