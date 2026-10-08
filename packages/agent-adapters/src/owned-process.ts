import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export interface CommandResult { code: number; stdout: string; stderr: string }
export class CommandError extends Error {
  constructor(readonly reason: "failed" | "timeout" | "cancelled" | "output_limit") {
    super(`docker_${reason}`);
  }
}
export interface CommandOptions { timeoutMs?: number; signal?: AbortSignal; maxBytes?: number; stdin?: Readable }

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
      if (child.exitCode === null && child.pid) {
        if (process.platform === "win32") {
          spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
        } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      }
      finish();
      reject(new CommandError(reason));
    };
    const abort = () => stop("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    if (options.stdin && child.stdin) {
      options.stdin.on("error", () => stop("failed"));
      child.stdin.on("error", () => stop("failed"));
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
