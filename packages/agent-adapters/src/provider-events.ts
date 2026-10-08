import type { AgentEvent } from "./index.ts";
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function decode(line: string): Record<string, any> | undefined {
  if (new TextEncoder().encode(line).length > 1_048_576) return;
  try { const value = JSON.parse(line); if (record(value)) return value; } catch {}
}
function usage(value: unknown): AgentEvent["usage"] | null | undefined {
  if (value === undefined) return;
  if (!record(value) || ![value.input_tokens, value.output_tokens].every((count) => Number.isSafeInteger(count) && count >= 0)) return null;
  return { inputTokens: value.input_tokens, outputTokens: value.output_tokens, source: "client_reported" };
}
export function parseClaudeLine(line: string): AgentEvent {
  const value = decode(line);
  if (!value || typeof value.type !== "string") return { type: "error", text: "invalid_json_event" };
  if (value.type === "system" && value.subtype === "init")
    return typeof value.session_id === "string" ? { type: "session", sessionId: value.session_id } : { type: "error", text: "missing_session_id" };
  if (value.type === "assistant" && record(value.message) && Array.isArray(value.message.content)) {
    const text = value.message.content.filter((item: unknown) => record(item) && item.type === "text" && typeof item.text === "string").map((item: any) => item.text).join("");
    return text ? { type: "message", text } : { type: "unknown" };
  }
  if (value.type === "result") {
    if (value.subtype !== "success" || value.is_error !== false) return { type: "error", text: "provider_error" };
    const reported = usage(value.usage);
    if (reported === null) return { type: "error", text: "invalid_usage" };
    return { type: "completed", ...(reported ? { usage: reported } : {}) };
  }
  return { type: "unknown" };
}
export function parseCodexAppServerLine(line: string): AgentEvent {
  const value = decode(line);
  if (!value) return { type: "error", text: "invalid_json_event" };
  if (value.error) return { type: "error", text: "provider_error" };
  if (!record(value.params)) return { type: "unknown" };
  if (value.method === "thread/started")
    return typeof value.params.thread?.id === "string" ? { type: "session", sessionId: value.params.thread.id } : { type: "error", text: "missing_thread_id" };
  if (value.method === "turn/started") return { type: "started" };
  if (value.method === "item/completed" && value.params.item?.type === "agentMessage" && typeof value.params.item.text === "string")
    return { type: "message", text: value.params.item.text };
  if (value.method === "turn/completed")
    return value.params.turn?.status === "completed" ? { type: "completed" } : { type: "error", text: "provider_error" };
  return { type: "unknown" };
}
