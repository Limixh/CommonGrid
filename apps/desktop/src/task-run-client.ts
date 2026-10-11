import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  validateTaskRunStart, validateTaskRunCancel, validateTaskRunStatus, unavailableTaskRun, taskRunMaxStatusBytes,
  type TaskRunStartRequest, type TaskRunCancelRequest, type TaskRunStatus,
} from "@commongrid/agent-adapters/task-run";

export const taskRunNative = () => isTauri();
// Stopping a browser wait does not cancel the native-owned task run.
async function boundedInvoke(command: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const pending = invoke<unknown>(command, args);
  const value = await new Promise<unknown>((resolve, reject) => {
    const abort = () => reject(new DOMException("Task run wait aborted", "AbortError"));
    signal.addEventListener("abort", abort, {once: true});
    if (signal.aborted) abort();
    pending.then(value => { signal.removeEventListener("abort", abort); if (!signal.aborted) resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
  signal.throwIfAborted();
  return value;
}
async function checkedInvoke(command: string, args: Record<string, unknown>, signal: AbortSignal): Promise<TaskRunStatus> {
  signal.throwIfAborted();
  if (!taskRunNative()) return unavailableTaskRun();
  const value = await boundedInvoke(command, args, signal);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > taskRunMaxStatusBytes) throw new Error("task_run_contract_invalid");
  return validateTaskRunStatus(value);
}
export function readTaskRun(signal: AbortSignal) { return checkedInvoke("local_task_run_status", {}, signal); }
export async function startTaskRun(request: TaskRunStartRequest, signal: AbortSignal) {
  const checked = validateTaskRunStart(request);
  const status = await checkedInvoke("local_task_run_start", {request: checked}, signal);
  if (status.availability === "available" && (!status.operation || status.operation.request_id !== checked.request_id ||
    status.operation.profile_id !== checked.profile_id || status.operation.task_id !== checked.task_id)) throw new Error("task_run_contract_invalid");
  return status;
}
export async function cancelTaskRun(request: TaskRunCancelRequest, signal: AbortSignal) {
  const checked = validateTaskRunCancel(request);
  const status = await checkedInvoke("local_task_run_cancel", {request: checked}, signal);
  if (status.availability === "available" && (!status.operation || status.operation.request_id !== checked.request_id ||
    status.operation.revision < checked.expected_revision)) throw new Error("task_run_contract_invalid");
  return status;
}
