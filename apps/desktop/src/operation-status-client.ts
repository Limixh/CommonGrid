/// <reference types="vite/client" />
import { invoke, isTauri } from "@tauri-apps/api/core";
import { validateRecoveryStatus, type RecoveryStatus } from "@commongrid/agent-adapters/recovery";

const responseByteLimit = 1048576;
export function operationStatusTransport(): "native" | "development" | "unavailable" {
  // A native failure must never switch to the developer journal.
  if (isTauri()) return "native";
  return import.meta.env.DEV ? "development" : "unavailable";
}

/** Invoke cannot be cancelled, so stop waiting and consume its late completion. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Operation status aborted", "AbortError"));
    signal.addEventListener("abort", abort, {once: true});
    if (signal.aborted) abort();
    pending.then(value => {
      signal.removeEventListener("abort", abort);
      if (!signal.aborted) resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

async function developmentStatus(signal: AbortSignal): Promise<unknown> {
  const response = await fetch("/local-operation-status", {credentials: "same-origin", signal});
  if (!response.ok || !response.body) throw new Error("operation_status_unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", {fatal: true});
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > responseByteLimit) throw new Error("operation_status_response_invalid");
      body += decoder.decode(chunk.value, {stream: true});
    }
    body += decoder.decode();
    return JSON.parse(body);
  } finally {
    // Also release an oversized response without waiting for the rest of it.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readOperationStatus(signal: AbortSignal): Promise<RecoveryStatus> {
  signal.throwIfAborted();
  const transport = operationStatusTransport();
  if (transport === "unavailable") return validateRecoveryStatus({
    status: "unavailable", reason: "native_recovery_unavailable", execution_enabled: false,
    automatic_recovery: false, worker_quiescence: "unknown", daemon_state: "unknown", operations: [],
  });
  const value = await abortable(transport === "native"
    ? invoke<unknown>("local_operation_status")
    : developmentStatus(signal), signal);
  signal.throwIfAborted();
  // Native IPC has already deserialized its value; bound it before validation/cloning.
  if (transport === "native" && new TextEncoder().encode(JSON.stringify(value)).byteLength > responseByteLimit)
    throw new Error("operation_status_response_invalid");
  return validateRecoveryStatus(value);
}
