import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { CommandError, runOwnedCommand } from "../packages/agent-adapters/src/owned-process.ts";
import { root } from "./go.mjs";

// Build-only test configuration; the shipped application has no path override IPC.
if (process.platform !== "win32") throw new Error("native_journal_smoke_requires_windows_webview2");
const directory = path.join(root, ".local/native-journal-smoke", randomUUID());
const store = path.join(directory, "appdata", "managed-operation-journal");
await mkdir(directory, {recursive: true});
function withinRun(filename: string) {
  const resolved = path.resolve(filename);
  assert.ok(resolved.startsWith(directory + path.sep), "smoke_path_outside_run");
  return resolved;
}
const config = withinRun(path.join(directory, "tauri-smoke.json"));
await writeFile(config, JSON.stringify({app: {
  appDirectoriesOverride: path.join(directory, "appdata"),
  windows: [{label: "main", title: "CommonGrid native journal smoke", visible: false, width: 1380, height: 900}],
}}, null, 2) + "\n");
console.log("Building packaged assets for isolated Windows native journal smoke…");
// Keep build output on disk, with the worker/CLI/Cargo tree owned by one launcher.
const buildWorker = "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'a');const child=require('node:child_process').spawn(process.execPath,process.argv.slice(2),{stdio:['ignore',fd,fd],windowsHide:true});child.once('error',()=>{process.exitCode=1;});child.once('close',code=>{fs.closeSync(fd);process.exitCode=code??1;});";
try {
  const result = await runOwnedCommand(process.execPath, ["-e", buildWorker, withinRun(path.join(directory, "build.log")),
    path.join(root, "scripts/native.mjs"), "build", "--debug", "--no-bundle", "--config", config],
    {timeoutMs: 600_000, maxBytes: 1_048_576});
  assert.equal(result.code, 0, "native_smoke_build_failed");
} catch (error) {
  const cleanup = error instanceof CommandError ? await error.cleanup : {status: "not_started"};
  await writeFile(withinRun(path.join(directory, "report.json")), JSON.stringify({
    checked_at: new Date().toISOString(), success: false, stage: "build", real_native_ipc: false,
    real_account_tested: false, real_model_inference: false, process_cleanup: cleanup,
  }, null, 2) + "\n");
  throw new Error("native_smoke_build_failed; see ignored build.log");
}
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer(); server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address(); assert.ok(address && typeof address === "object");
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});
const previousBrowserArguments = process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
const controller = new AbortController();
const running = runOwnedCommand(path.join(root, "apps/desktop/src-tauri/target/debug/commongrid-desktop.exe"), [],
  {signal: controller.signal, timeoutMs: 120_000, maxBytes: 1_048_576});
// Observe failures immediately, even while waiting for WebView initialization.
const completion = running.then(value => ({result: value, error: undefined}), error => ({result: undefined, error}));
if (previousBrowserArguments === undefined) delete process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
else process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = previousBrowserArguments;
let browser: Browser | undefined;
let page: Page | undefined;
const pageErrors: string[] = [];
let success = false;
let nativeIpcObserved = false;
let developerEndpointRequests: number | null = null;
let cleanup: unknown = {status: "unconfirmed"};
const checks: string[] = [];
try {
  for (let retry = 0; retry < 100; retry++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(500)});
      if (response.ok) break;
    } catch {}
    await delay(200);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {timeout: 10_000});
  const context = browser.contexts()[0]; assert.ok(context);
  page = context.pages()[0];
  if (!page) page = await context.waitForEvent("page", {timeout: 10_000});
  page.on("pageerror", error => { if (pageErrors.length < 20) pageErrors.push(error.message.slice(0, 2_048)); });
  await page.waitForURL(url => url.hostname === "tauri.localhost" || url.protocol === "tauri:", {timeout: 15_000});
  await page.waitForLoadState("domcontentloaded");
  const url = page.url(); assert.ok(url.startsWith("http://tauri.localhost/") || url.startsWith("tauri://localhost/"));
  developerEndpointRequests = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/local-operation-status") developerEndpointRequests!++; });
  assert.equal(await page.evaluate(() => (globalThis as any).isTauri), true);
  const fontsLoaded = await page.evaluate(async () => {
    const faces = await document.fonts.load('14px "DM Sans"'); await document.fonts.ready;
    return faces.length > 0 && faces.every(face => face.status === "loaded");
  });
  assert.equal(fontsLoaded, true, "packaged_native_font_not_loaded");
  assert.equal(await page.evaluate(() => document.fonts.check('14px "DM Sans"')), true);
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  await expect(page.getByText("Yerel işlem günlüğü kullanılamıyor.", {exact: true})).toBeVisible();
  checks.push("packaged_native_missing_store_reported_unavailable");
  const fixture = JSON.parse(await readFile(path.join(root, "packages/agent-adapters/test/fixtures/operation-journal-contract.json"), "utf8"));
  const sample = fixture.cases.find((value: any) => value.expected.status === "available" && value.expected.operations.some((operation: any) => operation.status === "needs_review" && operation.pending_count > 0));
  assert.ok(sample, "native_smoke_fixture_missing");
  await mkdir(store, {recursive: true});
  for (const [relative, contents] of Object.entries(sample.files)) {
    assert.equal(typeof contents, "string");
    const filename = withinRun(path.join(store, relative));
    assert.ok(filename.startsWith(store + path.sep));
    await mkdir(path.dirname(filename), {recursive: true}); await writeFile(filename, contents as string);
  }
  await page.getByRole("button", {name: "İşlem kayıtlarını yenile"}).click();
  await expect(page.getByRole("button", {name: "İnceleme isteğini göster"})).toBeVisible();
  const actual = await page.evaluate(() => (globalThis as any).__TAURI_INTERNALS__.invoke("local_operation_status"));
  assert.deepEqual(actual, sample.expected);
  nativeIpcObserved = true;
  checks.push("typescript_fixture_verified_through_real_native_ipc");
  await page.getByRole("button", {name: "İnceleme isteğini göster"}).click();
  const request = JSON.parse(await page.getByTestId("operation-review-request").innerText());
  assert.equal(request.action, "inspect_only");
  const selected = sample.expected.operations.find((operation: any) => operation.status === "needs_review");
  assert.deepEqual(request.identity, selected.identity); assert.equal(request.expected_hash, selected.last_hash);
  checks.push("real_packaged_ui_revision_bound_inspect_request");
  await page.locator(".operation-recovery").screenshot({path: withinRun(path.join(directory, "native-recovery.png"))});
  const denied = await page.evaluate(async () => {
    try { await (globalThis as any).__TAURI_INTERNALS__.invoke("local_operation_status", {root: "SYNTHETIC_UNTRUSTED_PATH"}); return false; }
    catch (error) { return error === "local_operation_status_denied"; }
  });
  assert.equal(denied, true, "native_smoke_nonempty_args_accepted");
  for (const [relative, contents] of Object.entries(sample.files))
    assert.equal(await readFile(withinRun(path.join(store, relative)), "utf8"), contents);
  checks.push("real_native_rejects_caller_path_arguments_and_preserves_catalog_bytes");
  await writeFile(withinRun(path.join(store, "unexpected-entry")), "SYNTHETIC_NATIVE_SMOKE_INVALID_ENTRY");
  await page.getByRole("button", {name: "Katkı ayarları", exact: true}).click();
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  await expect(page.getByRole("alert")).toContainText("İşlem kayıtları doğrulanamadı");
  await expect(page.getByRole("button", {name: "İnceleme isteğini göster"})).toHaveCount(0);
  await expect(page.getByTestId("operation-review-request")).toHaveCount(0);
  assert.equal(developerEndpointRequests, 0);
  checks.push("malformed_native_catalog_hides_rows_and_stale_request_without_http_fallback");
  success = true;
} catch (error) {
  // Synthetic store only; bounded diagnostics stay in the ignored run directory.
  await writeFile(withinRun(path.join(directory, "ui-diagnostic.json")), JSON.stringify({
    error: error instanceof Error ? error.message.slice(0, 4_096) : "native_smoke_failed",
    page_errors: pageErrors, url: page?.url(),
    body: await page?.locator("body").innerText({timeout: 1_000}).then(value => value.slice(0, 8_192)).catch(() => "unavailable"),
  }, null, 2) + "\n");
  throw error;
} finally {
  controller.abort();
  const finished = await completion;
  if (finished.error instanceof CommandError) cleanup = await finished.error.cleanup;
  await browser?.close().catch(() => {});
  const report = {schema_version: "1.0", checked_at: new Date().toISOString(), purpose: "real_windows_webview2_packaged_asset_native_journal_smoke",
    success: success && (cleanup as any).status === "termination_reported", ui_checks_passed: success,
    checks, fixture_store: "isolated_app_directories_override_at_build_time", default_user_app_store_accessed: false,
    real_native_ipc: nativeIpcObserved, mocked_native_ipc: false, real_account_tested: false, real_model_inference: false,
    developer_http_endpoint_requests: developerEndpointRequests, process_cleanup: cleanup,
    scope_limits: ["Trusted smoke-only build configuration points to a new synthetic app store; shipped configuration is unchanged",
      "Read-only native journal bridge; CLI task launcher and automatic recovery are separate work",
      "Termination helper observation does not independently prove every WebView descendant is absent"]};
  await writeFile(withinRun(path.join(directory, "report.json")), JSON.stringify(report, null, 2) + "\n");
  console.log(`Report: ${path.join(directory, "report.json")}`);
}
assert.deepEqual((cleanup as any).status, "termination_reported", "native_smoke_process_cleanup_unconfirmed");
console.log(`PASS native Windows journal smoke: ${checks.length} checks`);
