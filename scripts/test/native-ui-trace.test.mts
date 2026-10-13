import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import type { Page } from "@playwright/test";
import type { ProfileSessionStatus } from "../../packages/agent-adapters/src/profile-session-protocol.ts";
import { createNativeUiTrace, nativeUiTraceInstallSource, safeNativeUiErrorCategory } from "../native-ui-trace.mts";

// Model-free browser serialization fixture. The actual helper's evaluate input
// runs in a separate JS realm with no tsx/esbuild helpers or provider/browser.
function fixture(readonlyInvoke = false) {
  const buttonNames = ["Claude giriş sayfasını aç", "Bağlantı işlemini iptal et", "Giriş kodunu gönder", "Çalışma alanı", "Ajanlar ve ortam", "Katkı ayarları", "Hesabım", "Katkılarım"];
  class Button {
    listeners = new Map<string, () => void>();
    get textContent(): never { throw new Error("fixture_forbidden_text_read"); }
    get value(): never { throw new Error("fixture_forbidden_input_read"); }
    addEventListener(kind: string, callback: () => void) { this.listeners.set(kind, callback); }
  }
  const buttons = new Map(buttonNames.map(name => [name, new Button()]));
  const outsideButton = new Button(), pageEvents = new Map<string, () => void>(), windowEvents = new Map<string, () => void>();
  const received: {receiver: unknown; args: unknown[]}[] = [];
  const returned = Promise.resolve("fixture_result"), thrown = new Error("fixture_synchronous_failure");
  const original = function (this: unknown, ...args: unknown[]) {
    received.push({receiver: this, args});
    if (args[0] === "fixture_throw") throw thrown;
    return returned;
  };
  const internals = {invoke: original};
  if (readonlyInvoke) Object.defineProperty(internals, "invoke", {value: original, writable: false});
  let panelPresent = false, mutation: (() => void) | undefined;
  const documentElement = {};
  const sandbox: Record<string, any> = {
    Element: Button,
    XPathResult: {ORDERED_NODE_SNAPSHOT_TYPE: 7},
    document: {
      documentElement,
      querySelector(selector: string) { assert.equal(selector, ".profile-session-panel"); return panelPresent ? {} : null; },
      evaluate(xpath: string) {
        const name = buttonNames.find(name => xpath === `//button[normalize-space(.) = '${name}']`);
        assert.ok(name, "fixture_query_outside_button_whitelist");
        return {snapshotLength: 1, snapshotItem: () => buttons.get(name)};
      },
    },
    MutationObserver: class {
      constructor(callback: () => void) { mutation = callback; }
      observe(element: unknown, options: unknown) {
        assert.equal(element, documentElement);
        assert.equal(JSON.stringify(options), JSON.stringify({childList: true, subtree: true}));
      }
    },
    window: {addEventListener(kind: string, callback: () => void) { windowEvents.set(kind, callback); }},
    __TAURI_INTERNALS__: internals,
  };
  let evaluatedSource = "";
  const page = {
    async exposeFunction(name: string, callback: (event: unknown) => void) { sandbox[name] = (event: unknown) => Promise.resolve(callback(event)); },
    on(event: string, callback: () => void) { pageEvents.set(event, callback); },
    async evaluate(source: string) { evaluatedSource = source; return runInNewContext(source, sandbox); },
  } as unknown as Page;
  return {page, buttons, outsideButton, pageEvents, windowEvents, sandbox, internals, original, returned, thrown, received,
    source: () => evaluatedSource, changePanel(present: boolean) { panelPresent = present; mutation?.(); }};
}

test("actual evaluate source works without transpiler helpers and preserves native call identity", async () => {
  const browser = fixture(), trace = createNativeUiTrace(() => "await_official_authorization");
  await trace.install(browser.page);
  assert.equal(browser.source(), nativeUiTraceInstallSource);
  assert.equal(browser.sandbox.__name, undefined);
  const receiver = {}, args = {private_fixture_value: "must_not_be_collected"};
  for (const command of ["local_profile_session_open_claude", "local_profile_session_submit_code", "local_profile_session_cancel", "fixture_unobserved"]) {
    assert.equal(browser.internals.invoke.call(receiver, command, args), browser.returned);
    assert.equal(browser.received.at(-1)?.receiver, receiver);
    assert.equal(browser.received.at(-1)?.args[1], args);
  }
  assert.throws(() => browser.internals.invoke("fixture_throw"), error => error === browser.thrown);
  assert.deepEqual(trace.report().ui_events.map(item => item.event), ["panel_absent", "ipc_open_claude", "ipc_submit_code", "ipc_cancel"]);
  assert.equal(trace.report().native_invoke_observer, "passive_command_names_only");
  assert.equal(JSON.stringify(trace.report()).includes("must_not_be_collected"), false);
});

test("unwritable native invoke remains unchanged and UI observation continues", async () => {
  const browser = fixture(true), trace = createNativeUiTrace(() => "install_passive_ui_observer");
  await trace.install(browser.page);
  assert.equal(browser.internals.invoke, browser.original);
  assert.equal(trace.report().native_invoke_observer, "unavailable");
  browser.buttons.get("Claude giriş sayfasını aç")!.listeners.get("click")!();
  assert.equal(trace.report().ui_events.at(-1)?.event, "claude_open_click");
});

test("only fixed UI events are retained with bounded per-run stage timestamps", async () => {
  const browser = fixture(); let stage = "await_official_authorization";
  const trace = createNativeUiTrace(() => stage, Date.now() - 20);
  await trace.install(browser.page);
  assert.equal(browser.outsideButton.listeners.size, 0);
  await browser.sandbox.__commonGridSmokeUiEvent("fixture_forbidden_event");
  await browser.sandbox.__commonGridSmokeUiEvent({event: "claude_open_click", code: "fixture_secret"});
  browser.changePanel(true);
  browser.buttons.get("Giriş kodunu gönder")!.listeners.get("click")!();
  browser.windowEvents.get("blur")!();
  stage = "failure_cleanup"; browser.pageEvents.get("close")!();
  for (let index = 0; index < 150; index++) browser.windowEvents.get("focus")!();
  const report = trace.report();
  assert.equal(report.ui_events.length, report.diagnostic_limit);
  assert.deepEqual(report.ui_events.slice(0, 5).map(item => item.event), ["panel_absent", "panel_present", "submit_click", "window_blur", "page_closed"]);
  assert.equal(report.ui_events[4].stage, "failure_cleanup");
  assert.ok(report.ui_events.every(item => Number.isFinite(item.at_ms) && item.at_ms >= 0));
  assert.equal(JSON.stringify(report).includes("fixture_secret"), false);
});

test("validated session diagnostics explicitly exclude challenges and future private fields", () => {
  const trace = createNativeUiTrace(() => "await_official_authorization");
  const status: ProfileSessionStatus = {schema_version: "1.0", availability: "available", operation: {
    request_id: "fixture_request", profile_id: "fixture_profile", provider: "claude", action: "login", revision: 1,
    phase: "waiting_for_login", outcome: null, session_state: "unknown", error_code: null, cleanup: "pending",
    challenge: {authorization_url: "fixture_private_authorization_url"},
  }};
  Object.assign(status.operation!, {future_private_field: "fixture_private_value"});
  for (let revision = 1; revision <= 150; revision++) { status.operation!.revision = revision; trace.observeSession(status); }
  const report = trace.report(), serialized = JSON.stringify(report);
  assert.equal(report.phase_transitions.length, report.diagnostic_limit);
  assert.equal(report.last_session_metadata?.operation?.revision, 150);
  assert.equal(Object.hasOwn(report.last_session_metadata!.operation!, "challenge"), false);
  assert.equal(serialized.includes("fixture_private"), false);
  assert.ok(status.operation!.challenge && "authorization_url" in status.operation!.challenge);
  assert.equal(status.operation!.challenge.authorization_url, "fixture_private_authorization_url");
});

test("tsx callback helper failure is classified without returning raw error text", () => {
  // This original callback pattern is transformed by the actual tsx test runner.
  const originalCallback = () => { const emit = () => {}; function observe() { emit(); } observe(); };
  let category = "";
  try { runInNewContext(`(${originalCallback.toString()})()`, {}); }
  catch (error) { category = safeNativeUiErrorCategory(error); }
  assert.equal(category, "browser_evaluate_missing_name_helper");
  assert.equal(safeNativeUiErrorCategory(new Error("page.evaluate: ReferenceError: __name is not defined\nfixture_private_url")), "browser_evaluate_missing_name_helper");
});
