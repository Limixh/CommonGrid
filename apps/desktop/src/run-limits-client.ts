import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  validateRunLimitsSave, validateRunLimitsStatus, unavailableRunLimits, runLimitsMaxStatusBytes,
  type RunLimitsSaveRequest, type RunLimitsStatus,
} from "@commongrid/agent-adapters/task-run";

export const runLimitsNative = () => isTauri();
// Stopping a browser wait does not undo a native save that already reached the supervisor.
async function boundedInvoke(command: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const pending = invoke<unknown>(command, args);
  const value = await new Promise<unknown>((resolve, reject) => {
    const abort = () => reject(new DOMException("Run limits wait aborted", "AbortError"));
    signal.addEventListener("abort", abort, {once: true});
    if (signal.aborted) abort();
    pending.then(value => { signal.removeEventListener("abort", abort); if (!signal.aborted) resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
  signal.throwIfAborted();
  return value;
}
// Native error text is never surfaced: callers only see a fixed code or an abort.
async function checkedInvoke(command: string, args: Record<string, unknown>, signal: AbortSignal): Promise<RunLimitsStatus> {
  signal.throwIfAborted();
  if (!runLimitsNative()) return unavailableRunLimits();
  let value: unknown;
  try { value = await boundedInvoke(command, args, signal); }
  catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("run_limits_unavailable");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > runLimitsMaxStatusBytes) throw new Error("run_limits_contract_invalid");
  try { return validateRunLimitsStatus(value); } catch { throw new Error("run_limits_contract_invalid"); }
}
export function readRunLimits(signal: AbortSignal) { return checkedInvoke("local_run_limits_status", {}, signal); }
export async function saveRunLimits(request: RunLimitsSaveRequest, signal: AbortSignal) {
  let checked: RunLimitsSaveRequest;
  try { checked = validateRunLimitsSave(request); } catch { throw new Error("run_limits_contract_invalid"); }
  const status = await checkedInvoke("local_run_limits_save", {request: checked}, signal);
  // A saved reply must echo the persisted limits exactly; an unavailable or fail-closed reply is not a confirmation.
  if (status.availability !== "available" || status.effective.reason === "local_budget_unavailable" ||
    status.limits.attempt_sec !== checked.attempt_sec || status.limits.daily_sec !== checked.daily_sec) throw new Error("run_limits_contract_invalid");
  return status;
}
