import { useEffect, useRef, useState } from "react";
import type { ManagedProfile } from "@commongrid/agent-adapters/managed-profiles";
import type { TaskRunOperation, TaskRunStartRequest, TaskRunStatus } from "@commongrid/agent-adapters/task-run";
import { sameTaskRunLeaseContext } from "@commongrid/agent-adapters/task-run";
import { AccountExpired, type Account } from "./account-api";
import type { CatalogExecutionSelection } from "./execution-selection";
import type { LeaseDetail, SubmissionDetail } from "./contribution-client";
import {
  CentralExecutionError, centralLeaseAction, readCentralLease, reserveCentralTask, submitCentralResult, uploadCentralResult,
  type ArtifactReceipt, type ExecutionCapability, type TimedLeaseDetail,
} from "./central-execution-client";
import { cancelTaskRun, exportTaskRunResultPackage, readTaskRun, startTaskRun } from "./task-run-client";
import { readRunLimits } from "./run-limits-client";

export type CentralTaskView = {
  requestId: string; profileId: string; taskId: string; lease: LeaseDetail | null;
  phase: "preparing" | "running" | "ready" | "submitting" | "submitted" | "stopped" | "needs_review" | "error";
  error: string | null; receipt: SubmissionDetail | null;
};
type Transaction = {
  owner: string; selection: CatalogExecutionSelection; capability: ExecutionCapability; profile: ManagedProfile;
  requestId: string; reserveKey: string; uploadKey: string; submitKey: string; limitSec: number; limitClamped: boolean;
  lease: TimedLeaseDetail | null; nativeRequest: TaskRunStartRequest | null; nativeAttempted: boolean; startConfirmed: boolean;
  artifact: ArtifactReceipt | null; package: Awaited<ReturnType<typeof exportTaskRunResultPackage>> | null; submissionAttempted: boolean;
  stop: boolean; busy: boolean; phase: CentralTaskView["phase"]; error: string | null; receipt: SubmissionDetail | null;
};
export type CentralTaskControl = {
  required: boolean; available: boolean; view: CentralTaskView | null; retryable: boolean; canSubmit: boolean;
  start: (profile: ManagedProfile, signal: AbortSignal) => Promise<TaskRunStatus>;
  cancel: (operation: TaskRunOperation, signal: AbortSignal) => Promise<void>;
  submit: (operation: TaskRunOperation) => Promise<void>;
};
const ownerOf = (account: Account) => account.state.status === "authenticated"
  ? JSON.stringify([account.state.session.user.provider, account.state.session.user.id]) : null;
// Coordinator answers to a reserve that prove no lease was created (see httpapi apiError).
const definitiveReserveRefusals = new Set(["budget_exhausted", "capacity_exhausted", "stale_contract", "lease_or_task_closed", "invalid_request", "not_found", "idempotency_conflict"]);
export const isDefinitiveReserveRefusal = (error: unknown) => error instanceof CentralExecutionError && definitiveReserveRefusals.has(error.code);
const closed = (lease: LeaseDetail) => ["completed", "released", "expired"].includes(lease.state);

// App owns this controller, so navigation does not abandon a budget lease.
// Browser credentials are confined to this same-origin client and never enter IPC.
export function useCentralTask(account: Account, localLimitSec: number) {
  const currentAccount = useRef(account); currentAccount.current = account;
  const owner = ownerOf(account);
  const tx = useRef<Transaction | null>(null);
  const requests = useRef(new Set<AbortController>());
  const [view, setView] = useState<CentralTaskView | null>(null);
  function publish(value: Transaction) {
    if (tx.current !== value || value.owner !== ownerOf(currentAccount.current)) return;
    setView({requestId: value.requestId, profileId: value.profile.profile_id, taskId: value.selection.task.id,
      lease: value.lease, phase: value.phase, error: value.error, receipt: value.receipt});
  }
  function csrf(value: Transaction): string {
    const state = currentAccount.current.state;
    if (state.status !== "authenticated" || value.owner !== ownerOf(currentAccount.current)) throw new AccountExpired();
    return state.session.csrf_token;
  }
  function checkLease(value: Transaction, lease: TimedLeaseDetail) {
    const task = value.selection.task;
    if (lease.taskId !== task.id || lease.taskVersion !== task.task_version || lease.contractHash !== task.contract_hash ||
      lease.strategyId !== task.strategy_id || lease.effectiveLimitSec < 1 || lease.effectiveLimitSec > value.capability.max_limit_sec ||
      value.lease && (value.lease.id !== lease.id || value.lease.attemptId !== lease.attemptId || value.lease.effectiveLimitSec !== lease.effectiveLimitSec ||
        value.lease.reservedMs !== lease.reservedMs || value.lease.createdAt !== lease.createdAt || value.lease.expiresAt !== lease.expiresAt)) throw new CentralExecutionError("response_invalid");
    value.lease = {...lease, receivedDeadlineMs: Math.min(lease.receivedDeadlineMs ?? Infinity, value.lease?.receivedDeadlineMs ?? Infinity)};
  }
  async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal, timeoutMs = 10000): Promise<T> {
    const controller = new AbortController(); requests.current.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    parent?.addEventListener("abort", abort, {once: true});
    if (parent?.aborted) controller.abort();
    try { return await work(controller.signal); }
    finally { window.clearTimeout(timeout); requests.current.delete(controller); parent?.removeEventListener("abort", abort); }
  }
  function failure(value: Transaction, error: unknown) {
    if (tx.current !== value) return;
    if (error instanceof AccountExpired) { currentAccount.current.expire(); return; }
    value.error = error instanceof CentralExecutionError ? error.code : "request_failed";
    value.phase = "error";
    // A definitive refusal before any lease exists leaves nothing to retry or settle: the transaction is terminal
    // and a later start (same or another task) replaces it. A lost reserve response stays retryable by key.
    if (!value.lease && !value.nativeAttempted && isDefinitiveReserveRefusal(error)) { value.stop = true; value.phase = "stopped"; }
    publish(value);
  }
  async function settle(value: Transaction, signal: AbortSignal) {
    if (!value.lease) { value.phase = "stopped"; publish(value); return; }
    if (!closed(value.lease)) checkLease(value, await centralLeaseAction(value.lease.id, "stop", csrf(value), signal));
    const status = await readTaskRun(signal), operation = status.operation;
    // A native result is associated only by the immutable run request, never by selected task.
    if (!value.nativeAttempted || operation?.request_id === value.requestId && operation.phase === "finished" && operation.cleanup === "verified") {
      if (!closed(value.lease)) checkLease(value, await centralLeaseAction(value.lease.id, "end", csrf(value), signal));
      value.phase = "stopped";
    } else {
      value.phase = "needs_review";
      if (operation?.request_id === value.requestId && operation.phase !== "finished" && operation.phase !== "cleaning")
        await cancelTaskRun({schema_version: "1.0", request_id: value.requestId, expected_revision: operation.revision}, signal);
    }
    value.error = null; publish(value);
  }
  async function finalizeSubmission(value: Transaction, signal: AbortSignal) {
    if (!value.lease || !value.artifact) throw new CentralExecutionError("response_invalid");
    const receipt = await submitCentralResult(value.lease.id, {task_version: value.selection.task.task_version,
      contract_hash: value.selection.task.contract_hash, base_commit: value.selection.task.base_commit,
      request_key: value.submitKey, artifact: value.artifact}, csrf(value), signal);
    if (receipt.taskId !== value.selection.task.id) throw new CentralExecutionError("response_invalid");
    value.receipt = receipt;
    value.phase = "submitted"; value.lease = {...value.lease, state: "completed"}; value.package = null; value.error = null; publish(value);
  }
  async function tick() {
    const value = tx.current;
    if (!value || value.busy || value.owner !== ownerOf(currentAccount.current) || !value.lease || value.receipt || value.phase === "stopped") return;
    value.busy = true;
    try {
      await bounded(async signal => {
        // A result may have committed even when its response was lost. Replay
        // that exact, already approved submission before treating a closed lease as stopped.
        if (value.submissionAttempted && value.artifact) { await finalizeSubmission(value, signal); return; }
        if (closed(value.lease!) || (value.lease!.receivedDeadlineMs ?? Date.parse(value.lease!.expiresAt)) <= Date.now()) value.stop = true;
        if (!value.nativeAttempted && !value.stop) return;
        if (value.stop) { await settle(value, signal); return; }
        const status = await readTaskRun(signal), operation = status.operation;
        if (operation?.request_id === value.requestId) value.startConfirmed = true;
        if (operation?.request_id === value.requestId && operation.phase !== "finished" &&
          value.nativeRequest?.lease_context && value.nativeRequest.lease_context.expires_at_ms <= Date.now()) {
          value.stop = true; await settle(value, signal); return;
        }
        if (operation?.request_id === value.requestId && operation.phase === "finished") {
          if (operation.outcome === "passed" && operation.cleanup === "verified") value.phase = "ready";
          else { value.stop = true; await settle(value, signal); return; }
        }
        checkLease(value, await centralLeaseAction(value.lease!.id, "heartbeat", csrf(value), signal));
        if (value.lease!.state !== "active") { value.stop = true; await settle(value, signal); return; }
        if (operation?.request_id === value.requestId && operation.phase !== "finished") value.phase = "running";
        value.error = null; publish(value);
      });
    } catch (error) {
      if (error instanceof CentralExecutionError && ["lease_or_task_closed", "stale_contract"].includes(error.code)) {
        if (value.submissionAttempted) {
          try {
            await bounded(async signal => {
              checkLease(value, await readCentralLease(value.lease!.id, signal));
              if (["released", "expired"].includes(value.lease!.state)) { value.stop = true; value.phase = "stopped"; value.error = error.code; publish(value); }
              else failure(value, error);
            });
          } catch (readError) { failure(value, readError); }
          return;
        }
        value.stop = true;
        try { await bounded(async signal => { checkLease(value, await readCentralLease(value.lease!.id, signal)); await settle(value, signal); }); }
        catch (settleError) { failure(value, settleError); }
      } else failure(value, error);
    }
    finally { value.busy = false; publish(value); }
  }
  useEffect(() => {
    for (const controller of requests.current) controller.abort();
    tx.current = null; setView(null);
    return () => { for (const controller of requests.current) controller.abort(); };
  }, [owner]);
  useEffect(() => {
    const interval = window.setInterval(() => { void tick(); }, 15000);
    return () => window.clearInterval(interval);
  }, []);

  function control(selection: CatalogExecutionSelection | null, capability: ExecutionCapability | null, required: boolean): CentralTaskControl {
    const value = tx.current;
    const belongs = !!value && !!selection && value.owner === owner && value.selection.task.id === selection.task.id &&
      value.selection.task.contract_hash === selection.task.contract_hash && value.selection.task.strategy_id === selection.task.strategy_id;
    const available = !!owner && !!selection && !!capability && capability.contract_hash === selection.task.contract_hash &&
      capability.task_version === selection.task.task_version && capability.base_commit === selection.task.base_commit && capability.strategies.includes(selection.task.strategy_id);
    const safeView = belongs && view?.requestId === value.requestId ? view : null;
    return {required, available: available && (!value || belongs || value.receipt !== null || value.phase === "stopped"), view: safeView,
      retryable: belongs && value.phase === "error" && !value.startConfirmed && value.receipt === null && !value.stop,
      canSubmit: belongs && !!value.lease && value.nativeAttempted && !value.stop && (!closed(value.lease) || value.submissionAttempted) && !value.receipt && !value.busy,
      async start(profile, signal) {
        if (!available || !selection || !capability) throw new CentralExecutionError("execution_unavailable");
        let run = tx.current;
        if (!belongs || !run || run.receipt || run.phase === "stopped") {
          if (run && !run.receipt && run.phase !== "stopped") throw new CentralExecutionError("lease_pending");
          run = {owner: owner!, selection, capability, profile, requestId: crypto.randomUUID(), reserveKey: crypto.randomUUID(),
            uploadKey: crypto.randomUUID(), submitKey: crypto.randomUUID(), limitSec: Math.max(1, Math.min(1200, capability.max_limit_sec, Math.floor(localLimitSec))), limitClamped: false,
            lease: null, nativeRequest: null, nativeAttempted: false, startConfirmed: false,
            artifact: null, package: null, submissionAttempted: false, stop: false, busy: false, phase: "preparing", error: null, receipt: null};
          tx.current = run;
        }
        if (run.profile.profile_id !== profile.profile_id || run.busy) throw new CentralExecutionError("lease_pending");
        run.busy = true; run.phase = "preparing"; run.error = null; publish(run);
        const captured = run;
        try {
          return await bounded(async inner => {
            if (!captured.lease && !captured.limitClamped) {
              // Cap the request by the native effective maximum once, so a retried reserve keeps an identical body.
              // A missing or fail-closed answer leaves the request as is; native enforces its limits when the run starts.
              try {
                const native = await readRunLimits(inner);
                if (native.availability === "available" && native.effective.startable && native.effective.reason !== "local_budget_unavailable")
                  captured.limitSec = Math.max(1, Math.min(captured.limitSec, native.effective.max_sec));
              } catch { inner.throwIfAborted(); }
              captured.limitClamped = true;
            }
            if (!captured.lease) checkLease(captured, await reserveCentralTask(selection.task.id, {
              task_version: selection.task.task_version, contract_hash: selection.task.contract_hash, strategy_id: selection.task.strategy_id,
              request_key: captured.reserveKey, limit_sec: captured.limitSec,
            }, csrf(captured), inner));
            if (captured.lease!.state === "reserved") checkLease(captured, await centralLeaseAction(captured.lease!.id, "start", csrf(captured), inner));
            if (captured.lease!.state !== "active" || (captured.lease!.receivedDeadlineMs ?? Date.parse(captured.lease!.expiresAt)) <= Date.now()) throw new CentralExecutionError("lease_or_task_closed");
            captured.nativeRequest ??= {schema_version: "1.0", request_id: captured.requestId, profile_id: profile.profile_id,
              task_id: selection.task.id as TaskRunStartRequest["task_id"], strategy_id: selection.task.strategy_id, approved: true,
              lease_context: {lease_id: captured.lease!.id, attempt_id: captured.lease!.attemptId, task_version: selection.task.task_version,
                contract_hash: selection.task.contract_hash, base_commit: selection.task.base_commit, strategy_id: selection.task.strategy_id,
                time_limit_sec: captured.lease!.effectiveLimitSec, expires_at_ms: captured.lease!.receivedRunDeadlineMs ?? captured.lease!.receivedDeadlineMs ?? Date.parse(captured.lease!.expiresAt)}};
            captured.nativeAttempted = true;
            const status = await startTaskRun(captured.nativeRequest, inner);
            if (status.operation?.request_id !== captured.requestId || status.operation.lease_context?.lease_id !== captured.lease!.id)
              throw new CentralExecutionError("response_invalid");
            captured.startConfirmed = true;
            captured.phase = status.operation.phase === "finished" && status.operation.outcome === "passed" ? "ready" : "running";
            publish(captured); return status;
          }, signal);
        } catch (error) { failure(captured, error); throw error; }
        finally { captured.busy = false; publish(captured); }
      },
      async cancel(operation, signal) {
        const run = tx.current;
        if (!run || run.requestId !== operation.request_id || run.owner !== ownerOf(currentAccount.current)) return;
        run.stop = true;
        try { await bounded(inner => settle(run, inner), signal); }
        catch (error) { failure(run, error); throw error; }
      },
      async submit(operation) {
        const run = tx.current;
        if (!run || !run.lease || run.busy || run.receipt || run.stop || run.requestId !== operation.request_id ||
          operation.phase !== "finished" || operation.outcome !== "passed" || operation.cleanup !== "verified" ||
          operation.profile_id !== run.profile.profile_id || operation.provider !== run.profile.provider || operation.task_id !== run.selection.task.id ||
          operation.strategy_id !== run.selection.task.strategy_id || !operation.lease_context || !run.nativeRequest?.lease_context ||
          !sameTaskRunLeaseContext(operation.lease_context, run.nativeRequest.lease_context)) return;
        run.busy = true; run.phase = "submitting"; run.error = null; publish(run);
        try {
          await bounded(async signal => {
            const resultPackage = run.package ?? await exportTaskRunResultPackage({schema_version: "1.0", request_id: run.requestId, expected_revision: operation.revision}, signal);
            if (resultPackage.lease_id !== run.lease!.id) throw new CentralExecutionError("response_invalid");
            const bytes = Uint8Array.from(atob(resultPackage.bytes_base64), c => c.charCodeAt(0));
            if (btoa(String.fromCharCode(...bytes)) !== resultPackage.bytes_base64) throw new CentralExecutionError("response_invalid");
            const digest = await crypto.subtle.digest("SHA-256", bytes);
            const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
            if (bytes.length !== resultPackage.size_bytes || actual !== resultPackage.sha256) throw new CentralExecutionError("response_invalid");
            run.package = resultPackage;
            run.artifact ??= await uploadCentralResult(run.lease!.id, run.uploadKey, bytes, actual, csrf(run), signal);
            run.submissionAttempted = true;
            await finalizeSubmission(run, signal);
          }, undefined, 30000);
        } catch (error) { failure(run, error); }
        finally { run.busy = false; publish(run); }
      },
    };
  }
  return {control};
}
