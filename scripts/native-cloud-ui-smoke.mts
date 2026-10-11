import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { CommandError, runOwnedCommand, type CommandCleanup } from "../packages/agent-adapters/src/owned-process.ts";
import { root } from "./go.mjs";

// Real PostgreSQL/HTTP responses, with test-only synthetic identity transport.
// No official CLI, inference, production account or user profile is accessed.
assert.equal(process.platform, "win32", "Windows WebView2 required");
const argument = (name: string) => { const index = process.argv.indexOf(name); assert.ok(index >= 0 && process.argv[index + 1]); return process.argv[index + 1]; };
const api = new URL(argument("--api-url"));
assert.ok(api.protocol === "http:" && api.hostname === "127.0.0.1" && !api.username && !api.password && !api.search && !api.hash);
const ready = JSON.parse(await readFile(argument("--ready-file"), "utf8"));
assert.equal(ready.url, api.origin); assert.equal(ready.count, 65);
const directory = path.join(root, ".local/native-cloud-ui-smoke", randomUUID());
await mkdir(directory, {recursive: true});
const config = path.join(directory, "tauri-smoke.json");
await writeFile(config, JSON.stringify({app: {appDirectoriesOverride: path.join(directory, "appdata"),
  windows: [{label: "main", title: "CommonGrid cloud UI acceptance", visible: false, width: 780, height: 1000, minWidth: 780}],
}}, null, 2));
const checks: string[] = [], requests: string[] = [], pageErrors: string[] = [];
let success = false, stage = "build", browser: Browser | undefined;
let nativePage: Page | undefined;
let cleanup: CommandCleanup = {method: "none", status: "not_started"};
let buildCleanup: CommandCleanup = {method: "none", status: "not_started"};
let controller: AbortController | undefined;
let completion: Promise<{error?: unknown}> | undefined;
async function noOverflow(page: Page) {
  const result = await page.evaluate(() => ({width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
    fields: [...document.querySelectorAll(".detail-fields dd, .detail-text")].some(el => el.scrollWidth > el.clientWidth + 1)}));
  assert.ok(result.width <= 780 && result.width >= 750, `unexpected_native_width:${result.width}`);
  assert.equal(result.overflow, false, "document_horizontal_overflow");
  assert.equal(result.fields, false, "detail_field_horizontal_overflow");
}
try {
  console.log("Building isolated native cloud UI acceptance…");
  const worker = "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'a');const child=require('node:child_process').spawn(process.execPath,process.argv.slice(2),{stdio:['ignore',fd,fd],windowsHide:true});child.once('error',()=>{process.exitCode=1;});child.once('close',code=>{fs.closeSync(fd);process.exitCode=code??1;});";
  try {
    const built = await runOwnedCommand(process.execPath, ["-e", worker, path.join(directory, "build.log"),
      path.join(root, "scripts/native.mjs"), "build", "--debug", "--no-bundle", "--config", config], {timeoutMs: 600_000});
    assert.equal(built.code, 0, "native_build_failed_see_ignored_build_log");
  } catch (error) {
    if (error instanceof CommandError) buildCleanup = await error.cleanup;
    throw error;
  }
  stage = "native";
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve);});
  const address = listener.address(); assert.ok(address && typeof address === "object"); const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const previous = process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
  controller = new AbortController();
  let finished = false;
  const running = runOwnedCommand(path.join(root, "apps/desktop/src-tauri/target/debug/commongrid-desktop.exe"), [],
    {signal: controller.signal, timeoutMs: 180_000});
  completion = running.then(() => {finished = true; return {};}, error => {finished = true; return {error};});
  if (previous === undefined) delete process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  else process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = previous;
  let connected = false;
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && !finished;) {
    try {connected = (await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(500)})).ok;} catch {}
    if (connected) break; await delay(200);
  }
  assert.equal(connected, true, "native_cdp_unavailable");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {timeout: 10_000});
  const context = browser.contexts()[0]; assert.ok(context);
  // WebView2 custom-protocol traffic bypasses CDP HTTP routing. A test-only
  // binding forwards read requests to the real coordinator and returns its
  // untouched HTTP body/status. No response fixture or native IPC is mocked.
  await context.exposeBinding("__cloudUIRead", async (_source, input: string) => {
    const url = new URL(input);
    assert.ok(url.hostname === "tauri.localhost" && url.pathname.startsWith("/api/v1/"));
    const response = await fetch(api.origin + url.pathname + url.search, {signal: AbortSignal.timeout(10_000), redirect: "error"});
    requests.push(url.pathname + url.search);
    return {status: response.status, body: await response.text(), contentType: response.headers.get("content-type") ?? "application/json"};
  });
  await context.addInitScript(() => {
    const original = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== location.origin || !url.pathname.startsWith("/api/v1/")) return original(input, init);
      if (request.method !== "GET") throw new Error("acceptance_must_remain_read_only");
      if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const response = await (globalThis as any).__cloudUIRead(request.url);
      if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
      return new Response(response.body, {status: response.status, headers: {"content-type": response.contentType}});
    };
  });
  const page = context.pages()[0] ?? await context.waitForEvent("page", {timeout: 10_000});
  nativePage = page;
  page.setDefaultTimeout(15_000); page.on("pageerror", error => pageErrors.push(error.message.slice(0, 1000)));
  await page.waitForURL(url => url.hostname === "tauri.localhost" || url.protocol === "tauri:");
  await page.reload({waitUntil: "domcontentloaded"});
  assert.equal(await page.evaluate(() => (globalThis as any).isTauri), true);
  await expect(page.locator(".task-card")).toHaveCount(50);
  await expect(page.locator(".task-card .td-status").first()).toHaveAttribute("data-status", "awaiting_review");
  const dependency = page.getByTestId("task-dependencies");
  await page.locator(".task-card", {hasText: "Cloud catalog task 000"}).click();
  await expect(dependency.locator("[data-relation-state=unloaded]")).toContainText("zz-page-063");
  await page.getByRole("button", {name: "Daha fazla görev yükle", exact: true}).click();
  await expect(page.locator(".task-card")).toHaveCount(65);
  await expect(dependency.locator("[data-relation-state=visible]")).toContainText("Cloud catalog task 063");
  await dependency.getByRole("button", {name: "Aç: Cloud catalog task 063", exact: true}).click();
  await expect(page.locator(".task-card.selected")).toContainText("Cloud catalog task 063");
  await page.getByLabel("Duruma göre filtrele").selectOption("awaiting_review");
  await expect(page.locator(".task-card")).toHaveCount(1);
  await page.getByLabel("Duruma göre filtrele").selectOption("all");
  await page.locator(".task-card").first().click();
  await noOverflow(page);
  await dependency.scrollIntoViewIfNeeded();
  await page.screenshot({path: path.join(directory, "catalog-780.png")});
  checks.push("real_native_780_catalog_50_plus_15_status_filter_cross_page_dependency_navigation");
  await page.getByRole("navigation", {name: "Main navigation"}).getByRole("button", {name: "Katkılarım", exact: true}).click();
  const detail = page.locator("#contribution-detail");
  const readOptions = {signal: AbortSignal.timeout(10_000), redirect: "error" as const};
  const leaseResponse = await fetch(`${api.origin}/api/v1/leases/${encodeURIComponent(ready.leaseID)}`, readOptions);
  assert.equal(leaseResponse.status, 200);
  const lease = (await leaseResponse.json()).item;
  const submissionResponse = await fetch(`${api.origin}/api/v1/submissions/${encodeURIComponent(ready.submissionID)}`, {...readOptions, signal: AbortSignal.timeout(10_000)});
  assert.equal(submissionResponse.status, 200);
  const submitted = (await submissionResponse.json()).item;
  const checkpointResponse = await fetch(`${api.origin}/api/v1/checkpoints/${encodeURIComponent(ready.checkpointID)}`, {...readOptions, signal: AbortSignal.timeout(10_000)});
  assert.equal(checkpointResponse.status, 200);
  const checkpoint = (await checkpointResponse.json()).item;
  await page.locator(".receipt-open").first().click();
  await expect(detail.getByRole("heading", {name: "Deneme ayrıntıları"})).toBeVisible();
  await expect(detail).toContainText(lease.attempt_id);
  await expect(detail).toContainText(lease.strategy_id);
  assert.ok(requests.includes(`/api/v1/leases/${ready.leaseID}`));
  await noOverflow(page); checks.push("real_database_lease_detail");
  await page.getByRole("button", {name: "Gönderilen sonuçlar", exact: true}).click();
  await page.locator(".receipt-open").first().click();
  await expect(detail.getByRole("heading", {name: "Gönderim ayrıntıları"})).toBeVisible();
  await expect(detail).toContainText(submitted.lease_id);
  await expect(detail).toContainText(submitted.artifact.id);
  await expect(detail).toContainText(submitted.artifact.sha256);
  await expect(detail).toContainText(submitted.base_commit);
  await expect(detail.locator(".detail-row").filter({hasText: "Artifact boyutu"})).toContainText(submitted.artifact.size_bytes.toLocaleString("tr"));
  assert.ok(requests.includes(`/api/v1/submissions/${ready.submissionID}`));
  await noOverflow(page);
  await detail.screenshot({path: path.join(directory, "submission-780.png")});
  checks.push("real_database_submission_artifact_receipt_detail");
  await page.getByRole("button", {name: "Kaydedilen ilerleme", exact: true}).click();
  await page.locator(".receipt-open").first().click();
  await expect(detail).toContainText(checkpoint.artifact.id);
  assert.ok(requests.includes(`/api/v1/checkpoints/${ready.checkpointID}`));
  assert.ok(checkpoint.metadata.summary.includes("😀") && checkpoint.metadata.continuation_instructions.includes("🧭"));
  await expect(page.getByTestId("checkpoint-summary")).toHaveText(checkpoint.metadata.summary);
  await expect(page.getByTestId("checkpoint-instructions")).toHaveText(checkpoint.metadata.continuation_instructions);
  await noOverflow(page);
  await detail.getByRole("button", {name: "Uyumlu kaydı kontrol et", exact: true}).click();
  const resumed = page.getByTestId("resume-record");
  await expect(resumed).toContainText(checkpoint.artifact.id);
  await expect(resumed).toContainText(checkpoint.artifact.sha256);
  await expect(resumed.getByTestId("checkpoint-instructions")).toHaveText(checkpoint.metadata.continuation_instructions);
  await noOverflow(page);
  await detail.screenshot({path: path.join(directory, "checkpoint-780.png")});
  checks.push("real_database_checkpoint_read_only_compatible_resume_and_unicode_long_text_wrapping");
  assert.ok(requests.some(value => value.startsWith("/api/v1/tasks?after=")));
  assert.ok(requests.some(value => value.startsWith("/api/v1/tasks/task/resume?")));
  assert.deepEqual(pageErrors, []);
  success = true;
} finally {
  if (!success && nativePage) await nativePage.screenshot({path: path.join(directory, "failed-native.png"), timeout: 5000}).catch(() => {});
  controller?.abort();
  const finished = await completion;
  if (finished?.error instanceof CommandError) cleanup = await finished.error.cleanup;
  if (browser) await Promise.race([browser.close(), delay(5000)]).catch(() => {});
  success = success && cleanup.status === "termination_reported";
  await writeFile(path.join(directory, "report.json"), JSON.stringify({checked_at: new Date().toISOString(), success, stage, checks,
    platform: "windows_webview2", viewport_width: 780, real_database: true, real_coordinator: true, mocked_api_responses: false,
    authentication: "synthetic_fixture_identity_and_in_memory_test_session_transport",
    scanner: process.env.CG_REQUIRE_TRIVY_TESTS === "1" || process.env.CG_TEST_TRIVY_BINARY || process.env.CG_TEST_TRIVY_SHA256 ? "pinned_trivy" : "explicit_fixture", verifier: "trusted_fixture",
    real_account_tested: false, real_model_inference: false, production_login_transport_tested: false,
    isolated_appdata: true, process_cleanup: cleanup, build_cleanup: buildCleanup, scope_limits: ["Hidden debug unbundled native executable with a test-only CDP fetch binding forwarding actual HTTP responses from the coordinator",
      "Owned process termination reported; absence of every WebView descendant is not independently proven"], requests, pageErrors}, null, 2) + "\n");
  console.log(`Report: ${path.join(directory, "report.json")}`);
}
assert.equal(success, true, "native_cloud_ui_acceptance_failed");
console.log(`PASS native cloud UI: ${checks.length} checks`);
