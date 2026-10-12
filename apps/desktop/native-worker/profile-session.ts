import path from "node:path";
import { validateClaudeAuthorizationUrl, validateClaudeLoginCode, type ProfileSessionAction, type ProfileSessionError, type ProfileSessionProvider, type ProfileSessionChallenge } from "../../../packages/agent-adapters/src/profile-session-protocol.ts";
import { ManagedCliRuntime, ManagedPreparationError, startBridge, type ManagedPrepareOptions, type ManagedRuntimeAssets } from "../../../packages/agent-adapters/src/managed-runtime.ts";
import { claudeManagedLogin, claudeStatus, codexRpc, type ProviderSessionOptions } from "../../../packages/agent-adapters/src/provider-session.ts";
import { assertBridgeHealthy, ProviderFailure } from "../../../packages/agent-adapters/src/session-protocol.ts";
import { verifyAssets, verifyDockerPrerequisite } from "./cli-check.ts";
import { BindingFailure, ProfileBindings, uuid, type ProfileBinding } from "./profile-bindings.ts";

export interface SessionBoot {
  type: "profile_session_boot"; schema_version: "1.0"; request_id: string; profile_id: string;
  provider: ProfileSessionProvider; action: ProfileSessionAction; journal_root: string; assets_root: string; profile_registry_root: string;
}
export type SessionFrame = {type: "progress"; phase: "preparing" | "checking" | "cleaning"} |
  {type: "challenge"; challenge: ProfileSessionChallenge} |
  {type: "result"; outcome: "passed" | "cancelled" | "failed" | "needs_review"; session_state: "authenticated" | "unauthenticated" | "unknown"; error_code: ProfileSessionError | null; cleanup: "verified" | "unknown"};
class SessionFailure extends Error { constructor(readonly code: ProfileSessionError) { super(code); } }
/** One operation, one transient input. No queued input before an active challenge. */
export class ClaudeLoginMailbox {
  private pending?: {url:string;resolve:(code:string)=>void;reject:(error:ProviderFailure)=>void;signal:AbortSignal;abort:()=>void};
  private used=false;
  private closed=false;
  constructor(private readonly requestId:string) {}
  wait(challenge:Readonly<{authorization_url:string}>,signal:AbortSignal):Promise<string> {
    if(this.closed||this.used||this.pending||signal.aborted) return Promise.reject(new ProviderFailure(signal.aborted?"canceled":"protocol"));
    const url=validateClaudeAuthorizationUrl(challenge.authorization_url);
    return new Promise((resolve,reject)=>{
      const abort=()=>this.close();this.pending={url,resolve,reject,signal,abort};
      signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
    });
  }
  submit(value:unknown):void {
    const frame=value as {type:string;request_id:string;code:string};
    if(!frame||typeof frame!=="object"||Array.isArray(frame)||Object.keys(frame).sort().join()!=="code,request_id,type"||
      frame.type!=="claude_login_code"||frame.request_id!==this.requestId||this.closed||this.used||!this.pending) throw new ProviderFailure("protocol");
    const code=validateClaudeLoginCode(frame.code,this.pending.url),pending=this.pending;
    this.pending=undefined;this.used=true;pending.signal.removeEventListener("abort",pending.abort);pending.resolve(code);
  }
  close():void {
    this.closed=true;const pending=this.pending;this.pending=undefined;
    if(pending){pending.signal.removeEventListener("abort",pending.abort);pending.reject(new ProviderFailure("canceled"));}
  }
}
const bootKeys = ["type", "schema_version", "request_id", "profile_id", "provider", "action", "journal_root", "assets_root", "profile_registry_root"].sort().join();
export function parseSessionBoot(value: unknown): SessionBoot {
  const boot = value as SessionBoot;
  if (!boot || typeof boot !== "object" || Array.isArray(boot) || Object.keys(boot).sort().join() !== bootKeys ||
    boot.type !== "profile_session_boot" || boot.schema_version !== "1.0" || typeof boot.request_id !== "string" || !uuid.test(boot.request_id) ||
    typeof boot.profile_id !== "string" || !uuid.test(boot.profile_id) || !["codex", "claude"].includes(boot.provider) ||
    !["login", "status", "logout"].includes(boot.action) || ![boot.journal_root, boot.assets_root, boot.profile_registry_root].every(root =>
      typeof root === "string" && root.length < 4096 && !/[\x00\r\n]/.test(root) && path.isAbsolute(root)) ||
    path.basename(boot.profile_registry_root) !== "managed-profiles") throw new SessionFailure("worker_failed");
  return boot;
}
export function profileBindingRoot(boot: SessionBoot): string {
  return path.join(path.dirname(boot.profile_registry_root), "managed-profile-sessions");
}
/** The saved public profile id and private runtime owner are distinct identities. */
export class BoundProfileRuntime extends ManagedCliRuntime {
  static async prepareBound(binding: ProfileBinding, options: ManagedPrepareOptions): Promise<BoundProfileRuntime> {
    try { return await this.prepareRuntime(new BoundProfileRuntime({owner: binding.owner, provider: binding.provider}, options), options); }
    catch (error) { if (error instanceof ManagedPreparationError) throw error; throw new ManagedPreparationError(true, error); }
  }
}
export type SessionRuntime = Pick<ManagedCliRuntime, "start" | "stop" | "finishOperation" | "retainOperation" | "publishPublicManifest" | "verifyOperation" | "beginNamespaceExec" | "exec">;
export interface SessionBridge { stats: unknown; close(): void }
export interface SessionDependencies {
  bindings(root: string): Pick<ProfileBindings, "read" | "reserve" | "ready" | "removeReserved">;
  assets(boot: SessionBoot): Promise<ManagedRuntimeAssets>;
  prerequisite(assets: ManagedRuntimeAssets, signal: AbortSignal): Promise<void>;
  prepare(binding: ProfileBinding, options: ManagedPrepareOptions): Promise<SessionRuntime>;
  restore(binding: ProfileBinding, assets: ManagedRuntimeAssets): SessionRuntime;
  bridge(runtime: SessionRuntime): Promise<SessionBridge>;
  session(runtime: SessionRuntime, boot: SessionBoot, options: ProviderSessionOptions): Promise<{authenticated: boolean}>;
}
export async function executeProfileSession(runtime: SessionRuntime, boot: SessionBoot, options: ProviderSessionOptions): Promise<{authenticated: boolean}> {
  if (boot.provider === "codex") {
    const result = await codexRpc(runtime, boot.action, options);
    if (!("authenticated" in result) || typeof result.authenticated !== "boolean") throw new SessionFailure("session_failed");
    return result;
  }
  if (boot.action === "login") return claudeManagedLogin(runtime, options);
  if (boot.action === "logout") {
    const result = await runtime.exec(["/opt/cg/claude", "auth", "logout"], 30_000, {signal: options.signal, maxBytes: 4096});
    if (result.code !== 0) throw new SessionFailure("session_failed");
  }
  return claudeStatus(runtime, {...options, requireLogout: boot.action === "logout"});
}
const dependencies: SessionDependencies = {
  bindings: root => new ProfileBindings(root),
  assets: boot => verifyAssets({type: "boot", schema_version: boot.schema_version, request_id: boot.request_id, provider: boot.provider, assets_root: boot.assets_root, journal_root: boot.journal_root}),
  prerequisite: verifyDockerPrerequisite,
  prepare: (binding, options) => BoundProfileRuntime.prepareBound(binding, options),
  restore: (binding, assets) => ManagedCliRuntime.restore({owner: binding.owner, provider: binding.provider}, {assets}),
  bridge: runtime => startBridge(runtime as ManagedCliRuntime),
  session: executeProfileSession,
};
function errorCode(error: unknown, signal: AbortSignal): ProfileSessionError {
  if (signal.aborted) return signal.reason === "deadline_exceeded" ? "deadline_exceeded" : signal.reason === "worker_failed" ? "worker_failed" : "cancelled";
  if (error instanceof BindingFailure || error instanceof SessionFailure) return error.code;
  if (error instanceof ProviderFailure) return error.category === "auth_required" || error.category === "session_expired" ? "auth_required" :
    error.category === "unsupported" ? "unsupported" : error.category === "deadline" ? "deadline_exceeded" : error.category === "canceled" ? "cancelled" : "session_failed";
  // Closed setup codes only; Docker/provider text never enters a frame.
  const code = (error as {code?: unknown})?.code;
  if (["asset_missing", "asset_invalid", "docker_unavailable", "image_missing"].includes(code as string)) return code as ProfileSessionError;
  return "worker_failed";
}
export async function runProfileSession(boot: SessionBoot, signal: AbortSignal, emit: (frame: SessionFrame) => void, deps: SessionDependencies = dependencies,
  interaction: Pick<ProviderSessionOptions,"onClaudeAuthorization"> = {}): Promise<void> {
  let runtime: SessionRuntime | undefined, bridge: SessionBridge | undefined, release: (() => void) | undefined;
  let reserved: ProfileBinding | undefined, prepared = false, preparing = false, published = false, cleanupVerified = true;
  let sessionState: "authenticated" | "unauthenticated" | "unknown" = "unknown", error: ProfileSessionError | null = null;
  let store: ReturnType<SessionDependencies["bindings"]> | undefined;
  emit({type: "progress", phase: "preparing"});
  try {
    signal.throwIfAborted();
    if (boot.provider === "claude" && boot.action === "login" && !interaction.onClaudeAuthorization) throw new SessionFailure("unsupported");
    store = deps.bindings(profileBindingRoot(boot));
    const binding = await store.read(boot.profile_id, boot.provider);
    signal.throwIfAborted();
    if (binding?.state === "reserved") { cleanupVerified = false; throw new SessionFailure("profile_needs_review"); }
    if (!binding && boot.action !== "login") { sessionState = "unauthenticated"; return; }
    const assets = await deps.assets(boot);
    signal.throwIfAborted(); await deps.prerequisite(assets, signal); signal.throwIfAborted();
    if (!binding) {
      reserved = await store.reserve(boot.profile_id, boot.provider);
      signal.throwIfAborted(); preparing = true; cleanupVerified = false;
      runtime = await deps.prepare(reserved, {assets, signal}); prepared = true;
      await runtime.publishPublicManifest(async () => { await store!.ready(reserved!); published = true; }, {signal});
    } else { runtime = deps.restore(binding, assets); cleanupVerified = false; }
    await runtime.start({signal}); signal.throwIfAborted();
    release = await runtime.retainOperation({signal});
    bridge = await deps.bridge(runtime); assertBridgeHealthy(bridge.stats); signal.throwIfAborted();
    emit({type: "progress", phase: "checking"});
    const result = await deps.session(runtime, boot, {signal, deadlineMs: boot.action === "login" ? 600_000 : 30_000,
      onDeviceChallenge: challenge => {
        signal.throwIfAborted(); assertBridgeHealthy(bridge!.stats);
        if (boot.provider !== "codex" || boot.action !== "login" || challenge.verification_url !== "https://auth.openai.com/codex/device" ||
          typeof challenge.user_code !== "string" || !/^[A-Z0-9-]{4,32}$/.test(challenge.user_code)) throw new SessionFailure("session_failed");
        emit({type: "challenge", challenge: {verification_url: challenge.verification_url, user_code: challenge.user_code}});
      }, onClaudeAuthorization: async (challenge,loginSignal) => {
        signal.throwIfAborted(); assertBridgeHealthy(bridge!.stats);
        if(boot.provider!=="claude"||boot.action!=="login"||!interaction.onClaudeAuthorization)throw new SessionFailure("session_failed");
        const authorization_url=validateClaudeAuthorizationUrl(challenge.authorization_url);
        const pending=interaction.onClaudeAuthorization(Object.freeze({authorization_url}),loginSignal);
        emit({type:"challenge",challenge:{authorization_url}});
        return pending;
      }});
    signal.throwIfAborted(); assertBridgeHealthy(bridge.stats);
    if (typeof result.authenticated !== "boolean" || (boot.action === "login" && !result.authenticated) || (boot.action === "logout" && result.authenticated)) throw new SessionFailure("session_failed");
    sessionState = result.authenticated ? "authenticated" : "unauthenticated";
  } catch (failure) {
    if (failure instanceof ManagedPreparationError) cleanupVerified = failure.cleanupVerified;
    else if (!preparing && !runtime && errorCode(failure, signal) !== "profile_needs_review") cleanupVerified = true;
    error = errorCode(failure, signal);
    if (reserved && !prepared && cleanupVerified) {
      try { await store!.removeReserved(reserved); } catch { cleanupVerified = false; error = "profile_needs_review"; }
    }
  } finally {
    emit({type: "progress", phase: "cleaning"});
    if (runtime) {
      const cleanupSignal = AbortSignal.timeout(35_000);
      try {
        // Hold the operation lease while RPC descendants and the relay stop.
        if (bridge) assertBridgeHealthy(bridge.stats);
      } catch { error ??= "session_failed"; sessionState = "unknown"; }
      try { bridge?.close(); } catch { error ??= "session_failed"; sessionState = "unknown"; }
      try { await runtime.stop(false, {signal: cleanupSignal}); }
      catch { cleanupVerified = false; error = "cleanup_failed"; }
      finally { release?.(); }
      try { await runtime.finishOperation({signal: cleanupSignal}); cleanupVerified = error !== "cleanup_failed"; }
      catch { cleanupVerified = false; error = "cleanup_failed"; }
    }
    // Prepared private volumes survive even failed login/cancel. A reservation
    // without a proven public publication must remain visible for review.
    if (prepared && !published) { cleanupVerified = false; error = "profile_needs_review"; }
    if (signal.aborted && !error) error = errorCode(undefined, signal);
    if (error === "profile_needs_review") cleanupVerified = false;
    emit({type: "result", outcome: !cleanupVerified || error === "profile_needs_review" ? "needs_review" : error === "cancelled" ? "cancelled" : error ? "failed" : "passed",
      session_state: error || !cleanupVerified ? "unknown" : sessionState, error_code: error, cleanup: cleanupVerified ? "verified" : "unknown"});
  }
}
