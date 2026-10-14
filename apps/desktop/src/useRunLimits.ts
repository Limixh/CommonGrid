import { useCallback, useEffect, useRef, useState } from "react";
import { validateRunLimitsSave, type RunLimitsStatus } from "@commongrid/agent-adapters/task-run";
import { readRunLimits, saveRunLimits } from "./run-limits-client";

// Fixed codes only; never raw native text.
export type RunLimitsError = "run_limits_unavailable" | "run_limits_contract_invalid" | "run_limits_invalid_input";
const sanitize = (error: unknown): RunLimitsError =>
  error instanceof Error && (error.message === "run_limits_contract_invalid" || error.message === "run_limits_invalid_input")
    ? error.message : "run_limits_unavailable";

// Reads once on mount; later reads only through refresh(). No polling loop.
export function useRunLimits() {
  const [status, setStatus] = useState<RunLimitsStatus | null>(null);
  const [error, setError] = useState<RunLimitsError | null>(null);
  const [pending, setPending] = useState(false);
  const current = useRef<AbortController | null>(null);
  const alive = useRef(true);

  const run = useCallback(async (task: (signal: AbortSignal) => Promise<RunLimitsStatus>): Promise<boolean> => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setPending(true);
    try {
      const next = await task(controller.signal);
      if (!alive.current || current.current !== controller) return false;
      setStatus(next); setError(null);
      return true;
    } catch (caught) {
      if (!alive.current || current.current !== controller || controller.signal.aborted) return false;
      setError(sanitize(caught));
      return false;
    } finally {
      if (alive.current && current.current === controller) { current.current = null; setPending(false); }
    }
  }, []);

  const refresh = useCallback(() => run(signal => readRunLimits(signal)), [run]);
  const save = useCallback((attempt_sec: number, daily_sec: number) => {
    let request;
    try { request = validateRunLimitsSave({schema_version: "1.0", attempt_sec, daily_sec}); }
    catch { setError("run_limits_invalid_input"); return Promise.resolve(false); }
    return run(signal => saveRunLimits(request, signal));
  }, [run]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; current.current?.abort(); current.current = null; };
  }, [refresh]);

  return {status, error, pending, refresh, save};
}
