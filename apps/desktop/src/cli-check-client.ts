import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  validateCliCheckStart, validateCliCheckCancel, validateCliCheckStatus, unavailableCliCheck,
  type CliCheckStartRequest, type CliCheckCancelRequest, type CliCheckStatus,
} from "@commongrid/agent-adapters/cli-check";

export const cliCheckNative = () => isTauri();
// Aborting a UI wait only discards its response. Cancellation is a separate IPC.
async function checkedInvoke(command: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CliCheckStatus> {
  signal.throwIfAborted();
  if (!cliCheckNative()) return unavailableCliCheck();
  const pending = invoke<unknown>(command, args);
  const value = await new Promise<unknown>((resolve, reject) => {
    const aborted = () => reject(new DOMException("CLI check wait aborted", "AbortError"));
    signal.addEventListener("abort", aborted, {once: true});
    if (signal.aborted) aborted();
    pending.then(value => { signal.removeEventListener("abort", aborted); if (!signal.aborted) resolve(value); }, error => { signal.removeEventListener("abort", aborted); reject(error); });
  });
  signal.throwIfAborted();
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 4096) throw new Error("cli_check_contract_invalid");
  return validateCliCheckStatus(value);
}
export function readCliCheck(signal: AbortSignal) { return checkedInvoke("local_cli_check_status", {}, signal); }
export async function startCliCheck(request: CliCheckStartRequest, signal: AbortSignal) {
  const checked = validateCliCheckStart(request);
  const status = await checkedInvoke("local_cli_check_start", {request: checked}, signal);
  if (status.availability === "available" && (!status.operation || status.operation.request_id !== checked.request_id || status.operation.provider !== checked.provider)) throw new Error("cli_check_contract_invalid");
  return status;
}
export async function cancelCliCheck(request: CliCheckCancelRequest, signal: AbortSignal) {
  const checked = validateCliCheckCancel(request);
  const status = await checkedInvoke("local_cli_check_cancel", {request: checked}, signal);
  if (status.availability === "available" && (!status.operation || status.operation.request_id !== checked.request_id || status.operation.revision < checked.expected_revision)) throw new Error("cli_check_contract_invalid");
  return status;
}
