import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { CommandError, runOwnedCommand } from "../packages/agent-adapters/src/owned-process.ts";
import { validateCliCheckStatus, type CliCheckStatus } from "../packages/agent-adapters/src/cli-check-protocol.ts";
import { readOperationJournals } from "../packages/agent-adapters/src/operation-journal.ts";
import { projectOperationRecovery } from "../packages/agent-adapters/src/operation-recovery.ts";
import { root } from "./go.mjs";

// A hidden test build owns a new app directory. Official CLI --version requires
// no account/model and cannot reuse any managed login profile.
if (process.platform !== "win32") throw new Error("native_cli_smoke_requires_windows_webview2");
const directory = path.join(root, ".local/native-cli-smoke", randomUUID()), appdata = path.join(directory, "appdata");
await mkdir(directory, {recursive: true});
const config = path.join(directory, "tauri-smoke.json");
await writeFile(config, JSON.stringify({app: {appDirectoriesOverride: appdata, windows: [{label: "main", title: "CommonGrid native CLI smoke", visible: false, width: 1380, height: 900}]}}, null, 2) + "\n");
const checks: string[] = [], outcomes: unknown[] = [];
const buildWorker = "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'a');const child=require('node:child_process').spawn(process.execPath,process.argv.slice(2),{stdio:['ignore',fd,fd],windowsHide:true});child.once('error',()=>{process.exitCode=1;});child.once('close',code=>{fs.closeSync(fd);process.exitCode=code??1;});";
console.log("Building packaged assets for isolated Windows CLI lifecycle smoke…");
try {
  const build = await runOwnedCommand(process.execPath, ["-e", buildWorker, path.join(directory, "build.log"), path.join(root, "scripts/native.mjs"), "build", "--debug", "--no-bundle", "--config", config], {timeoutMs: 600_000, maxBytes: 1_048_576});
  assert.equal(build.code, 0);
} catch (error) {
  await writeFile(path.join(directory, "report.json"), JSON.stringify({schema_version: "1.0", checked_at: new Date().toISOString(), success: false,
    stage: "build", real_native_ipc: false, real_account_tested: false, real_model_inference: false,
    process_cleanup: error instanceof CommandError ? await error.cleanup : {status: "not_started"}}, null, 2));
  throw new Error("native_cli_smoke_build_failed; see ignored build.log");
}
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer(); server.on("error", reject); server.listen(0, "127.0.0.1", () => {
    const address = server.address(); assert.ok(address && typeof address === "object"); server.close(error => error ? reject(error) : resolve(address.port));
  });
});
const previous = process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
const controller = new AbortController();
const running = runOwnedCommand(path.join(root, "apps/desktop/src-tauri/target/debug/commongrid-desktop.exe"), [], {signal: controller.signal, timeoutMs: 900_000, maxBytes: 1_048_576});
const completion = running.then(result => ({result, error: undefined}), error => ({result: undefined, error}));
if (previous === undefined) delete process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS; else process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = previous;
let browser: Browser | undefined, page: Page | undefined, success = false, cleanup: unknown = {status: "unconfirmed"};
let developerRequests = 0;
let realNativeIpc = false;
const officialProviders = new Set<string>();
async function invoke(command: string, args: unknown = {}) {
  return await page!.evaluate(({command, args}) => (globalThis as any).__TAURI_INTERNALS__.invoke(command, args), {command, args});
}
async function status() { const value = validateCliCheckStatus(await invoke("local_cli_check_status")); realNativeIpc = true; return value; }
async function finished(id: string): Promise<CliCheckStatus> {
  for (let attempt = 0; attempt < 390; attempt++) {
    const value = await status(); assert.equal(value.operation?.request_id, id);
    if (value.operation?.phase === "finished") return value;
    await delay(1000);
  }
  throw new Error("native_cli_smoke_deadline");
}
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(500)})).ok) break; } catch {}
    await delay(200);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {timeout: 10_000});
  const context = browser.contexts()[0]; assert.ok(context); page = context.pages()[0] ?? await context.waitForEvent("page");
  await page.waitForURL(url => url.hostname === "tauri.localhost" || url.protocol === "tauri:", {timeout: 15_000});
  await page.waitForLoadState("domcontentloaded");
  assert.equal(await page.evaluate(() => (globalThis as any).isTauri), true);
  page.on("request", request => { if (["/local-cli-check", "/local-operation-status"].includes(new URL(request.url()).pathname)) developerRequests++; });
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  await expect(page.getByRole("button", {name: "Codex'i kontrol et", exact: true})).toBeEnabled();
  checks.push("real_packaged_ui_exposes_native_cli_check");
  for (const command of ["local_cli_check_start", "local_cli_check_status", "local_cli_check_cancel"]) {
    const denied = await page.evaluate(async ({command}) => {
      try { await (globalThis as any).__TAURI_INTERNALS__.invoke(command, {request: {schema_version: "1.0", request_id: crypto.randomUUID(), provider: "codex", argv: ["SYNTHETIC_FORBIDDEN_COMMAND"]}, root: "SYNTHETIC_FORBIDDEN_PATH"}); return false; }
      catch { return true; }
    }, {command});
    assert.equal(denied, true);
  }
  assert.equal((await status()).operation, null); checks.push("real_native_commands_reject_untrusted_path_and_argv_without_launch");
  for (const provider of ["codex", "claude"] as const) {
    await page.getByRole("button", {name: provider === "codex" ? "Codex'i kontrol et" : "Claude Code'u kontrol et", exact: true}).click();
    let started = await status(); assert.equal(started.operation?.provider, provider); const id = started.operation!.request_id;
    const same = validateCliCheckStatus(await invoke("local_cli_check_start", {request: {schema_version: "1.0", request_id: id, provider}}));
    assert.equal(same.operation?.request_id, id);
    const conflict = await page.evaluate(async ({id, provider}) => {
      try { await (globalThis as any).__TAURI_INTERNALS__.invoke("local_cli_check_start", {request: {schema_version: "1.0", request_id: id, provider: provider === "codex" ? "claude" : "codex"}}); return false; } catch { return true; }
    }, {id, provider}); assert.equal(conflict, true);
    const end = await finished(id); outcomes.push(end.operation);
    assert.equal(end.operation?.outcome, "passed"); assert.equal(end.operation?.cleanup, "verified");
    const expected = provider === "codex" ? "codex-cli 0.157.1" : "2.1.293 (Claude Code)";
    assert.equal(end.operation?.cli_version, expected);
    officialProviders.add(provider);
    await page.getByRole("button", {name: "Kontrol durumunu yenile", exact: true}).click();
    await expect(page.getByTestId("cli-check-version")).toHaveText(expected);
    checks.push(`official_${provider}_version_through_native_owned_worker_and_verified_cleanup`);
    checks.push(`${provider}_native_duplicate_request_idempotent_and_conflicting_provider_denied`);
  }
  const cancelId = randomUUID();
  await invoke("local_cli_check_start", {request: {schema_version: "1.0", request_id: cancelId, provider: "codex"}});
  let cancelled = false;
  for (let retry = 0; retry < 5; retry++) {
    const snapshot = await status();
    try { await invoke("local_cli_check_cancel", {request: {schema_version: "1.0", request_id: cancelId, expected_revision: snapshot.operation!.revision}}); cancelled = true; break; } catch {}
  }
  assert.equal(cancelled, true); const cancelledStatus = await finished(cancelId);
  assert.equal(cancelledStatus.operation?.outcome, "cancelled"); assert.equal(cancelledStatus.operation?.cleanup, "verified");
  outcomes.push(cancelledStatus.operation); checks.push("real_native_revision_bound_cancel_finishes_with_verified_cleanup");
  const store = path.join(appdata, "managed-operation-journal");
  const journal = projectOperationRecovery(await readOperationJournals(store)); assert.equal(journal.status, "available");
  const projected = await invoke("local_operation_status"); assert.deepEqual(projected, journal);
  for (const operation of journal.operations) {
    assert.equal(operation.pending_count, 0);
    for (const kind of ["container", "volume"]) {
      const listed = await runOwnedCommand("docker", [kind, "ls", ...(kind === "container" ? ["--all"] : []), "--filter", `label=io.commongrid.spike.owner=${operation.identity.owner}`, "--format", kind === "container" ? "{{.ID}}" : "{{.Name}}"], {timeoutMs: 10_000, maxBytes: 8192});
      assert.equal(listed.code, 0); assert.equal(listed.stdout.trim(), "");
    }
    const claims = await runOwnedCommand("docker", ["container", "ls", "--all", "--filter", `label=io.commongrid.operation.owner=${operation.identity.owner}`, "--format", "{{.ID}}"], {timeoutMs: 10_000, maxBytes: 8192});
    assert.equal(claims.code, 0); assert.equal(claims.stdout.trim(), "");
  }
  assert.ok(journal.operations.length >= 2); checks.push("app_owned_journal_matches_node_projection_and_no_owned_docker_resources_remain");
  await page.locator(".cli-check-panel").screenshot({path: path.join(directory, "native-cli-check.png")});
  assert.equal(developerRequests, 0); checks.push("native_cli_check_has_no_developer_http_fallback"); success = true;
} catch (error) {
  await writeFile(path.join(directory, "diagnostic.json"), JSON.stringify({error: error instanceof Error ? error.message.slice(0, 4096) : "failed", body: await page?.locator("body").innerText({timeout: 1000}).catch(() => "unavailable")}, null, 2));
  throw error;
} finally {
  controller.abort(); const finishedProcess = await completion;
  if (finishedProcess.error instanceof CommandError) cleanup = await finishedProcess.error.cleanup;
  await browser?.close().catch(() => {});
  const report = {schema_version: "1.0", checked_at: new Date().toISOString(), purpose: "real_windows_native_official_cli_version_lifecycle", success: success && (cleanup as any).status === "termination_reported", ui_checks_passed: success, checks, outcomes,
    real_native_ipc: realNativeIpc, mocked_native_ipc: false, real_official_cli_versions: officialProviders.size === 2, official_cli_providers: [...officialProviders], real_account_tested: false, real_model_inference: false,
    default_user_app_store_accessed: false, existing_managed_profiles_accessed: false, developer_http_requests: developerRequests, process_cleanup: cleanup,
    scope_limits: ["Debug unbundled executable uses production frontend assets and native-owned resource worker", "Fresh version-check profiles only; subscribed task execution and installer signing are separate steps", "Host termination observation alone does not prove Docker cleanup; successful checks independently verified owned Docker resource absence"]};
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n"); console.log(`Report: ${path.join(directory, "report.json")}`);
}
assert.equal((cleanup as any).status, "termination_reported");
console.log(`PASS native Windows official CLI lifecycle smoke: ${checks.length} checks`);
