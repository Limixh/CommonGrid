import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { CommandError, runOwnedCommand, type CommandCleanup } from "../packages/agent-adapters/src/owned-process.ts";
import { validateManagedProfilesStatus, type ManagedProfilesStatus } from "../packages/agent-adapters/src/managed-profile-protocol.ts";
import { root } from "./go.mjs";

// This smoke creates public configuration only. It never copies an existing
// profile, starts a CLI, observes a login, invokes a model, or uses Docker.
if (process.platform !== "win32") throw new Error("native_profile_smoke_requires_windows_webview2");
const directory = path.resolve(root, ".local/native-profile-smoke", randomUUID());
const appdata = path.join(directory, "appdata");
function withinRun(filename: string) {
  const resolved = path.resolve(filename);
  const relative = path.relative(directory, resolved);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "smoke_path_outside_run");
  return resolved;
}
await mkdir(directory, {recursive: true});
const config = withinRun(path.join(directory, "tauri-smoke.json"));
const catalogFile = withinRun(path.join(appdata, "managed-profiles", "profiles.json"));
await writeFile(config, JSON.stringify({app: {
  appDirectoriesOverride: withinRun(appdata),
  windows: [{label: "main", title: "CommonGrid native profile smoke", visible: false, width: 1380, height: 1000}],
}}, null, 2) + "\n");

const checks: string[] = [];
type ProfileCommand = "local_managed_profiles_status" | "local_managed_profile_create" | "local_managed_profile_select";
type DirectCommand = {command: ProfileCommand; purpose: "typed_status" | "denial"};
type SessionReport = {
  session: "create" | "restart";
  process_cleanup: CommandCleanup;
  direct_native_commands: DirectCommand[];
  ui_native_commands_instrumented: false;
  best_effort_route_observations: {
    account_catalog_abort_attempts: number;
    external_abort_attempts: number;
    developer_http_requests_observed: number;
    route_coverage_verified: false;
  };
};
const sessions: SessionReport[] = [];
const pageSessions = new WeakMap<Page, SessionReport>();
let stage = "build", success = false, realNativeIpc = false;
let buildCleanup: CommandCleanup = {method: "none", status: "not_started"};

async function bounded<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function availablePort() {
  return await bounded(new Promise<number>((resolve, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address(); assert.ok(address && typeof address === "object");
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  }), 5000, "native_profile_smoke_port_deadline");
}
function recordDirectCommand(page: Page, command: ProfileCommand, purpose: DirectCommand["purpose"]) {
  const record = pageSessions.get(page);
  assert.ok(record, "native_profile_smoke_missing_session_record");
  assert.ok(["local_managed_profiles_status", "local_managed_profile_create", "local_managed_profile_select"].includes(command),
    "native_profile_smoke_unexpected_direct_command");
  record.direct_native_commands.push({command, purpose});
}
async function invoke(page: Page, command: ProfileCommand, args: unknown = {}) {
  recordDirectCommand(page, command, "typed_status");
  return await bounded(page.evaluate(({command, args}) =>
    (globalThis as any).__TAURI_INTERNALS__.invoke(command, args), {command, args}),
  10_000, "native_profile_smoke_ipc_deadline");
}
async function deniedInvocation(page: Page, command: ProfileCommand, args: unknown) {
  recordDirectCommand(page, command, "denial");
  return await bounded(page.evaluate(async ({command, args}) => {
    try { await (globalThis as any).__TAURI_INTERNALS__.invoke(command, args); return false; }
    catch (error) { return error === "local_managed_profiles_denied"; }
  }, {command, args}), 10_000, "native_profile_smoke_denial_deadline");
}
async function status(page: Page) {
  const result = validateManagedProfilesStatus(await invoke(page, "local_managed_profiles_status"));
  assert.equal(result.availability, "available"); realNativeIpc = true;
  return result;
}
async function verifyPublicFile(expected: ManagedProfilesStatus) {
  const bytes = await readFile(catalogFile, "utf8");
  assert.ok(Buffer.byteLength(bytes) <= 8192);
  const catalog = JSON.parse(bytes);
  assert.deepEqual(Object.keys(catalog).sort(), ["schema_version", "revision", "profiles", "selected_profile_id"].sort());
  assert.deepEqual(validateManagedProfilesStatus({...catalog, availability: "available"}), expected);
  for (const profile of catalog.profiles)
    assert.deepEqual(Object.keys(profile).sort(), ["profile_id", "provider", "name"].sort());
  assert.deepEqual((await readdir(path.dirname(catalogFile))).sort(), [".profiles.lock", "profiles.json"].sort());
  return bytes;
}

async function runSession(session: SessionReport["session"], inspect: (page: Page) => Promise<void>) {
  const port = await availablePort();
  const previous = process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
  const controller = new AbortController();
  const running = runOwnedCommand(path.join(root, "apps/desktop/src-tauri/target/debug/commongrid-desktop.exe"), [],
    {signal: controller.signal, timeoutMs: 120_000, maxBytes: 1_048_576});
  let processFinished = false;
  const completion = running.then(result => { processFinished = true; return {result, error: undefined}; },
    error => { processFinished = true; return {result: undefined, error}; });
  if (previous === undefined) delete process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  else process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = previous;
  const record: SessionReport = {session, process_cleanup: {method: "none", status: "unconfirmed"}, direct_native_commands: [],
    ui_native_commands_instrumented: false, best_effort_route_observations: {
      account_catalog_abort_attempts: 0, external_abort_attempts: 0, developer_http_requests_observed: 0, route_coverage_verified: false,
    }};
  sessions.push(record);
  let browser: Browser | undefined, page: Page | undefined;
  const pageErrors: string[] = [];
  try {
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline && !processFinished) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(500)})).ok;
        if (ready) break;
      } catch {}
      await delay(200);
    }
    assert.equal(ready, true, "native_profile_smoke_cdp_bootstrap_failed");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {timeout: 10_000});
    const context = browser.contexts()[0]; assert.ok(context);
    // Best-effort CDP routing only: WebView custom-protocol requests may bypass
    // these callbacks. Zero observations do not prove network absence or that
    // unrelated account/catalog requests were blocked. Native IPC is untouched.
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/api/v1/")) { record.best_effort_route_observations.account_catalog_abort_attempts++; await route.abort(); return; }
      const packagedAsset = ["tauri.localhost", "localhost"].includes(url.hostname) && ["http:", "tauri:"].includes(url.protocol);
      const nativeTransport = url.protocol === "ipc:" || (url.protocol === "http:" && url.hostname === "ipc.localhost");
      if (!packagedAsset && !nativeTransport) {
        record.best_effort_route_observations.external_abort_attempts++; await route.abort(); return;
      }
      if (url.pathname.startsWith("/local-managed-profile")) record.best_effort_route_observations.developer_http_requests_observed++;
      await route.continue();
    });
    page = context.pages()[0] ?? await context.waitForEvent("page", {timeout: 10_000});
    pageSessions.set(page, record);
    page.setDefaultTimeout(10_000);
    page.on("pageerror", error => { if (pageErrors.length < 20) pageErrors.push(error.message.slice(0, 2048)); });
    await page.waitForURL(url => url.hostname === "tauri.localhost" || url.protocol === "tauri:", {timeout: 15_000});
    await page.reload({waitUntil: "domcontentloaded", timeout: 15_000});
    assert.ok(page.url().startsWith("http://tauri.localhost/") || page.url().startsWith("tauri://localhost/"));
    assert.equal(await page.evaluate(() => (globalThis as any).isTauri), true);
    await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
    await expect(page.locator(".managed-profiles-panel")).toHaveAttribute("aria-busy", "false");
    await inspect(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "native_profile_smoke_horizontal_overflow");
    const typedStatus: DirectCommand = {command: "local_managed_profiles_status", purpose: "typed_status"};
    const expectedDirectCommands: DirectCommand[] = session === "restart" ? [typedStatus] : [
      typedStatus, typedStatus, typedStatus,
      {command: "local_managed_profiles_status", purpose: "denial"},
      {command: "local_managed_profiles_status", purpose: "denial"},
      {command: "local_managed_profile_create", purpose: "denial"},
      {command: "local_managed_profile_create", purpose: "denial"},
      {command: "local_managed_profile_create", purpose: "denial"},
      {command: "local_managed_profile_select", purpose: "denial"},
      {command: "local_managed_profile_select", purpose: "denial"},
      typedStatus,
    ];
    assert.deepEqual(record.direct_native_commands, expectedDirectCommands, "native_profile_smoke_direct_command_sequence_incomplete");
    assert.deepEqual(pageErrors, []);
  } catch (error) {
    await writeFile(withinRun(path.join(directory, `${session}-diagnostic.json`)), JSON.stringify({
      error: error instanceof Error ? error.message.slice(0, 4096) : "native_profile_smoke_failed", page_errors: pageErrors,
      body: await page?.locator("body").innerText({timeout: 1000}).then(value => value.slice(0, 8192)).catch(() => "unavailable"),
    }, null, 2) + "\n");
    throw error;
  } finally {
    controller.abort();
    const finished = await completion;
    if (finished.error instanceof CommandError) record.process_cleanup = await finished.error.cleanup;
    if (browser) await bounded(browser.close(), 5000, "native_profile_smoke_browser_disconnect_deadline").catch(() => {});
    await writeFile(withinRun(path.join(directory, `${session}-cleanup.json`)), JSON.stringify(record, null, 2) + "\n");
  }
  assert.equal(record.process_cleanup.status, "termination_reported", "native_profile_smoke_process_cleanup_unconfirmed");
}

try {
  console.log("Building packaged assets for isolated Windows public profile metadata smoke…");
  const buildWorker = "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'a');const child=require('node:child_process').spawn(process.execPath,process.argv.slice(2),{stdio:['ignore',fd,fd],windowsHide:true});child.once('error',()=>{process.exitCode=1;});child.once('close',code=>{fs.closeSync(fd);process.exitCode=code??1;});";
  try {
    const build = await runOwnedCommand(process.execPath, ["-e", buildWorker, withinRun(path.join(directory, "build.log")),
      path.join(root, "scripts/native.mjs"), "build", "--debug", "--no-bundle", "--config", config], {timeoutMs: 600_000, maxBytes: 1_048_576});
    assert.equal(build.code, 0, "native_profile_smoke_build_failed");
  } catch (error) {
    if (error instanceof CommandError) buildCleanup = await error.cleanup;
    throw new Error("native_profile_smoke_build_failed; see ignored build.log");
  }
  stage = "create";
  let saved: ManagedProfilesStatus | undefined, savedBytes: string | undefined;
  await runSession("create", async page => {
    const initial = await status(page);
    assert.deepEqual(initial, {schema_version: "1.0", availability: "available", revision: 0, profiles: [], selected_profile_id: null});
    checks.push("fresh_isolated_appdata_has_empty_public_profile_catalog");
    const panel = page.locator(".managed-profiles-panel");
    for (const provider of ["codex", "claude"] as const) {
      const name = `${provider === "codex" ? "Codex" : "Claude"} smoke profile`;
      await panel.getByLabel("Profil adı", {exact: true}).fill(name);
      await panel.getByLabel("Ajan", {exact: true}).selectOption(provider);
      await panel.getByRole("button", {name: "Profil oluştur", exact: true}).click();
      await expect(panel.locator(".managed-profile-list li").filter({hasText: name})).toBeVisible();
      await expect(panel).toHaveAttribute("aria-busy", "false");
    }
    const created = await status(page);
    assert.equal(created.revision, 2); assert.equal(created.selected_profile_id, null);
    assert.deepEqual(created.profiles.map(({provider, name}) => ({provider, name})), [
      {provider: "codex", name: "Codex smoke profile"}, {provider: "claude", name: "Claude smoke profile"},
    ]);
    await expect(panel.getByText("Kaydedilmiş profil", {exact: false})).toHaveCount(2);
    checks.push("real_packaged_ui_creates_codex_and_claude_reserved_public_configs");
    const claude = panel.locator(".managed-profile-list li").filter({hasText: "Claude smoke profile"});
    await claude.getByRole("button", {name: "Bu profili seç", exact: true}).click();
    await expect(claude.getByText("Seçili profil", {exact: true})).toBeVisible();
    await expect(panel).toHaveAttribute("aria-busy", "false");
    saved = await status(page);
    assert.equal(saved.revision, 3); assert.equal(saved.selected_profile_id, saved.profiles[1].profile_id);
    savedBytes = await verifyPublicFile(saved);
    checks.push("native_typed_ipc_matches_public_metadata_file_without_auth_fields");
    const create = {schema_version: "1.0", request_id: randomUUID(), provider: "codex", name: "Denied smoke profile", expected_revision: saved.revision};
    const select = {schema_version: "1.0", profile_id: saved.profiles[0].profile_id, expected_revision: saved.revision};
    for (const [command, args] of [
      ["local_managed_profiles_status", {root: "SYNTHETIC_FORBIDDEN_PATH"}],
      ["local_managed_profiles_status", {unexpected: true}],
      ["local_managed_profile_create", {request: create, root: "SYNTHETIC_FORBIDDEN_PATH"}],
      ["local_managed_profile_create", {request: {...create, config_path: "SYNTHETIC_FORBIDDEN_PATH"}}],
      ["local_managed_profile_create", {request: {...create, authenticated: true}}],
      ["local_managed_profile_select", {request: select, root: "SYNTHETIC_FORBIDDEN_PATH"}],
      ["local_managed_profile_select", {request: {...select, unexpected: true}}],
    ] as const) {
      const denied = await deniedInvocation(page, command, args);
      assert.equal(denied, true, `native_profile_smoke_extra_fields_accepted:${command}`);
    }
    assert.deepEqual(await status(page), saved);
    assert.equal(await verifyPublicFile(saved), savedBytes);
    checks.push("native_helper_commands_reject_caller_paths_and_unknown_fields_without_catalog_mutation");
    await panel.screenshot({path: withinRun(path.join(directory, "native-profiles.png"))});
    checks.push("real_native_profile_panel_screenshot_and_no_horizontal_overflow");
  });
  checks.push("first_owned_hidden_app_session_cleanup_awaited_before_restart");
  assert.ok(saved && savedBytes);
  stage = "restart";
  await runSession("restart", async page => {
    assert.deepEqual(await status(page), saved);
    assert.equal(await verifyPublicFile(saved!), savedBytes);
    const panel = page.locator(".managed-profiles-panel");
    await expect(panel.locator(".managed-profile-list li")).toHaveCount(2);
    await expect(panel.locator(".managed-profile-list li").filter({hasText: "Claude smoke profile"}).getByText("Seçili profil", {exact: true})).toBeVisible();
    await expect(panel.getByText("Kaydedilmiş profil", {exact: false})).toHaveCount(2);
    await panel.screenshot({path: withinRun(path.join(directory, "native-profiles-restarted.png"))});
    checks.push("same_isolated_appdata_restart_preserves_both_reserved_configs_and_selected_profile");
  });
  checks.push("second_owned_hidden_app_session_cleanup_awaited");
  success = true;
} finally {
  await writeFile(withinRun(path.join(directory, "checks.json")), JSON.stringify(checks, null, 2) + "\n");
  const report = {schema_version: "1.0", checked_at: new Date().toISOString(), purpose: "real_windows_packaged_native_public_profile_metadata_smoke",
    success: success && sessions.length === 2 && sessions.every(session => session.process_cleanup.status === "termination_reported"), stage, checks,
    real_native_ipc: realNativeIpc, mocked_native_ipc: false, real_account_tested: false, real_model_inference: false,
    official_cli_execution_requested_by_smoke: false, docker_called_by_smoke: false, profile_authentication_claimed: false,
    ui_native_commands_instrumented: false, independent_network_absence_proven: false,
    default_user_app_store_accessed: false, existing_managed_profiles_accessed: false,
    fixture_store: "same_isolated_app_directories_override_across_two_owned_sessions", build_cleanup: buildCleanup, sessions,
    scope_limits: ["Reserved public configuration metadata only; profile selection does not authenticate an official CLI",
      "Direct helper-issued IPC commands are recorded and asserted; UI-issued IPC commands are not instrumented",
      "Production frontend in a hidden debug unbundled executable; CDP route observations and abort attempts are best-effort and do not independently prove network absence or account-request blocking",
      "The smoke invokes only fixed profile-registry helper commands and profile UI controls; it requests no official CLI execution, model inference, Docker action, or account authentication",
      "Owned process termination report does not independently prove every WebView descendant is absent"]};
  await writeFile(withinRun(path.join(directory, "report.json")), JSON.stringify(report, null, 2) + "\n");
  console.log(`Report: ${path.join(directory, "report.json")}`);
}
console.log(`PASS native Windows public profile metadata smoke: ${checks.length} checks`);
