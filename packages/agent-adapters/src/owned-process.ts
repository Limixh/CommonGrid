import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

export interface CommandResult { code: number; stdout: string; stderr: string }
export interface CommandCleanup {
  method: "none" | "windows_taskkill" | "posix_process_group" | "owned_root_handle";
  // A launcher reporting termination is evidence, not proof that every
  // descendant is absent. Callers may verify their own namespace separately.
  status: "not_started" | "termination_reported" | "unconfirmed";
  helperExitCode?: number | null;
}
export class CommandError extends Error {
  constructor(readonly reason: "failed" | "timeout" | "cancelled" | "output_limit", readonly cleanup: Promise<CommandCleanup> = Promise.resolve({ method: "none", status: "not_started" })) {
    super(`docker_${reason}`);
  }
}
export interface CommandOptions { timeoutMs?: number; signal?: AbortSignal; maxBytes?: number; stdin?: Readable }

const cleanupBudgetMs = 5000;
const rootRunning = (child: ChildProcess) => child.exitCode === null && child.signalCode === null && child.pid !== undefined;
function rootFallback(child: ChildProcess) {
  // Use the existing owned handle only while it remains open. Never redispatch
  // a numeric PID after observing exit, because that PID may have been reused.
  if (rootRunning(child)) { try { child.kill("SIGKILL"); } catch {} }
}
function terminateOwnedCommand(child: ChildProcess): Promise<CommandCleanup> {
  if (!rootRunning(child)) return Promise.resolve({ method: "none", status: "unconfirmed" });
  return new Promise(resolve => {
    let settled = false, rootExited = false, helperReported = false;
    let helper: ChildProcess | undefined;
    const finish = (result: CommandCleanup) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.off("exit", rootExit);
      resolve(result);
    };
    const reported = () => {
      if (rootExited && helperReported) finish({ method: process.platform === "win32" ? "windows_taskkill" : "posix_process_group", status: "termination_reported", ...(process.platform === "win32" ? { helperExitCode: 0 } : {}) });
    };
    const rootExit = () => { rootExited = true; reported(); };
    child.once("exit", rootExit);
    const timer = setTimeout(() => {
      if (helper && helper.exitCode === null && helper.signalCode === null) { try { helper.kill("SIGKILL"); } catch {} }
      rootFallback(child);
      finish({ method: process.platform === "win32" ? "windows_taskkill" : "posix_process_group", status: "unconfirmed", ...(helper ? { helperExitCode: helper.exitCode } : {}) });
    }, cleanupBudgetMs);
    if (process.platform === "win32") {
      try {
        helper = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        helper.once("error", () => { rootFallback(child); finish({ method: "windows_taskkill", status: "unconfirmed" }); });
        helper.once("close", code => {
          if (settled) return;
          if (code !== 0) { rootFallback(child); finish({ method: "windows_taskkill", status: "unconfirmed", helperExitCode: code }); }
          else { helperReported = true; reported(); }
        });
      } catch { rootFallback(child); finish({ method: "windows_taskkill", status: "unconfirmed" }); }
    } else {
      try { process.kill(-child.pid!, "SIGKILL"); helperReported = true; reported(); }
      catch { rootFallback(child); finish({ method: "owned_root_handle", status: "unconfirmed" }); }
    }
  });
}

// Internal trusted launcher. Never accepts executable paths from task input.
// Reject promptly even when a descendant has inherited the output pipes.
export function runOwnedCommand(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 10_000, maxBytes = options.maxBytes ?? 1_048_576;
  if (options.signal?.aborted) return Promise.reject(new CommandError("cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, detached: process.platform !== "win32", stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, reason: CommandError["reason"] | undefined;
    const finish = () => { clearTimeout(timer); options.stdin?.destroy(); options.signal?.removeEventListener("abort", abort); };
    const stop = (next: CommandError["reason"]) => {
      if (reason) return;
      reason = next;
      const cleanup = terminateOwnedCommand(child);
      // Failure output is no longer consumed. Descendants can retain inherited
      // pipes after the root exits; close only our handles so rejection and host
      // shutdown do not depend on those descendants releasing them.
      child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
      finish();
      reject(new CommandError(reason, cleanup));
    };
    const abort = () => stop("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    child.stdout!.on("error", () => stop("failed"));
    child.stderr!.on("error", () => stop("failed"));
    child.stdin?.on("error", () => stop("failed"));
    if (options.stdin && child.stdin) {
      options.stdin.on("error", () => stop("failed"));
      options.stdin.pipe(child.stdin);
    }
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (reason) return;
      bytes += chunk.length;
      if (bytes > maxBytes) stop("output_limit"); else target.push(chunk);
    };
    child.stdout!.on("data", collect(stdout)); child.stderr!.on("data", collect(stderr));
    child.on("error", () => { finish(); reject(new CommandError("failed")); });
    child.on("close", (code) => {
      finish();
      if (!reason) resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}
