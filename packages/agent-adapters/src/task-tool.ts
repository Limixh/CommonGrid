import type { TaskToolsRuntime } from "./task-runtime.ts";
export interface TaskToolArguments { argv: string[]; timeout_ms?: number }
export function validateTaskTool(value: unknown): TaskToolArguments {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_tool_arguments");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["argv", "timeout_ms"].includes(key))) throw new Error("invalid_tool_arguments");
  const argv = record.argv;
  if (!Array.isArray(argv) || !argv.length || argv.length > 128 ||
      argv.some((arg) => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 65_536) ||
      !argv[0] || argv[0].startsWith("-") || argv.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 131_072)
    throw new Error("invalid_tool_arguments");
  const timeout = record.timeout_ms;
  if (timeout !== undefined && (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 30_000))
    throw new Error("invalid_tool_arguments");
  return { argv: [...argv], ...(timeout !== undefined ? { timeout_ms: timeout as number } : {}) };
}
export async function executeTaskTool(runtime: Pick<TaskToolsRuntime, "exec">, value: unknown, signal?: AbortSignal) {
  try {
    const arguments_ = validateTaskTool(value);
    const result = await runtime.exec(arguments_.argv, { timeoutMs: arguments_.timeout_ms, ...(signal ? {signal} : {}) });
    return { exit_code: result.code, stdout: result.stdout, stderr: result.stderr };
  } catch { return { error: "task_tool_failed" }; }
}
