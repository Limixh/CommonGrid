import type { Page } from "@playwright/test";
import type { ProfileSessionStatus } from "../packages/agent-adapters/src/profile-session-protocol.ts";

const traceKinds = ["claude_open_click", "cancel_click", "submit_click", "nav_workspace_click", "nav_agents_click", "nav_settings_click", "nav_account_click", "nav_contributions_click", "panel_present", "panel_absent", "window_focus", "window_blur", "page_closed", "page_crashed", "ipc_cancel", "ipc_open_claude", "ipc_submit_code"] as const;
type TraceKind = typeof traceKinds[number];
type SafeOperation = Omit<NonNullable<ProfileSessionStatus["operation"]>, "challenge">;
export type SafeProfileSessionMetadata = Omit<ProfileSessionStatus, "operation"> & {operation: SafeOperation | null};
export type SafeSessionObservation = SafeProfileSessionMetadata & {at_ms: number; stage: string};

// Callers validate status before observation. Explicit selection keeps any
// challenge and any future private protocol fields out of diagnostic reports.
export function safeProfileSessionMetadata(status: ProfileSessionStatus): SafeProfileSessionMetadata {
  const operation = status.operation;
  return {schema_version: status.schema_version, availability: status.availability,
    operation: operation ? {request_id: operation.request_id, profile_id: operation.profile_id,
      provider: operation.provider, action: operation.action, revision: operation.revision, phase: operation.phase,
      outcome: operation.outcome, session_state: operation.session_state, error_code: operation.error_code, cleanup: operation.cleanup} : null};
}

export const nativeUiTraceInstallSource = String.raw`(() => {
      // Only fixed exact button matches receive listeners. No event target,
      // input value, text dump, URL or mutation record is collected.
      const buttons = [
        ["Claude giriş sayfasını aç", "claude_open_click"], ["Bağlantı işlemini iptal et", "cancel_click"],
        ["Giriş kodunu gönder", "submit_click"], ["Çalışma alanı", "nav_workspace_click"],
        ["Ajanlar ve ortam", "nav_agents_click"], ["Katkı ayarları", "nav_settings_click"],
        ["Hesabım", "nav_account_click"], ["Katkılarım", "nav_contributions_click"],
      ];
      const attached = new WeakSet();
      const emit = (event) => {
        try { void globalThis.__commonGridSmokeUiEvent(event).catch(() => {}); }
        catch { /* Diagnostic transport must never alter the observed action. */ }
      };
      let panelPresent;
      function observe() {
        const present = document.querySelector(".profile-session-panel") !== null;
        if (present !== panelPresent) { panelPresent = present; emit(present ? "panel_present" : "panel_absent"); }
        for (const [name, event] of buttons) {
          const matches = document.evaluate("//button[normalize-space(.) = '" + name + "']", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < matches.snapshotLength; i++) {
            const button = matches.snapshotItem(i);
            if (button instanceof Element && !attached.has(button)) {
              attached.add(button); button.addEventListener("click", () => emit(event), {capture: true});
            }
          }
        }
      }
      new MutationObserver(observe).observe(document.documentElement, {childList: true, subtree: true});
      window.addEventListener("focus", () => emit("window_focus"));
      window.addEventListener("blur", () => emit("window_blur"));
      observe();
      // Optional passive command-name observation. Preserve arguments, receiver,
      // return value/promise and errors exactly; never inspect args or responses.
      const internals = globalThis.__TAURI_INTERNALS__;
      const original = internals?.invoke;
      if (typeof original !== "function") return false;
      const observed = function (...args) {
        if (args[0] === "local_profile_session_cancel") emit("ipc_cancel");
        else if (args[0] === "local_profile_session_open_claude") emit("ipc_open_claude");
        else if (args[0] === "local_profile_session_submit_code") emit("ipc_submit_code");
        return original.apply(this, args);
      };
      try { internals.invoke = observed; return internals.invoke === observed; }
      catch { return false; }
})()`;

export function safeNativeUiErrorCategory(error: unknown) {
  // Errors may originate in a separate VM/JS realm. Inspect only the message
  // for fixed known categories; never return it or attach the error itself.
  let message = "";
  try {
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") message = error.message;
  } catch { /* An opaque error has the same generic safe category. */ }
  if (message.includes("__name is not defined")) return "browser_evaluate_missing_name_helper";
  if (message.includes("Target page, context or browser has been closed")) return "browser_target_closed";
  if (message.startsWith("page.evaluate:")) return "browser_evaluation_failed";
  return "native_ui_operation_failed";
}

// No tracing APIs, browser inspection or IPC fixtures. Each run owns a bounded
// allowlisted metadata collector and supplies its current diagnostic stage.
export function createNativeUiTrace(getStage: () => string, startedAt = Date.now()) {
  const limit = 120;
  const uiEvents: {at_ms: number; stage: string; event: TraceKind}[] = [];
  const phaseTransitions: {at_ms: number; stage: string; operation: SafeOperation | null}[] = [];
  let previousMetadata = "", lastSessionMetadata: SafeSessionObservation | null = null;
  let nativeInvokeObserverInstalled = false;
  const stamp = () => ({at_ms: Date.now() - startedAt, stage: getStage()});
  function record(event: TraceKind) { if (uiEvents.length < limit) uiEvents.push({...stamp(), event}); }

  async function install(page: Page) {
    await page.exposeFunction("__commonGridSmokeUiEvent", (event: unknown) => {
      if (typeof event === "string" && traceKinds.includes(event as TraceKind)) record(event as TraceKind);
    });
    page.on("close", () => record("page_closed"));
    page.on("crash", () => record("page_crashed"));
    nativeInvokeObserverInstalled = await page.evaluate<boolean>(nativeUiTraceInstallSource);
  }

  function observeSession(status: ProfileSessionStatus) {
    const metadata = safeProfileSessionMetadata(status);
    lastSessionMetadata = {...stamp(), ...metadata};
    const serialized = JSON.stringify(metadata);
    if (serialized !== previousMetadata && phaseTransitions.length < limit) {
      phaseTransitions.push({...stamp(), operation: metadata.operation}); previousMetadata = serialized;
    }
    return lastSessionMetadata;
  }
  function report() {
    return {native_invoke_observer: nativeInvokeObserverInstalled ? "passive_command_names_only" : "unavailable",
      diagnostic_limit: limit, ui_events: [...uiEvents], phase_transitions: [...phaseTransitions], last_session_metadata: lastSessionMetadata};
  }
  return {install, observeSession, report};
}
