import type { TaskContract, ExecutionContext } from "@commongrid/task-schema";
import { validateExecution } from "@commongrid/task-schema";
export { parseClaudeLine, parseCodexAppServerLine } from "./provider-events.ts";
export { buildArtifactBundle, artifactLimits, safeArtifactPath, inspectArtifactText } from "./artifact-bundle.ts";
export type { ArtifactBinding, ArtifactFile, ArtifactScanner } from "./artifact-bundle.ts";

export { normalizeCodexQuota, sanitizeQuotaObservation } from "./quota-observation.ts";
export type { QuotaWindow, QuotaObservation } from "./quota-observation.ts";

export interface AgentEvent {
  type: "session" | "started" | "message" | "completed" | "error" | "unknown";
  text?: string;
  sessionId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    source: "client_reported";
  };
}
export interface AgentAdapter {
  readonly provider: "codex" | "claude-code";
  readonly version: string;
  parseLine(line: string): AgentEvent;
  // Invocation description only: no host process or credential access.
  describeInvocation(
    task: TaskContract,
    execution: ExecutionContext,
  ): { binary: string; args: string[]; stdin: string };
}
const maxLineBytes = 1_048_576;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function parseCodexLine(line: string): AgentEvent {
  if (new TextEncoder().encode(line).length > maxLineBytes)
    return { type: "error", text: "event_too_large" };
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return { type: "error", text: "invalid_json_event" };
  }
  if (!record(event) || typeof event.type !== "string")
    return { type: "error", text: "invalid_event" };
  if (event.type === "thread.started")
    return typeof event.thread_id === "string"
      ? { type: "session", sessionId: event.thread_id }
      : { type: "error", text: "missing_thread_id" };
  if (event.type === "turn.started") return { type: "started" };
  if (
    event.type === "item.completed" &&
    record(event.item) &&
    event.item.type === "agent_message" &&
    typeof event.item.text === "string"
  )
    return { type: "message", text: event.item.text };
  if (event.type === "turn.completed") {
    if (!record(event.usage)) return { type: "completed" };
    const input = event.usage.input_tokens;
    const output = event.usage.output_tokens;
    if (
      typeof input !== "number" ||
      typeof output !== "number" ||
      !Number.isSafeInteger(input) ||
      !Number.isSafeInteger(output) ||
      input < 0 ||
      output < 0
    )
      return { type: "error", text: "invalid_usage" };
    return {
      type: "completed",
      usage: {
        inputTokens: input,
        outputTokens: output,
        source: "client_reported",
      },
    };
  }
  if (event.type === "error" || event.type === "turn.failed")
    return { type: "error", text: "provider_error" };
  return { type: "unknown" }; // Unknown protocol fields never become trusted progress.
}
export const codexAdapter: AgentAdapter = {
  provider: "codex",
  version: "0.1.0",
  parseLine: parseCodexLine,
  describeInvocation(task, context) {
    validateExecution(context, task);
    if (context.agent.provider !== "codex")
      throw new Error("adapter/provider mismatch");
    const strategy = task.strategies.find((s) => s.id === context.strategy_id)!;
    return {
      binary: "codex",
      args: ["exec", "--json", "--ephemeral", "--sandbox", "read-only", "-"],
      stdin: `${task.prompt}\n\nApproved strategy (${strategy.id}):\n${strategy.instructions}`,
    };
  },
};

export interface TaskSandboxSpec {
  image: string;
  workspaceVolume: string;
  cpu: number;
  memoryMb: number;
}
// Task-tools container only. Authentication/CLI runtime is a separate, unproven boundary.
export function describeTaskContainer(spec: TaskSandboxSpec): string[] {
  if (
    !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(spec.image) ||
    spec.image.endsWith("0".repeat(64))
  )
    throw new Error("approved pinned image required");
  if (!/^cg-workspace-[a-z0-9-]{1,80}$/.test(spec.workspaceVolume))
    throw new Error("opaque workspace volume required");
  if (!Number.isInteger(spec.cpu) || spec.cpu < 1 || spec.cpu > 64)
    throw new Error("invalid cpu limit");
  if (
    !Number.isInteger(spec.memoryMb) ||
    spec.memoryMb < 256 ||
    spec.memoryMb > 262144
  )
    throw new Error("invalid memory limit");
  return [
    "create",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65532:65532",
    "--pids-limit",
    "128",
    "--cpus",
    String(spec.cpu),
    "--memory",
    `${spec.memoryMb}m`,
    "--memory-swap",
    `${spec.memoryMb}m`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--mount",
    `type=volume,src=${spec.workspaceVolume},dst=/task,volume-nocopy`,
    "--workdir",
    "/task",
    spec.image,
  ];
}
