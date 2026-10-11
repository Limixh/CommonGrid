// Browser-safe official CLI account operation observations. No private account
// identity or host paths cross this boundary. Device challenges are transient.
export type ProfileSessionProvider = "claude" | "codex";
export type ProfileSessionAction = "login" | "status" | "logout";
export const profileSessionPhases = ["starting", "preparing", "checking", "waiting_for_login", "cleaning", "finished"] as const;
export type ProfileSessionPhase = typeof profileSessionPhases[number];
export const profileSessionErrors = ["asset_missing", "asset_invalid", "docker_unavailable", "image_missing", "profile_invalid", "profile_needs_review", "auth_required", "unsupported", "session_failed", "worker_failed", "cleanup_failed", "deadline_exceeded", "cancelled"] as const;
export type ProfileSessionError = typeof profileSessionErrors[number];
export type ProfileSessionOutcome = "passed" | "cancelled" | "failed" | "needs_review";
export type ProfileSessionState = "unknown" | "authenticated" | "unauthenticated";
export interface ProfileSessionChallenge { verification_url: "https://auth.openai.com/codex/device"; user_code: string }
export interface ProfileSessionStartRequest { schema_version: "1.0"; request_id: string; profile_id: string; action: ProfileSessionAction }
export interface ProfileSessionCancelRequest { schema_version: "1.0"; request_id: string; expected_revision: number }
export interface ProfileSessionOperation {
  request_id: string;
  profile_id: string;
  provider: ProfileSessionProvider;
  action: ProfileSessionAction;
  revision: number;
  phase: ProfileSessionPhase;
  outcome: null | ProfileSessionOutcome;
  session_state: ProfileSessionState;
  challenge: null | ProfileSessionChallenge;
  error_code: null | ProfileSessionError;
  cleanup: "pending" | "verified" | "unknown";
}
export interface ProfileSessionStatus { schema_version: "1.0"; availability: "available" | "unavailable"; operation: ProfileSessionOperation | null }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identity = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000;
function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
function oneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.includes(value as T);
}
function invalid(): never { throw new Error("profile_session_contract_invalid"); }
export function validateProfileSessionStart(value: unknown): ProfileSessionStartRequest {
  if (!exact(value, ["schema_version", "request_id", "profile_id", "action"]) || value.schema_version !== "1.0" ||
    !identity(value.request_id) || !identity(value.profile_id) || !oneOf(value.action, ["login", "status", "logout"])) invalid();
  return structuredClone(value) as unknown as ProfileSessionStartRequest;
}
export function validateProfileSessionCancel(value: unknown): ProfileSessionCancelRequest {
  if (!exact(value, ["schema_version", "request_id", "expected_revision"]) || value.schema_version !== "1.0" ||
    !identity(value.request_id) || !revision(value.expected_revision)) invalid();
  return structuredClone(value) as unknown as ProfileSessionCancelRequest;
}
export function validateProfileSessionStatus(value: unknown): ProfileSessionStatus {
  if (!exact(value, ["schema_version", "availability", "operation"]) || value.schema_version !== "1.0" ||
    !oneOf(value.availability, ["available", "unavailable"])) invalid();
  const op = value.operation;
  if (value.availability === "unavailable" && op !== null) invalid();
  if (op !== null) {
    if (!exact(op, ["request_id", "profile_id", "provider", "action", "revision", "phase", "outcome", "session_state", "challenge", "error_code", "cleanup"]) ||
      !identity(op.request_id) || !identity(op.profile_id) || !oneOf(op.provider, ["claude", "codex"]) ||
      !oneOf(op.action, ["login", "status", "logout"]) || !revision(op.revision) || !oneOf(op.phase, profileSessionPhases) ||
      !oneOf(op.session_state, ["unknown", "authenticated", "unauthenticated"]) ||
      (op.error_code !== null && !oneOf(op.error_code, profileSessionErrors))) invalid();
    if (op.phase === "waiting_for_login" && (op.provider !== "codex" || op.action !== "login")) invalid();
    if (op.challenge !== null && (op.phase !== "waiting_for_login" || op.provider !== "codex" || op.action !== "login" ||
      !exact(op.challenge, ["verification_url", "user_code"]) || op.challenge.verification_url !== "https://auth.openai.com/codex/device" ||
      typeof op.challenge.user_code !== "string" || !/^[A-Z0-9-]{4,32}$/.test(op.challenge.user_code))) invalid();
    if (op.phase !== "finished") {
      if (op.outcome !== null || op.error_code !== null || op.session_state !== "unknown" || op.cleanup !== "pending") invalid();
    } else {
      if (op.challenge !== null || !oneOf(op.outcome, ["passed", "cancelled", "failed", "needs_review"])) invalid();
      if (op.outcome === "passed") {
        if (op.error_code !== null || op.cleanup !== "verified" || op.session_state === "unknown" ||
          (op.action === "login" && op.session_state !== "authenticated") ||
          (op.action === "logout" && op.session_state !== "unauthenticated")) invalid();
      } else {
        if (op.session_state !== "unknown" || op.error_code === null || op.cleanup !== (op.outcome === "needs_review" ? "unknown" : "verified") ||
          (op.outcome === "cancelled" && op.error_code !== "cancelled")) invalid();
      }
    }
  }
  return structuredClone(value) as unknown as ProfileSessionStatus;
}
export function unavailableProfileSession(): ProfileSessionStatus {
  return {schema_version: "1.0", availability: "unavailable", operation: null};
}
function sameOperation(a: ProfileSessionOperation, b: ProfileSessionOperation): boolean {
  return (Object.keys(a) as (keyof ProfileSessionOperation)[]).every(key => key === "challenge"
    ? a.challenge?.verification_url === b.challenge?.verification_url && a.challenge?.user_code === b.challenge?.user_code
    : a[key] === b[key]);
}
export function acceptProfileSessionUpdate(previous: ProfileSessionStatus | null, incoming: unknown): ProfileSessionStatus {
  const next = validateProfileSessionStatus(incoming), before = previous?.operation, after = next.operation;
  if (!before) return next;
  if (before.phase === "finished" && after?.request_id !== before.request_id) return next;
  if (!after || after.request_id !== before.request_id || after.profile_id !== before.profile_id ||
    after.provider !== before.provider || after.action !== before.action || after.revision < before.revision ||
    ((after.revision === before.revision || before.phase === "finished") && !sameOperation(before, after)) ||
    profileSessionPhases.indexOf(after.phase) < profileSessionPhases.indexOf(before.phase)) throw new Error("profile_session_status_stale");
  return next;
}
