import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  validateManagedProfileCreate, validateManagedProfileSelect, validateManagedProfilesStatus, unavailableManagedProfiles,
  type ManagedProfileCreate, type ManagedProfileSelect, type ManagedProfilesStatus,
} from "@commongrid/agent-adapters/managed-profiles";

export const managedProfilesNative = () => isTauri();
async function checkedInvoke(command: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ManagedProfilesStatus> {
  signal.throwIfAborted();
  if (!managedProfilesNative()) return unavailableManagedProfiles();
  const pending = invoke<unknown>(command, args);
  const value = await new Promise<unknown>((resolve, reject) => {
    const abort = () => reject(new DOMException("Profile wait aborted", "AbortError"));
    signal.addEventListener("abort", abort, {once: true});
    if (signal.aborted) abort();
    pending.then(value => { signal.removeEventListener("abort", abort); if (!signal.aborted) resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
  signal.throwIfAborted();
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 8192) throw new Error("managed_profile_contract_invalid");
  return validateManagedProfilesStatus(value);
}
export function readManagedProfiles(signal: AbortSignal) { return checkedInvoke("local_managed_profiles_status", {}, signal); }
export async function createManagedProfile(request: ManagedProfileCreate, signal: AbortSignal) {
  const checked = validateManagedProfileCreate(request);
  const status = await checkedInvoke("local_managed_profile_create", {request: checked}, signal);
  if (status.availability === "available" && !status.profiles.some(profile =>
    profile.profile_id === checked.request_id && profile.provider === checked.provider && profile.name === checked.name)) throw new Error("managed_profile_contract_invalid");
  return status;
}
export async function selectManagedProfile(request: ManagedProfileSelect, signal: AbortSignal) {
  const checked = validateManagedProfileSelect(request);
  const status = await checkedInvoke("local_managed_profile_select", {request: checked}, signal);
  if (status.availability === "available" && status.selected_profile_id !== checked.profile_id) throw new Error("managed_profile_contract_invalid");
  return status;
}
