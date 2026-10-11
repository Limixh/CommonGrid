import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { CommandError, runOwnedCommand, type CommandCleanup } from "../packages/agent-adapters/src/owned-process.ts";
import { validateManagedProfilesStatus } from "../packages/agent-adapters/src/managed-profile-protocol.ts";
import { validateProfileSessionStatus, type ProfileSessionStatus } from "../packages/agent-adapters/src/profile-session-protocol.ts";
import { root } from "./go.mjs";

// Real official Codex device login is cancelled without authorizing an account.
// No model inference, user account import, API fallback or browser opening.
// Device codes never enter screenshots, files, reports or console output.
if (process.platform !== "win32") throw new Error("native_session_smoke_requires_windows_webview2");
const directory = path.resolve(root, ".local/native-session-smoke", randomUUID()), appdata = path.join(directory, "appdata");
await mkdir(directory, {recursive: true});
const config = path.join(directory, "tauri-smoke.json");
await writeFile(config, JSON.stringify({app: {appDirectoriesOverride: appdata, windows: [{label: "main", title: "CommonGrid native session smoke", visible: false, width: 1380, height: 1080}]}}) + "\n");
const checks: string[] = [];
let success = false, stage = "build", deviceChallengeSeen = false, realNativeIpc = false, browser: Browser | undefined;
let cleanup: CommandCleanup = {method: "none", status: "not_started"};
let activePage: Page | undefined;
const controller = new AbortController();
let completion: Promise<{result?: unknown; error?: unknown}> | undefined;
type Command = "local_managed_profiles_status" | "local_managed_profile_select" | "local_profile_session_status" | "local_profile_session_start" | "local_profile_session_cancel";
async function invoke(page: Page, command: Command, args: unknown = {}) {
  return page.evaluate(({command, args}) => (globalThis as any).__TAURI_INTERNALS__.invoke(command, args), {command, args});
}
async function session(page: Page): Promise<ProfileSessionStatus> {
  const value = validateProfileSessionStatus(await invoke(page, "local_profile_session_status"));
  realNativeIpc = value.availability === "available";
  return value;
}
async function until(page: Page, predicate: (value: ProfileSessionStatus) => boolean, timeoutMs: number, previousRequest?: string) {
  const expires = Date.now() + timeoutMs;
  while (Date.now() < expires) {
    const value = await session(page);
    if (previousRequest && value.operation?.request_id === previousRequest) { await delay(200); continue; }
    if (predicate(value)) return value;
    if (value.operation?.phase === "finished") throw new Error(`native_session_smoke_unexpected_finish:${value.operation.error_code ?? value.operation.outcome}`);
    await delay(200);
  }
  throw new Error("native_session_smoke_observation_deadline");
}
try {
  console.log("Building isolated Windows CLI account session smoke…");
  const buildWorker = "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'a');const child=require('node:child_process').spawn(process.execPath,process.argv.slice(2),{stdio:['ignore',fd,fd],windowsHide:true});child.once('error',()=>{process.exitCode=1;});child.once('close',code=>{fs.closeSync(fd);process.exitCode=code??1;});";
  const build = await runOwnedCommand(process.execPath, ["-e", buildWorker, path.join(directory, "build.log"), path.join(root, "scripts/native.mjs"), "build", "--debug", "--no-bundle", "--config", config], {timeoutMs: 600_000, maxBytes: 1_048_576});
  assert.equal(build.code, 0, "native_session_smoke_build_failed");
  stage = "launch";
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer(); server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); assert.ok(address && typeof address === "object"); server.close(error => error ? reject(error) : resolve(address.port)); });
  });
  const previous = process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
  completion = runOwnedCommand(path.join(root, "apps/desktop/src-tauri/target/debug/commongrid-desktop.exe"), [], {signal: controller.signal, timeoutMs: 780_000, maxBytes: 1_048_576})
    .then(result => ({result}), error => ({error}));
  if (previous === undefined) delete process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS; else process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = previous;
  const expires = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < expires) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(500)})).ok; if (ready) break; } catch {}
    await delay(200);
  }
  assert.ok(ready, "native_session_smoke_cdp_bootstrap_failed");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {timeout: 10_000});
  const context = browser.contexts()[0]; assert.ok(context);
  const page = context.pages()[0] ?? await context.waitForEvent("page", {timeout: 10_000});
  activePage = page;
  page.setDefaultTimeout(15_000);
  await page.waitForURL(url => url.hostname === "tauri.localhost" || url.protocol === "tauri:", {timeout: 15_000});
  await page.reload({waitUntil: "domcontentloaded", timeout: 15_000});
  assert.equal(await page.evaluate(() => (globalThis as any).isTauri), true);
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  const profiles = page.locator(".managed-profiles-panel");
  await expect(profiles).toHaveAttribute("aria-busy", "false");
  stage = "empty_profile";
  await profiles.getByLabel("Profil adı", {exact: true}).fill("Codex session smoke");
  await profiles.getByLabel("Ajan", {exact: true}).selectOption("codex");
  await profiles.getByRole("button", {name: "Profil oluştur", exact: true}).click();
  await expect(profiles).toHaveAttribute("aria-busy", "false");
  await profiles.locator(".managed-profile-list li").filter({hasText: "Codex session smoke"}).getByRole("button", {name: "Bu profili seç", exact: true}).click();
  const panel = page.locator(".profile-session-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  const catalog = validateManagedProfilesStatus(await invoke(page, "local_managed_profiles_status")), profileId = catalog.selected_profile_id;
  assert.ok(profileId);
  assert.equal((await session(page)).operation, null);
  await panel.getByRole("button", {name: "CLI hesabını kontrol et", exact: true}).click();
  const initial = await until(page, value => value.operation?.phase === "finished", 20_000);
  assert.equal(initial.operation?.outcome, "passed"); assert.equal(initial.operation?.session_state, "unauthenticated");
  await expect(panel.getByText("CLI hesabı bağlı değil.", {exact: true})).toBeVisible();
  checks.push("real_native_ui_checks_unmaterialized_selected_profile_without_claiming_authentication");
  stage = "device_login";
  console.log("Preparing a fresh profile and requesting the official device challenge…");
  await panel.getByRole("button", {name: "Codex hesabını bağla", exact: true}).click();
  // A fresh profile first streams the pinned CLI binary into its private tools
  // volume. Allow cold preparation while retaining the native action deadline.
  const waiting = await until(page, value => value.operation?.phase === "waiting_for_login" && !!value.operation.challenge, 300_000, initial.operation!.request_id);
  assert.ok(waiting.operation?.challenge && /^[A-Z0-9-]{4,32}$/.test(waiting.operation.challenge.user_code));
  assert.equal(waiting.operation.challenge.verification_url, "https://auth.openai.com/codex/device");
  assert.equal(waiting.operation.session_state, "unknown");
  deviceChallengeSeen = true;
  waiting.operation.challenge = null;
  await expect(panel.getByTestId("profile-session-code")).toBeVisible();
  checks.push("real_official_codex_device_challenge_reaches_native_profile_ui");
  stage = "cancel";
  console.log("Device challenge observed; cancelling without account authorization…");
  await panel.getByRole("button", {name: "Bağlantı işlemini iptal et", exact: true}).click();
  await expect(panel.getByTestId("profile-session-code")).toHaveCount(0);
  const cancelled = await until(page, value => value.operation?.phase === "finished", 45_000);
  assert.equal(cancelled.operation?.outcome, "cancelled"); assert.equal(cancelled.operation?.cleanup, "verified");
  assert.equal(cancelled.operation?.challenge, null); assert.equal(cancelled.operation?.session_state, "unknown");
  checks.push("cancel_hides_device_code_and_verifies_owned_session_cleanup");
  // The binding is public metadata; official auth remains in its private volume.
  const bindingRoot = path.join(appdata, "managed-profile-sessions");
  const bindingFiles = await readdir(bindingRoot);
  assert.deepEqual(bindingFiles, [`${profileId}.json`]);
  const binding = JSON.parse(await readFile(path.join(bindingRoot, bindingFiles[0]), "utf8"));
  assert.deepEqual(Object.keys(binding).sort(), ["schema_version", "profile_id", "provider", "owner", "state"].sort());
  assert.equal(binding.profile_id, profileId); assert.equal(binding.state, "ready"); assert.notEqual(binding.owner, profileId);
  checks.push("runtime_binding_persists_only_public_owner_metadata_distinct_from_profile_id");
  stage = "check_after_cancel";
  console.log("Checking the same isolated profile through the official CLI…");
  await panel.getByRole("button", {name: "CLI hesabını kontrol et", exact: true}).click();
  const checked = await until(page, value => value.operation?.phase === "finished" && value.operation.action === "status", 160_000, cancelled.operation!.request_id);
  assert.equal(checked.operation?.outcome, "passed"); assert.equal(checked.operation?.session_state, "unauthenticated");
  assert.equal(checked.operation?.cleanup, "verified"); assert.equal(checked.operation?.challenge, null);
  await expect(panel.getByText("CLI hesabı bağlı değil.", {exact: true})).toBeVisible();
  checks.push("official_cli_status_reuses_materialized_profile_after_cancel_and_retains_no_login_claim");
  stage = "logout";
  console.log("Verifying official CLI logout and native cleanup…");
  await panel.getByRole("button", {name: "CLI hesabından çıkış yap", exact: true}).click();
  const loggedOut = await until(page, value => value.operation?.phase === "finished" && value.operation.action === "logout", 160_000, checked.operation!.request_id);
  assert.equal(loggedOut.operation?.outcome, "passed"); assert.equal(loggedOut.operation?.session_state, "unauthenticated"); assert.equal(loggedOut.operation?.cleanup, "verified");
  checks.push("official_cli_logout_has_verified_unauthenticated_postcondition");
  await expect(panel.getByTestId("profile-session-code")).toHaveCount(0);
  await panel.screenshot({path: path.join(directory, "native-session-after-cleanup.png")});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  checks.push("native_account_panel_is_readable_after_cleanup_without_device_code");
  success = true;
} finally {
  if (!success && activePage && !activePage.isClosed()) {
    // Give the native supervisor its independent cleanup window before the
    // test terminates its owned application. Never cancel a replacement.
    try {
      const current = (await session(activePage)).operation;
      if (current && current.phase !== "finished") {
        await invoke(activePage, "local_profile_session_cancel", {request: {schema_version: "1.0", request_id: current.request_id, expected_revision: current.revision}});
        await until(activePage, value => value.operation?.request_id === current.request_id && value.operation.phase === "finished", 40_000);
      }
    } catch { /* The failure report makes no independent Docker cleanup claim. */ }
  }
  controller.abort("smoke_finished");
  if (completion) { const finished = await completion; if (finished.error instanceof CommandError) cleanup = await finished.error.cleanup; }
  if (browser) await browser.close().catch(() => {});
  const report = {schema_version: "1.0", checked_at: new Date().toISOString(), purpose: "real_native_codex_device_login_cancel_and_official_session_status", success: success && cleanup.status === "termination_reported", stage, checks,
    device_challenge_seen: deviceChallengeSeen, device_code_recorded: false, real_native_ipc: realNativeIpc, mocked_native_ipc: false,
    real_account_authorized: false, real_model_inference: false, user_account_imported: false, default_user_app_store_accessed: false,
    browser_open_requested: false, process_cleanup: cleanup,
    scope_limits: ["Isolated app directories and a fresh public profile; no user authorization or model inference", "Official device-login cancellation and signed-out status/logout only; authenticated completion requires user approval in the official provider flow", "Owned process termination report does not independently prove every WebView descendant is absent"]};
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Report: ${path.join(directory, "report.json")}`);
}
assert.ok(success && cleanup.status === "termination_reported", "native_session_smoke_failed");
console.log(`PASS native Windows official CLI session smoke: ${checks.length} checks`);
