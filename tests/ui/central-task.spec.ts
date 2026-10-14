import { test, expect, type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// These fixtures test the browser coordinator/IPC boundary, without a provider call.
const fixture = JSON.parse(readFileSync(path.join(process.cwd(), "services/coordinator/internal/catalog/catalog.json"), "utf8"));
const task = fixture.tasks.find((item: {id: string}) => item.id === "software-bounds");
const project = fixture.projects.find((item: {id: string}) => item.id === task.project_id);
const profileId = "a0000000-0000-4000-8000-000000000001";
const leaseId = "lease-central-ui";
const time = new Date("2026-10-14T12:00:00Z");
const bytes = Buffer.from("bounded native ZIP protocol fixture");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const artifact = {id: "artifact-central-ui", sha256, size_bytes: bytes.length};
const patch = "diff --git a/src/search.ts b/src/search.ts\n--- a/src/search.ts\n+++ b/src/search.ts\n@@ -1 +1 @@\n-old\n+new\n";
const lease = {
  id: leaseId, attempt_id: "attempt-central-ui", user_id: "private-account-owner", task_id: task.id,
  task_version: task.task_version, contract_hash: task.contract_hash, strategy_id: "boundary-first", state: "reserved",
  effective_limit_sec: 120, reserved_ms: 144000, spent_ms: 0, overrun_ms: 0,
  created_at: time.toISOString(), expires_at: new Date(time.getTime() + 144000).toISOString(),
};
const receipt = {
  id: "submission-central-ui", lease_id: leaseId, task_id: task.id, task_version: task.task_version,
  contract_hash: task.contract_hash, base_commit: task.workspace.commit, artifact, status: "submitted", created_at: time.toISOString(),
};
type NativeCall = {command: string; args: any};
type MockWindow = Window & {isTauri: boolean; __centralNative: {calls: NativeCall[]; value: any; lostStart: boolean; tamperPackage: boolean}; __TAURI_INTERNALS__: {invoke(command: string, args: any): Promise<unknown>}};
type API = {calls: {path: string; body: any; csrf: string | undefined}[]; reserveFail: boolean; lostReserve: boolean; lostUpload: boolean; lostSubmit: boolean; scannerUnavailable: boolean; capability: boolean; state: string; account: boolean; heartbeatState: string};

async function setup(page: Page, options: Partial<API> = {}) {
  const api: API = {calls: [], reserveFail: false, lostReserve: false, lostUpload: false, lostSubmit: false, scannerUnavailable: false,
    capability: true, state: "reserved", account: true, heartbeatState: "active", ...options};
  await page.clock.install({time}); await page.clock.pauseAt(new Date(time.getTime() + 1000));
  await page.addInitScript(({profileId, bytes, sha256, leaseId}) => {
    const target = window as MockWindow; target.isTauri = true;
    target.__centralNative = {calls: [], value: {schema_version: "1.0", availability: "available", operation: null}, lostStart: false, tamperPackage: false};
    target.__TAURI_INTERNALS__ = {invoke(command, args) {
      if (command === "local_run_limits_status") return Promise.resolve({schema_version: "1.0", availability: "available", limits: {attempt_sec: 1800, daily_sec: 7200, concurrency: 1}, usage: {used_sec: 0, open_sec: 0, remaining_sec: 7200, window_seconds: 86400}, effective: {max_sec: 1200, startable: true, reason: null}, paid_mode: "disabled"});
      const mock = target.__centralNative; mock.calls.push({command, args});
      if (command === "local_managed_profiles_status") return Promise.resolve({schema_version: "1.0", availability: "available", revision: 1,
        selected_profile_id: profileId, profiles: [{profile_id: profileId, provider: "codex", name: "Codex profilim"}]});
      if (command === "local_profile_session_status" || command === "local_cli_check_status") return Promise.resolve({schema_version: "1.0", availability: "available", operation: null});
      if (command === "local_operation_status") return Promise.resolve({status: "unavailable", reason: "operation_journal_missing", execution_enabled: false,
        automatic_recovery: false, worker_quiescence: "unknown", daemon_state: "unknown", operations: []});
      if (command === "local_task_run_start") {
        const request = args.request;
        mock.value = {schema_version: "1.0", availability: "available", operation: {
          request_id: request.request_id, profile_id: request.profile_id, provider: "codex", task_id: request.task_id, strategy_id: request.strategy_id,
          lease_context: request.lease_context, revision: 0, phase: "starting", outcome: null, error_code: null, cleanup: "pending", tool_calls: 0,
          model: {requested: "gpt-6-luna", observed: null}, result: null,
        }};
        if (mock.lostStart) { mock.lostStart = false; return Promise.reject(new Error("lost_native_start_response")); }
      }
      if (command === "local_task_run_cancel") mock.value = {...mock.value, operation: {...mock.value.operation,
        revision: args.request.expected_revision + 1, phase: "finished", outcome: "cancelled", error_code: "cancelled", cleanup: "verified", result: null}};
      if (command === "local_task_run_result_package") return Promise.resolve({schema_version: "1.0", request_id: args.request.request_id,
        lease_id: leaseId, bytes_base64: bytes, sha256: mock.tamperPackage ? "0".repeat(64) : sha256, size_bytes: atob(bytes).length});
      if (command.startsWith("local_task_run_")) return Promise.resolve(mock.value);
      return Promise.reject(new Error("unexpected_fixture_command"));
    }};
  }, {profileId, bytes: bytes.toString("base64"), sha256, leaseId});
  const fulfill = (route: Route, item: unknown, status = 200, execution = false) => route.fulfill({status, json: {
    source: "database", execution_enabled: execution, ...(execution ? {server_time: time.toISOString()} : {}), item,
  }});
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    if (request.method() === "POST") api.calls.push({path: pathname + url.search,
      body: pathname.endsWith("/artifacts") ? request.postDataBuffer() : request.postDataJSON(), csrf: request.headers()["x-csrf-token"]});
    if (pathname === "/api/v1/auth/session") return route.fulfill({json: api.account ? {authenticated: true,
      user: {id: "private-account-owner", display_name: "Grid kullanıcısı", provider: "github"}, csrf_token: "private-csrf-token", expires_at: "2099-01-01T00:00:00Z"} : {authenticated: false}});
    if (pathname === "/api/v1/auth/providers") return route.fulfill({json: {providers: [{id: "github", enabled: false}, {id: "google", enabled: false}]}});
    if (pathname === "/api/v1/auth/logout") { api.account = false; return route.fulfill({status: 204}); }
    if (pathname === "/api/v1/projects") return route.fulfill({json: {source: "database", execution_enabled: false, items: [project], next_cursor: ""}});
    if (pathname === "/api/v1/tasks") return route.fulfill({json: {source: "database", execution_enabled: false, items: [task], statuses: {[task.id]: "open"}, next_cursor: "",
      execution_capabilities: api.capability ? {[task.id]: {task_version: task.task_version, contract_hash: task.contract_hash,
        base_commit: task.workspace.commit, max_limit_sec: 1200, strategies: task.strategies.map((s: {id: string}) => s.id)}} : {}}});
    if (pathname.endsWith("/leases") && request.method() === "POST") {
      if (api.reserveFail) return route.fulfill({status: 409, json: {code: "budget_exhausted"}});
      if (api.lostReserve) { api.lostReserve = false; return route.abort("failed"); }
      return fulfill(route, {...lease, state: api.state}, 200, true);
    }
    if (pathname === `/api/v1/leases/${leaseId}/start`) { api.state = "active"; return fulfill(route, {...lease, state: api.state, started_at: time.toISOString()}, 200, true); }
    if (pathname === `/api/v1/leases/${leaseId}/heartbeat`) { api.state = api.heartbeatState; return fulfill(route, {...lease, state: api.state, started_at: time.toISOString()}, 200, true); }
    if (pathname === `/api/v1/leases/${leaseId}/stop`) { api.state = "stop_requested"; return fulfill(route, {...lease, state: api.state}); }
    if (pathname === `/api/v1/leases/${leaseId}/end`) { api.state = "released"; return fulfill(route, {...lease, state: api.state, ended_at: time.toISOString()}); }
    if (pathname === `/api/v1/leases/${leaseId}/artifacts`) {
      if (api.scannerUnavailable) { api.scannerUnavailable = false; return route.fulfill({status: 503, json: {code: "artifact_scanner_unavailable"}}); }
      if (api.lostUpload) { api.lostUpload = false; return route.abort("failed"); }
      return fulfill(route, artifact);
    }
    if (pathname === `/api/v1/leases/${leaseId}/result`) {
      api.state = "completed";
      if (api.lostSubmit) { api.lostSubmit = false; return route.abort("failed"); }
      return fulfill(route, receipt);
    }
    if (pathname === `/api/v1/leases/${leaseId}`) return fulfill(route, {...lease, state: api.state});
    return route.fulfill({status: 404, json: {code: "not_found"}});
  });
  await page.goto("/");
  await expect(page.locator(".task-card").filter({hasText: task.title})).toBeVisible();
  await page.locator(".task-card").filter({hasText: task.title}).click();
  await page.locator("#strategy").selectOption("boundary-first");
  await page.getByRole("button", {name: "Profil seçimini hazırla", exact: true}).click();
  const panel = page.locator(".task-run-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  return {api, panel};
}
const nativeCalls = (page: Page) => page.evaluate(() => (window as MockWindow).__centralNative.calls);
async function run(page: Page, panel: ReturnType<Page["locator"]>) {
  await panel.getByRole("checkbox").check(); await panel.getByRole("button", {name: "Başlat", exact: true}).click();
  await expect(panel).toContainText("Görev başlatılıyor");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  return (await nativeCalls(page)).find(call => call.command === "local_task_run_start")!.args.request;
}
async function finish(page: Page, passed = true) {
  await page.evaluate(({patch, sha256, passed}) => {
    const mock = (window as MockWindow).__centralNative;
    mock.value = {...mock.value, operation: {...mock.value.operation, revision: 7, phase: "finished", outcome: passed ? "passed" : "rejected",
      error_code: passed ? null : "candidate_rejected", cleanup: "verified", tool_calls: 4, model: {requested: "gpt-6-luna", observed: "gpt-6-luna"},
      result: {verifier: {passed, cases: 40, visible_tests_passed: true, hidden_cases_passed: passed}, candidate_sha256: sha256,
        patch_sha256: passed ? sha256 : null, patch: passed ? patch : null}}};
  }, {patch, sha256, passed});
  await page.getByRole("button", {name: "Görev durumunu yenile", exact: true}).click();
  await expect(page.locator(".task-run-panel")).toContainText(passed ? "Görev doğrulandı" : "Aday doğrulayıcı tarafından reddedildi");
}

test("central capability reserves and starts before IPC; verified result uploads only on explicit Submit", async ({page}) => {
  const {api, panel} = await setup(page); const request = await run(page, panel);
  expect(api.calls.map(call => call.path)).toEqual([`/api/v1/tasks/${task.id}/leases`, `/api/v1/leases/${leaseId}/start`]);
  expect(api.calls.every(call => call.csrf === "private-csrf-token")).toBe(true);
  expect(request.lease_context).toEqual({lease_id: leaseId, attempt_id: lease.attempt_id, task_version: task.task_version,
    contract_hash: task.contract_hash, base_commit: task.workspace.commit, strategy_id: "boundary-first", time_limit_sec: 120,
    expires_at_ms: time.getTime() + 121000});
  expect(JSON.stringify(request)).not.toContain("private-account-owner"); expect(JSON.stringify(request)).not.toContain("private-csrf-token");
  await finish(page); await expect(panel.getByRole("button", {name: "Gönder", exact: true})).toBeEnabled();
  // Local execution is finished; the server's delivery allowance remains usable.
  await page.clock.fastForward(120001);
  await expect(panel.getByRole("button", {name: "Gönder", exact: true})).toBeEnabled();
  expect(api.calls.some(call => /artifacts|result/.test(call.path))).toBe(false);
  await panel.getByRole("button", {name: "Gönder", exact: true}).click();
  await expect(panel.getByTestId("central-submission-receipt")).toContainText(receipt.id);
  await expect(panel.getByTestId("central-submission-receipt")).toContainText("kabul edildiği anlamına gelmez");
  expect(api.calls.filter(call => call.path.endsWith("/result"))[0].body).toEqual({task_version: task.task_version,
    contract_hash: task.contract_hash, base_commit: task.workspace.commit, request_key: expect.any(String), artifact});
  expect(api.calls.some(call => call.path.endsWith("/end"))).toBe(false);
  expect((await nativeCalls(page)).filter(call => call.command === "local_task_run_result_package")).toHaveLength(1);
});

test("database task without an explicit capability cannot start or fall back to a local run", async ({page}) => {
  const {api, panel} = await setup(page, {capability: false});
  await expect(panel.getByRole("checkbox")).toBeDisabled(); await expect(panel.getByRole("button", {name: "Başlat", exact: true})).toBeDisabled();
  await expect(panel).toContainText("merkezi çalıştırma kullanılamıyor");
  expect(api.calls).toHaveLength(0); expect((await nativeCalls(page)).some(call => call.command === "local_task_run_start")).toBe(false);
});

test("lost reserve response retries one reservation key and does not start native early", async ({page}) => {
  const {api, panel} = await setup(page, {lostReserve: true});
  await panel.getByRole("checkbox").check(); await panel.getByRole("button", {name: "Başlat", exact: true}).click();
  await expect(panel.getByTestId("central-execution-error")).toBeVisible();
  expect((await nativeCalls(page)).some(call => call.command === "local_task_run_start")).toBe(false);
  await panel.getByRole("button", {name: "Aynı başlatmayı tekrar dene", exact: true}).click();
  await expect(panel.getByTestId("central-lease-budget")).toContainText("active");
  const reserves = api.calls.filter(call => call.path.endsWith("/leases")); expect(reserves).toHaveLength(2);
  expect(reserves[1].body).toEqual(reserves[0].body);
  expect((await nativeCalls(page)).filter(call => call.command === "local_task_run_start")).toHaveLength(1);
});

test("budget rejection reports the central limit without starting a provider", async ({page}) => {
  const {api, panel} = await setup(page, {reserveFail: true});
  await panel.getByRole("checkbox").check(); await panel.getByRole("button", {name: "Başlat", exact: true}).click();
  await expect(panel.getByTestId("central-execution-error")).toContainText("süre bütçesi yetersiz");
  expect(api.calls).toHaveLength(1); expect((await nativeCalls(page)).some(call => call.command === "local_task_run_start")).toBe(false);
});

test("lost native start response retries the exact approved run and immutable lease context", async ({page}) => {
  const {api, panel} = await setup(page);
  await page.evaluate(() => { (window as MockWindow).__centralNative.lostStart = true; });
  await panel.getByRole("checkbox").check(); await panel.getByRole("button", {name: "Başlat", exact: true}).click();
  await expect(panel.getByTestId("central-execution-error")).toBeVisible();
  await panel.getByRole("button", {name: "Aynı başlatmayı tekrar dene", exact: true}).click();
  await expect(panel).toHaveAttribute("aria-busy", "false");
  const starts = (await nativeCalls(page)).filter(call => call.command === "local_task_run_start");
  expect(starts).toHaveLength(2); expect(starts[1].args).toEqual(starts[0].args);
  expect(api.calls.filter(call => call.path.endsWith("/leases"))).toHaveLength(1);
  expect(api.calls.filter(call => call.path.endsWith("/start"))).toHaveLength(1);
});

test("native result package with a mismatched SHA-256 never uploads", async ({page}) => {
  const {api, panel} = await setup(page); await run(page, panel); await finish(page);
  await page.evaluate(() => { (window as MockWindow).__centralNative.tamperPackage = true; });
  await panel.getByRole("button", {name: "Gönder", exact: true}).click();
  await expect(panel.getByTestId("central-execution-error")).toBeVisible();
  expect(api.calls.some(call => /artifacts|result/.test(call.path))).toBe(false);
});

for (const lost of ["lostUpload", "lostSubmit", "scannerUnavailable"] as const) test(`${lost} retries stable artifact/submission keys and preserves explicit review`, async ({page}) => {
  const {api, panel} = await setup(page, {[lost]: true}); await run(page, panel); await finish(page);
  await panel.getByRole("button", {name: "Gönder", exact: true}).click();
  await expect(panel.getByTestId("central-execution-error")).toBeVisible();
  await expect(panel.getByTestId("central-submission-receipt")).toHaveCount(0);
  await panel.getByRole("button", {name: "Gönder", exact: true}).click();
  await expect(panel.getByTestId("central-submission-receipt")).toContainText(receipt.id);
  const attempts = api.calls.filter(call => lost !== "lostSubmit" ? call.path.includes("/artifacts") : call.path.endsWith("/result"));
  expect(attempts).toHaveLength(2); expect(attempts[1].path).toBe(attempts[0].path); expect(attempts[1].body).toEqual(attempts[0].body);
  expect(api.calls.some(call => call.path.endsWith("/end"))).toBe(false);
  expect((await nativeCalls(page)).filter(call => call.command === "local_task_run_result_package")).toHaveLength(1);
});

test("native cancellation closes the central lease after verified cleanup", async ({page}) => {
  const {api, panel} = await setup(page); await run(page, panel);
  await panel.getByRole("button", {name: "İptal", exact: true}).click();
  await expect(panel).toContainText("Görev iptal edildi");
  await expect.poll(() => api.state).toBe("released");
  expect(api.calls.filter(call => /\/(stop|end)$/.test(call.path)).map(call => call.path)).toEqual([`/api/v1/leases/${leaseId}/stop`, `/api/v1/leases/${leaseId}/end`]);
  expect(api.calls.find(call => call.path.endsWith("/end"))!.body).toEqual({reason: "stopped"});
});

test("heartbeat survives navigation and stops the native run when central stop is requested", async ({page}) => {
  const {api, panel} = await setup(page, {heartbeatState: "stop_requested"}); await run(page, panel);
  await page.getByRole("navigation").getByRole("button", {name: /^Çalışma alanı/}).click();
  await page.clock.fastForward(15001);
  await expect.poll(async () => (await nativeCalls(page)).filter(call => call.command === "local_task_run_cancel").length).toBe(1);
  await page.clock.fastForward(15001); await expect.poll(() => api.state).toBe("released");
  expect(api.calls.some(call => call.path.endsWith("/heartbeat"))).toBe(true);
});

test("rejected local candidate cannot be exported or submitted and releases its lease", async ({page}) => {
  const {api, panel} = await setup(page); await run(page, panel); await finish(page, false);
  await expect(panel.getByRole("button", {name: "Gönder", exact: true})).toHaveCount(0);
  await page.clock.fastForward(15001); await expect.poll(() => api.state).toBe("released");
  expect(api.calls.some(call => /artifacts|result/.test(call.path))).toBe(false);
  expect((await nativeCalls(page)).some(call => call.command === "local_task_run_result_package")).toBe(false);
});

test("lost committed submission is reconciled with its original key during navigation before lease cleanup", async ({page}) => {
  const {api, panel} = await setup(page, {lostSubmit: true}); await run(page, panel); await finish(page);
  await panel.getByRole("button", {name: "Gönder", exact: true}).click();
  await expect(panel.getByTestId("central-execution-error")).toBeVisible(); expect(api.state).toBe("completed");
  await page.getByRole("navigation").getByRole("button", {name: /^Çalışma alanı/}).click();
  await page.clock.fastForward(15001);
  await expect.poll(() => api.calls.filter(call => call.path.endsWith("/result")).length).toBe(2);
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  await expect(page.getByTestId("central-submission-receipt")).toContainText(receipt.id);
  const submissions = api.calls.filter(call => call.path.endsWith("/result")); expect(submissions[1].body).toEqual(submissions[0].body);
  expect(api.calls.some(call => /\/(stop|end)$/.test(call.path))).toBe(false);
});

test("captured native deadline stops an unfinished run and releases the central budget", async ({page}) => {
  const {api, panel} = await setup(page); await run(page, panel);
  await page.clock.fastForward(121001);
  await expect.poll(async () => (await nativeCalls(page)).filter(call => call.command === "local_task_run_cancel").length).toBe(1);
  await page.clock.fastForward(15001); await expect.poll(() => api.state).toBe("released");
  expect(api.calls.some(call => /artifacts|result/.test(call.path))).toBe(false);
});

test("logout clears private central receipt controls while the actual native run remains observable", async ({page}) => {
  const {api, panel} = await setup(page); const request = await run(page, panel);
  await page.getByRole("navigation").getByRole("button", {name: "Hesabım", exact: true}).click();
  await page.getByRole("button", {name: "Çıkış yap", exact: true}).click();
  await expect(page.getByRole("button", {name: "Çıkış yap", exact: true})).toHaveCount(0);
  const callsAfterLogout = api.calls.length;
  await page.clock.fastForward(15001); expect(api.calls.length).toBe(callsAfterLogout);
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  await expect(page.getByTestId("execution-selection")).toHaveAttribute("data-selection-kind", "controlled");
  await expect(page.locator(".task-run-progress")).toContainText(task.id);
  await expect(page.getByTestId("central-lease-budget")).toHaveCount(0);
  const native = (await nativeCalls(page)).filter(call => call.command === "local_task_run_start"); expect(native[0].args.request.request_id).toBe(request.request_id);
  expect(native).toHaveLength(1);
});
