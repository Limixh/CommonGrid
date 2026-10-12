import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  validateProfileSessionStart, validateProfileSessionCancel, validateProfileSessionSubmit, validateProfileSessionStatus, unavailableProfileSession,
  type ProfileSessionStartRequest, type ProfileSessionCancelRequest, type ProfileSessionSubmitRequest, type ProfileSessionStatus,
} from "@commongrid/agent-adapters/profile-session";

export const profileSessionNative = () => isTauri();
// Stopping a browser wait does not cancel the official CLI operation.
async function boundedInvoke(command: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const pending = invoke<unknown>(command, args);
  const value = await new Promise<unknown>((resolve, reject) => {
    const abort = () => reject(new DOMException("Profile session wait aborted", "AbortError"));
    signal.addEventListener("abort", abort, {once: true});
    if (signal.aborted) abort();
    pending.then(value => { signal.removeEventListener("abort", abort); if (!signal.aborted) resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
  signal.throwIfAborted();
  return value;
}
async function checkedInvoke(command: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ProfileSessionStatus> {
  signal.throwIfAborted();
  if (!profileSessionNative()) return unavailableProfileSession();
  const value = await boundedInvoke(command, args, signal);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 4096) throw new Error("profile_session_contract_invalid");
  return validateProfileSessionStatus(value);
}
export function readProfileSession(signal: AbortSignal) { return checkedInvoke("local_profile_session_status", {}, signal); }
export async function startProfileSession(request: ProfileSessionStartRequest, signal: AbortSignal) {
  const checked = validateProfileSessionStart(request);
  const status = await checkedInvoke("local_profile_session_start", {request: checked}, signal);
  if (status.availability === "available" && (!status.operation || status.operation.request_id !== checked.request_id ||
    status.operation.profile_id !== checked.profile_id || status.operation.action !== checked.action)) throw new Error("profile_session_contract_invalid");
  return status;
}
export async function openProfileSessionDevice(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!profileSessionNative()) throw new Error("profile_session_unavailable");
  // Native owns the fixed official URL and validates the active Codex login.
  if (await boundedInvoke("local_profile_session_open_device", {}, signal) !== true) throw new Error("profile_session_contract_invalid");
}
export async function openProfileSessionClaude(request: ProfileSessionCancelRequest, signal: AbortSignal): Promise<void> {
  const checked = validateProfileSessionCancel(request);
  signal.throwIfAborted();
  if (!profileSessionNative()) throw new Error("profile_session_unavailable");
  // Native validates the active operation and opens its stored official URL.
  if (await boundedInvoke("local_profile_session_open_claude", {request: checked}, signal) !== true) throw new Error("profile_session_contract_invalid");
}
export async function submitProfileSessionCode(request: ProfileSessionSubmitRequest, signal: AbortSignal) {
  const checked = validateProfileSessionSubmit(request);
  const status = await checkedInvoke("local_profile_session_submit_code", {request: checked}, signal);
  if (status.availability === "available" && (!status.operation || status.operation.request_id !== checked.request_id ||
    status.operation.provider !== "claude" || status.operation.action !== "login" ||
    status.operation.revision <= checked.expected_revision || status.operation.challenge !== null)) throw new Error("profile_session_contract_invalid");
  return status;
}
export async function cancelProfileSession(request: ProfileSessionCancelRequest, signal: AbortSignal) {
  const checked = validateProfileSessionCancel(request);
  const status = await checkedInvoke("local_profile_session_cancel", {request: checked}, signal);
  if (status.availability === "available" && (!status.operation || status.operation.request_id !== checked.request_id ||
    status.operation.revision < checked.expected_revision)) throw new Error("profile_session_contract_invalid");
  return status;
}
