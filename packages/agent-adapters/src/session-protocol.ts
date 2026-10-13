// Fixture-testable boundary helpers. Never persist raw provider errors or identities.
import { Transform, type TransformCallback } from "node:stream";
export type ProviderCategory = "auth_required" | "session_expired" | "quota" | "network" | "tls" | "http_403" | "model" | "permission" | "canceled" | "deadline" | "protocol" | "identity" | "process" | "unsupported" | "unclassified";
export const isRecord = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
export class ProviderFailure extends Error {
  constructor(readonly category: ProviderCategory) { super(`managed_provider_${category}`); }
}
export class OperationCancellation {
  private canceled = false;
  cancel() { this.canceled = true; }
  assertActive() { if (this.canceled) throw new ProviderFailure("canceled"); }
}
export function classifyProviderFailure(value: unknown): ProviderCategory {
  if (value instanceof ProviderFailure) return value.category;
  const message = (typeof value === "string" ? value : isRecord(value) && typeof value.message === "string" ? value.message : "").slice(0, 65_536);
  if (/expired.{0,32}(session|token|credential)|(?:session|token|credential).{0,32}expired|refresh.{0,24}(failed|invalid|revoked)|invalid_grant/i.test(message)) return "session_expired";
  if (/quota|usage[ _-]?limit|rate[ _-]?limit|too many requests|\b429\b/i.test(message)) return "quota";
  if (/\b401\b|authenticat|unauthorized|log[ -]?in|oauth|api[ _-]?key/i.test(message)) return "auth_required";
  if (/cancel(?:ed|led)|interrupted|aborted/i.test(message)) return "canceled";
  if (/deadline|timed? out|timeout/i.test(message)) return "deadline";
  if (/certificate|\btls\b|\bssl\b|CERT_|UNKNOWN_CA/i.test(message)) return "tls";
  if (/\b403\b|forbidden/i.test(message)) return "http_403";
  if (/model.{0,32}(not found|not supported|unavailable)|invalid.{0,16}model/i.test(message)) return "model";
  if (/permission|denied|restricted/i.test(message)) return "permission";
  if (/connect|network|socket|econn|ehost|enotfound|request failed|error sending request|unexpected eof|incomplete message/i.test(message)) return "network";
  if (/invalid.{0,16}param|unknown.{0,16}variant|malformed|protocol/i.test(message)) return "protocol";
  return "unclassified";
}
export function failureCode(error: unknown, fallback = "managed_validation_failed"): string {
  if (error instanceof ProviderFailure) return error.message;
  // Only fixed local codes can enter a report; assertions and provider text cannot.
  return error instanceof Error && /^(?:managed|fixture|claude)_[a-z0-9_]{1,96}$/.test(error.message) ? error.message : fallback;
}
export function assertBridgeHealthy(stats: unknown) {
  if (!isRecord(stats) || stats.control_failure !== false) throw new Error("managed_bridge_control_failed");
}
export function validateCodexIdentity(value: unknown, operation: "status" | "refresh" | "login" | "logout") {
  if (!isRecord(value) || !Object.hasOwn(value, "account")) throw new ProviderFailure("protocol");
  if (value.account !== null && (!isRecord(value.account) || value.account.type !== "chatgpt")) throw new ProviderFailure("identity");
  if ((operation === "login" || operation === "refresh") && value.account === null) throw new ProviderFailure("auth_required");
  if (operation === "logout" && value.account !== null) throw new ProviderFailure("identity");
  return { authenticated: value.account !== null, method: value.account === null ? "none" : "chatgpt" };
}
export function validateClaudeIdentity(value: unknown, requireLogin = false, requireLogout = false) {
  if (!isRecord(value) || typeof value.loggedIn !== "boolean") throw new ProviderFailure("protocol");
  if (value.loggedIn ? value.authMethod !== "claude.ai" : ![undefined, null, "none", "claude.ai"].includes(value.authMethod)) throw new ProviderFailure("identity");
  if (requireLogin && !value.loggedIn) throw new ProviderFailure("auth_required");
  if (requireLogout && value.loggedIn) throw new ProviderFailure("identity");
  return { authenticated: value.loggedIn, method: value.loggedIn ? "claude.ai" : "none" };
}
export function validateClaudeStatus(stdout: string, exitCode: number, requireLogin = false, requireLogout = false) {
  const identity = validateClaudeIdentity(new BoundedJsonLines(262_144, 262_144).decode(stdout), requireLogin, requireLogout);
  // Official auth status may signal an unauthenticated account through exit 1.
  // Only the validated, explicitly logged-out JSON shape admits that status.
  if (exitCode !== 0 && !(exitCode === 1 && !identity.authenticated)) throw new ProviderFailure("process");
  return identity;
}
export function validRpcId(value: unknown): value is number | string {
  return typeof value === "number" ? Number.isSafeInteger(value) && value >= 0 : typeof value === "string" && value.length > 0 && value.length <= 128;
}
function classifyClaudeError(event: Record<string, any>, messages: string[]): ProviderCategory {
  // Official stream error enums are diagnostic codes, not model identities.
  const code = event.error ?? event.api_error_code ?? event.api_error;
  switch (code) {
    case "authentication_failed": case "oauth_org_not_allowed": return "auth_required";
    case "rate_limit": return "quota";
    case "model_not_found": return "model";
  }
  if (event.api_error_status === 401) return "auth_required";
  if (event.api_error_status === 403) return "http_403";
  if (event.api_error_status === 429) return "quota";
  return classifyProviderFailure(messages.join("\n"));
}
/** Only the official text-only synthetic API error bypasses model evidence. */
export function rejectClaudeSyntheticAssistantError(event: unknown): void {
  if (!isRecord(event) || event.type !== "assistant" || event.is_api_error_message !== true ||
      !isRecord(event.message) || event.message.model !== "<synthetic>") return;
  const content = event.message.content;
  if (!Array.isArray(content) || content.length < 1 || content.length > 16 ||
      !content.every(block => isRecord(block) && block.type === "text" && typeof block.text === "string")) throw new ProviderFailure("protocol");
  throw new ProviderFailure(classifyClaudeError(event, content.map(block => block.text.slice(0, 2_048))));
}
export function validateClaudeResult(event: unknown) {
  if (!isRecord(event) || event.type !== "result" || typeof event.is_error !== "boolean" || typeof event.subtype !== "string") throw new ProviderFailure("protocol");
  if (event.subtype === "success" && event.is_error === false) return;
  // The pinned CLI also uses success-subtype results with is_error=true for API failures.
  if (!["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"].includes(event.subtype) || !event.is_error) throw new ProviderFailure("protocol");
  const messages = [typeof event.result === "string" ? event.result.slice(0, 32_768) : "", ...(Array.isArray(event.errors) ? event.errors.slice(0, 16).filter((value: unknown) => typeof value === "string").map((value: string) => value.slice(0, 2_048)) : [])];
  throw new ProviderFailure(event.subtype === "error_max_budget_usd" ? "quota" : classifyClaudeError(event, messages));
}
export function validateCodexTurn(params: unknown, threadId: string, turnId: string) {
  if (!isRecord(params) || params.threadId !== threadId || !isRecord(params.turn) || params.turn.id !== turnId) throw new ProviderFailure("protocol");
  if (params.turn.status === "completed" && (params.turn.error === null || params.turn.error === undefined)) return;
  if (params.turn.status === "interrupted") throw new ProviderFailure("canceled");
  if (params.turn.status !== "failed") throw new ProviderFailure("protocol");
  throw new ProviderFailure(classifyProviderFailure(params.turn.error));
}
export class TaskCallbackGuard {
  private readonly ids = new Set<number | string>();
  validate(event: unknown, threadId: string | undefined) {
    if (!isRecord(event) || event.method !== "item/tool/call" || !validRpcId(event.id) || this.ids.has(event.id) || this.ids.size >= 16 || !threadId || !isRecord(event.params) || event.params.threadId !== threadId || event.params.tool !== "task_exec" || (event.params.namespace ?? null) !== null || !isRecord(event.params.arguments)) throw new ProviderFailure("protocol");
    this.ids.add(event.id);
    return event.params.arguments;
  }
}
export class BoundedJsonLines {
  private bytes = 0;
  constructor(private readonly totalLimit: number, private readonly lineLimit: number) {}
  decode(line: string): Record<string, any> {
    const bytes = Buffer.byteLength(line); this.bytes += bytes + 1;
    if (bytes > this.lineLimit || this.bytes > this.totalLimit) throw new ProviderFailure("protocol");
    let value: unknown; try { value = JSON.parse(line); } catch { throw new ProviderFailure("protocol"); }
    if (!isRecord(value)) throw new ProviderFailure("protocol");
    return value;
  }
}
// Readline retains incomplete lines. Apply raw byte limits before forwarding any
// chunk into it, including streams that never send a newline or split UTF-8.
export class IncomingLineBytes {
  private bytes = 0;
  private lineBytes = 0;
  private failed = false;
  constructor(private readonly totalLimit: number, private readonly lineLimit: number) {}
  accept(chunk: Uint8Array) {
    if (this.failed) throw new ProviderFailure("protocol");
    this.bytes += chunk.byteLength;
    if (this.bytes > this.totalLimit) { this.failed = true; throw new ProviderFailure("protocol"); }
    for (const byte of chunk) {
      if (byte === 10 || byte === 13) this.lineBytes = 0;
      else if (++this.lineBytes > this.lineLimit) { this.failed = true; throw new ProviderFailure("protocol"); }
    }
  }
}
export class BoundedJsonInput extends Transform {
  private readonly limits: IncomingLineBytes;
  constructor(totalLimit: number, lineLimit: number) { super(); this.limits = new IncomingLineBytes(totalLimit, lineLimit); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    try { this.limits.accept(chunk); callback(null, chunk); }
    catch { callback(new ProviderFailure("protocol")); }
  }
}
export class RpcLifecycle {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private failure?: ProviderFailure;
  private complete = false;
  private disposed = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  private resolveDone!: () => void;
  private rejectDone!: (error: Error) => void;
  readonly done = new Promise<void>((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
  constructor(private readonly write: (line: string) => void, deadlineMs: number, private readonly stop: () => void) {
    this.done.catch(() => {});
    this.timer = setTimeout(() => this.fail(new ProviderFailure("deadline")), deadlineMs);
  }
  assertActive() { if (this.failure) throw this.failure; if (this.disposed) throw new ProviderFailure("canceled"); if (this.complete) throw new ProviderFailure("protocol"); }
  assertHealthy() { if (this.failure) throw this.failure; }
  request(method: string, params: unknown): Promise<any> {
    try { this.assertActive(); if (this.pending.size >= 32) throw new ProviderFailure("protocol"); } catch (error) { return Promise.reject(error); }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write(JSON.stringify({ id, method, params }) + "\n"); } catch { this.fail(new ProviderFailure("process")); }
    });
  }
  response(event: Record<string, any>): boolean {
    this.assertHealthy();
    if (Object.hasOwn(event, "method") || !Object.hasOwn(event, "id")) return false;
    if (typeof event.id !== "number" || !this.pending.has(event.id) || Object.hasOwn(event, "result") === Object.hasOwn(event, "error")) throw new ProviderFailure("protocol");
    if (Object.hasOwn(event, "error") && (!isRecord(event.error) || typeof event.error.message !== "string" || !Number.isInteger(event.error.code))) throw new ProviderFailure("protocol");
    const entry = this.pending.get(event.id)!; this.pending.delete(event.id);
    if (Object.hasOwn(event, "error")) { const error = new ProviderFailure(event.error.code === -32601 ? "unsupported" : classifyProviderFailure(event.error)); entry.reject(error); this.fail(error); }
    else entry.resolve(event.result);
    return true;
  }
  finish() { this.assertActive(); this.complete = true; this.resolveDone(); }
  processExit() { if (!this.disposed && (!this.complete || this.pending.size)) this.fail(new ProviderFailure("process")); }
  fail(error: ProviderFailure) {
    if (this.failure || this.disposed) return;
    this.failure = error;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear(); this.rejectDone(error);
    try { this.stop(); } catch {}
  }
  dispose() {
    clearTimeout(this.timer);
    if (this.pending.size) this.fail(new ProviderFailure("canceled"));
    this.disposed = true;
  }
}
// Device completion may arrive immediately after the start response, before the
// awaiting caller binds its login id. Buffer one bounded notification, then match.
export class LoginCompletion {
  private id?: string;
  private event?: { loginId: string; success: boolean };
  private resolve!: () => void;
  private reject!: (error: Error) => void;
  readonly done = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  constructor() { this.done.catch(() => {}); }
  bind(id: unknown) {
    if (typeof id !== "string" || !id || id.length > 128 || this.id) throw new ProviderFailure("protocol");
    this.id = id; this.settle();
  }
  receive(params: unknown) {
    if (!isRecord(params) || typeof params.loginId !== "string" || !params.loginId || params.loginId.length > 128 || typeof params.success !== "boolean" || this.event) throw new ProviderFailure("protocol");
    this.event = { loginId: params.loginId, success: params.success }; this.settle();
  }
  private settle() {
    if (!this.id || !this.event) return;
    if (this.event.loginId !== this.id) throw new ProviderFailure("protocol");
    this.event.success ? this.resolve() : this.reject(new ProviderFailure("auth_required"));
  }
}
