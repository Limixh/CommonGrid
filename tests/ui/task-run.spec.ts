import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ManagedProfilesStatus } from "../../packages/agent-adapters/src/managed-profile-protocol";
import { taskRunCatalogPins, taskRunErrors, type TaskRunOperation, type TaskRunStatus } from "../../packages/agent-adapters/src/task-run-protocol";
import { contractHash } from "../../packages/task-schema/src/index";

const profileId = "a0000000-0000-4000-8000-000000000001";
const secondId = "a0000000-0000-4000-8000-000000000002";
const runId = "c0000000-0000-4000-8000-000000000001";
const taskId = "controlled-sum-integers-v1";
const catalogFixture = JSON.parse(readFileSync(path.join(process.cwd(), "services/coordinator/internal/catalog/catalog.json"), "utf8"));
const softwareTask = catalogFixture.tasks.find((task: {id: string}) => task.id === "software-bounds");
const leanTask = catalogFixture.tasks.find((task: {id: string}) => task.id === "lean-add-comm");
const softwareId = "software-bounds";
const candidateHash = "0123456789abcdef".repeat(4);
const patchHash = "fedcba9876543210".repeat(4);
const empty: TaskRunStatus = {schema_version: "1.0", availability: "available", operation: null};
const profiles: ManagedProfilesStatus = {
  schema_version: "1.0", availability: "available", revision: 1, selected_profile_id: profileId,
  profiles: [{profile_id: profileId, provider: "codex", name: "Codex profilim"}, {profile_id: secondId, provider: "claude", name: "Claude profilim"}],
};
const patch = [
  "diff --git a/sum.mjs b/sum.mjs", "--- a/sum.mjs", "+++ b/sum.mjs", "@@ -1,4 +1,4 @@", " export function sum(values) {",
  "-  return values.reduce((a, b) => a - b, 0);", "+  return values.reduce((a, b) => a + b, 0);",
  "+  // <img src=x onerror=\"window.__pwned = true\">", " }", "",
].join("\n");
const envelope = (operation: unknown) => ({...empty, operation});
const operation = (changes: Partial<TaskRunOperation> = {}): TaskRunOperation => ({
  request_id: runId, profile_id: profileId, provider: "codex", task_id: taskId, strategy_id: null, revision: 3, phase: "running", outcome: null, error_code: null,
  cleanup: "pending", tool_calls: 5, model: {requested: "gpt-6-luna", observed: "gpt-6-luna"}, result: null, ...changes,
});
const running = envelope(operation());
const passed = envelope(operation({
  revision: 9, phase: "finished", outcome: "passed", cleanup: "verified", tool_calls: 7,
  result: {verifier: {passed: true, cases: 34, json_cases_passed: true, sparse_cases_passed: true}, candidate_sha256: candidateHash, patch_sha256: patchHash, patch},
}));
const rejected = envelope(operation({
  revision: 9, phase: "finished", outcome: "rejected", error_code: "candidate_rejected", cleanup: "verified", tool_calls: 7,
  result: {verifier: {passed: false, cases: 34, json_cases_passed: true, sparse_cases_passed: false}, candidate_sha256: candidateHash, patch_sha256: null, patch: null},
}));
const softwarePatch = [
  "diff --git a/src/search.ts b/src/search.ts", "--- a/src/search.ts", "+++ b/src/search.ts", "@@ -2,3 +2,3 @@", " export function lowerBound(values: number[], target: number): number {",
  "-  let hi = values.length - 1;", "+  let hi = values.length;", "+  // <b onmouseover=\"window.__pwned = true\">", " }", "",
].join("\n");
const softwareOperation = (changes: Partial<TaskRunOperation> = {}) => operation({task_id: softwareId, strategy_id: "invariant", ...changes});
const softwarePassed = envelope(softwareOperation({
  revision: 9, phase: "finished", outcome: "passed", cleanup: "verified", tool_calls: 6,
  result: {verifier: {passed: true, cases: 40, visible_tests_passed: true, hidden_cases_passed: true}, candidate_sha256: candidateHash, patch_sha256: patchHash, patch: softwarePatch},
}));
const softwareRejected = (visible: boolean, hidden: boolean) => envelope(softwareOperation({
  revision: 9, phase: "finished", outcome: "rejected", error_code: "candidate_rejected", cleanup: "verified", tool_calls: 6,
  result: {verifier: {passed: false, cases: 40, visible_tests_passed: visible, hidden_cases_passed: hidden}, candidate_sha256: candidateHash, patch_sha256: null, patch: null},
}));
const failed = (error_code: string) => envelope(operation({revision: 9, phase: "finished", outcome: "failed", error_code: error_code as never, cleanup: "verified", tool_calls: 0, model: {requested: "gpt-6-luna", observed: null}}));
const needsReview = envelope(operation({revision: 9, phase: "finished", outcome: "needs_review", error_code: "cleanup_failed", cleanup: "unknown"}));

type Call = {command: string; args: any};
type Mock = {
  profiles: ManagedProfilesStatus; value: unknown; calls: Call[]; rejected: boolean; pending: ((value: unknown) => void)[];
  deferStart: boolean; cancelConflictValue: unknown | null; copied: string | null; copyFails: boolean;
  limits: {attempt_sec: number; daily_sec: number; used_sec: number; open_sec: number}; limitCalls: Call[]; limitsSaveFails: boolean;
};
type MockWindow = Window & {isTauri: boolean; __taskMock: Mock; __pwned?: boolean; __TAURI_INTERNALS__: {invoke: (command: string, args: any) => Promise<unknown>}};
async function freezeClock(page: Page) {
  const time = new Date("2026-10-11T12:00:00Z");
  await page.clock.install({time}); await page.clock.pauseAt(new Date(time.getTime() + 1000));
}
async function mockNative(page: Page, value: unknown = empty, profileState = profiles, limits: Partial<Mock["limits"]> = {}) {
  await page.addInitScript(({value, profiles, limits}) => {
    const target = window as MockWindow; target.isTauri = true;
    target.__taskMock = {value, profiles, calls: [], rejected: false, pending: [], deferStart: false, cancelConflictValue: null, copied: null, copyFails: false,
      limits: {attempt_sec: 1800, daily_sec: 7200, used_sec: 0, open_sec: 0, ...limits}, limitCalls: [], limitsSaveFails: false};
    // Mirrors the native computation: min(task ceiling, attempt cap, remaining 24 h budget).
    const limitsStatus = () => {
      const {attempt_sec, daily_sec, used_sec, open_sec} = target.__taskMock.limits;
      const remaining = Math.max(0, daily_sec - used_sec - open_sec), max = Math.min(1200, attempt_sec, remaining), startable = max >= 60;
      return {schema_version: "1.0", availability: "available", limits: {attempt_sec, daily_sec, concurrency: 1},
        usage: {used_sec, open_sec, remaining_sec: remaining, window_seconds: 86400},
        effective: {max_sec: max, startable, reason: startable ? null : "local_budget_exhausted"}, paid_mode: "disabled"};
    };
    Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText: (text: string) => {
      if (target.__taskMock.copyFails) return Promise.reject(new Error("denied"));
      target.__taskMock.copied = text; return Promise.resolve();
    }}});
    target.__TAURI_INTERNALS__ = {invoke: (command, args) => {
      const mock = target.__taskMock;
      if (command === "local_managed_profiles_status") return Promise.resolve(mock.profiles);
      if (command === "local_managed_profile_select") {
        mock.profiles = {...mock.profiles, revision: mock.profiles.revision + 1, selected_profile_id: args.request.profile_id};
        return Promise.resolve(mock.profiles);
      }
      if (command === "local_profile_session_status") return Promise.resolve({schema_version: "1.0", availability: "available", operation: null});
      if (command === "local_cli_check_status") return Promise.resolve({schema_version: "1.0", availability: "available", operation: null});
      if (command === "local_operation_status") return Promise.resolve({status: "unavailable", reason: "operation_journal_missing", execution_enabled: false, automatic_recovery: false, worker_quiescence: "unknown", daemon_state: "unknown", operations: []});
      if (command === "local_run_limits_status" || command === "local_run_limits_save") {
        mock.limitCalls.push({command, args});
        if (command === "local_run_limits_save") {
          if (mock.limitsSaveFails) return Promise.reject(new Error("PRIVATE_NATIVE_DETAIL"));
          mock.limits.attempt_sec = args.request.attempt_sec; mock.limits.daily_sec = args.request.daily_sec;
        }
        return Promise.resolve(limitsStatus());
      }
      if (!command.startsWith("local_task_run_")) return Promise.reject(new Error("unexpected_fixture_command"));
      mock.calls.push({command, args});
      if (mock.rejected) return Promise.reject(new Error("PRIVATE_PROVIDER_DETAIL"));
      if (command === "local_task_run_start") {
        const request = args.request;
        const profile = mock.profiles.profiles.find(profile => profile.profile_id === request.profile_id)!;
        mock.value = {schema_version: "1.0", availability: "available", operation: {
          request_id: request.request_id, profile_id: request.profile_id, provider: profile.provider, task_id: request.task_id, strategy_id: request.strategy_id, revision: 0,
          phase: "starting", outcome: null, error_code: null, cleanup: "pending", tool_calls: 0,
          model: {requested: profile.provider === "codex" ? "gpt-6-luna" : "haiku", observed: null}, result: null,
        }};
        if (mock.deferStart) return new Promise(resolve => mock.pending.push(resolve));
      }
      if (command === "local_task_run_cancel") {
        if (mock.cancelConflictValue !== null) {
          mock.value = mock.cancelConflictValue; mock.cancelConflictValue = null;
          return Promise.reject(new Error("PRIVATE_REVISION_CONFLICT"));
        }
        const state = mock.value as TaskRunStatus;
        mock.value = {...state, operation: {...state.operation!, revision: args.request.expected_revision + 1, phase: "finished", outcome: "cancelled", error_code: "cancelled", cleanup: "verified", result: null}};
      }
      return Promise.resolve(mock.value);
    }};
  }, {value, profiles: profileState, limits});
}
async function open(page: Page) {
  await page.goto("/"); await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  const panel = page.locator(".task-run-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  return panel;
}
async function setValue(page: Page, value: unknown) { await page.evaluate(value => { (window as MockWindow).__taskMock.value = value; }, value); }
async function refresh(page: Page) { await page.getByRole("button", {name: "Görev durumunu yenile", exact: true}).click(); }
async function limitCalls(page: Page) { return page.evaluate(() => (window as MockWindow).__taskMock.limitCalls); }
async function calls(page: Page) { return page.evaluate(() => (window as MockWindow).__taskMock.calls); }
const start = (panel: ReturnType<Page["locator"]>) => panel.getByRole("button", {name: "Başlat", exact: true});
const cancel = (panel: ReturnType<Page["locator"]>) => panel.getByRole("button", {name: "İptal", exact: true});
async function approve(panel: ReturnType<Page["locator"]>) { await panel.getByRole("checkbox").check(); }

test("browser mode explains that task runs need the desktop application and cannot start", async ({page}) => {
  await page.goto("/");
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  await expect(page.getByText("Profil oluşturma ve seçme masaüstü uygulamasında kullanılabilir.")).toBeVisible();
  await expect(page.locator(".task-run-panel")).toHaveCount(0);
});

test("an unavailable native task run shows the desktop-only message and keeps Başlat disabled", async ({page}) => {
  await mockNative(page, {schema_version: "1.0", availability: "unavailable", operation: null}); const panel = await open(page);
  await expect(panel).toContainText("Görev çalıştırma masaüstü uygulamasında kullanılabilir.");
  await expect(panel.getByRole("checkbox")).toBeDisabled(); await expect(start(panel)).toBeDisabled();
});

test("the task card names the task, the exact model per provider, the limits and the subscription quota", async ({page}) => {
  await mockNative(page); const panel = await open(page);
  await expect(panel).toContainText("Kontrollü doğrulama görevi: sum.mjs");
  await expect(panel.locator(".task-run-card code")).toHaveText("gpt-6-luna");
  for (const text of ["Görev çalışma alanında ağ erişimi yok", "En fazla 16 araç çağrısı", "Etkin süre sınırı 20 dk (görev 20 dk · tek deneme 30 dk · son 24 saatte kalan 120 dk). Ücretli API kapalı.", "34 örnekli bağımsız doğrulayıcı", "Yalnız doğrulanmış diff gösterilir", "kendi Claude veya Codex aboneliğinin kotasını"])
    await expect(panel).toContainText(text);
  await page.locator(".managed-profile-list li").filter({hasText: "Claude profilim"}).getByRole("button", {name: "Bu profili seç", exact: true}).click();
  await expect(panel.locator(".task-run-card code")).toHaveText("haiku");
});

test("Başlat needs explicit approval and sends only the fixed task, the profile and a fresh request id", async ({page}) => {
  await freezeClock(page); await mockNative(page); const panel = await open(page);
  await expect(panel.getByRole("checkbox")).not.toBeChecked(); await expect(start(panel)).toBeDisabled();
  await approve(panel); await expect(start(panel)).toBeEnabled();
  await panel.getByRole("checkbox").uncheck(); await expect(start(panel)).toBeDisabled();
  await approve(panel); await start(panel).click();
  await expect(panel).toContainText("Görev başlatılıyor");
  const starts = (await calls(page)).filter(call => call.command === "local_task_run_start");
  expect(starts).toHaveLength(1);
  expect(starts[0].args).toEqual({request: {schema_version: "1.0", request_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), profile_id: profileId, task_id: taskId, strategy_id: null, approved: true}});
  expect((await calls(page)).filter(call => call.command === "local_task_run_status").every(call => JSON.stringify(call.args) === "{}")).toBe(true);
  // Approval is consumed and another start is blocked while the run is active.
  await expect(panel.getByRole("checkbox")).not.toBeChecked(); await expect(start(panel)).toBeDisabled(); await expect(panel.getByRole("checkbox")).toBeDisabled();
});

test("progress shows the phase, tool calls, observed model and advances to the verified result by polling", async ({page}) => {
  await freezeClock(page); await mockNative(page); const panel = await open(page);
  await approve(panel); await start(panel).click();
  const request = (await calls(page)).find(call => call.command === "local_task_run_start")!.args.request;
  const mine = (changes: Partial<TaskRunOperation>) => envelope(operation({request_id: request.request_id, ...changes}));
  await setValue(page, mine({revision: 1, phase: "preparing", tool_calls: 0, model: {requested: "gpt-6-luna", observed: null}}));
  await page.clock.fastForward(1100); await expect(panel).toContainText("İzole ortam hazırlanıyor");
  await expect(panel.getByText("Gözlenen model")).toHaveCount(0);
  await setValue(page, mine({revision: 4, tool_calls: 5}));
  await page.clock.fastForward(1100);
  const progress = panel.locator(".task-run-progress");
  await expect(progress).toContainText("Ajan çalışıyor"); await expect(progress).toContainText("Araç çağrısı: 5 / 16"); await expect(progress).toContainText("Gözlenen model: gpt-6-luna");
  await expect(progress).toHaveAttribute("role", "status"); await expect(start(panel)).toBeDisabled();
  await setValue(page, mine({revision: 5, phase: "verifying", tool_calls: 7}));
  await page.clock.fastForward(1100); await expect(progress).toContainText("Bağımsız doğrulayıcı çalışıyor");
  await setValue(page, mine({revision: 6, phase: "cleaning", tool_calls: 7}));
  await page.clock.fastForward(1100); await expect(progress).toContainText("Ortam temizleniyor"); await expect(cancel(panel)).toBeDisabled();
  await setValue(page, envelope({...(passed.operation as TaskRunOperation), request_id: request.request_id}));
  await page.clock.fastForward(1100); await expect(panel).toContainText("Görev doğrulandı");
  await expect(panel.locator(".task-run-progress")).toHaveCount(0); await expect(cancel(panel)).toHaveCount(0);
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  const reads = (await calls(page)).length; await page.clock.fastForward(10_000);
  expect((await calls(page)).length).toBe(reads);
});

test("İptal targets the observed revision and shows the cancelled outcome", async ({page}) => {
  await freezeClock(page); await mockNative(page, running); const panel = await open(page);
  await expect(cancel(panel)).toBeEnabled(); await cancel(panel).click();
  await expect(panel).toContainText("Görev iptal edildi");
  expect((await calls(page)).filter(call => call.command === "local_task_run_cancel")).toEqual([
    {command: "local_task_run_cancel", args: {request: {schema_version: "1.0", request_id: runId, expected_revision: 3}}},
  ]);
  await expect(cancel(panel)).toHaveCount(0); await expect(panel.getByRole("checkbox")).toBeEnabled();
});

test("İptal resynchronizes one stale revision and never retries against a replacement run", async ({page}) => {
  await freezeClock(page); await mockNative(page, running); const panel = await open(page);
  await page.evaluate(value => { (window as MockWindow).__taskMock.cancelConflictValue = value; }, envelope(operation({revision: 4, tool_calls: 6})));
  await cancel(panel).click(); await expect(panel).toContainText("Görev iptal edildi");
  expect((await calls(page)).filter(call => call.command === "local_task_run_cancel").map(call => call.args.request.expected_revision)).toEqual([3, 4]);
});

test("a conflicting cancel against a replacement run is an error, not a retry", async ({page}) => {
  await freezeClock(page); await mockNative(page, running); const panel = await open(page);
  await page.evaluate(value => { (window as MockWindow).__taskMock.cancelConflictValue = value; }, envelope(operation({request_id: "c0000000-0000-4000-8000-000000000002", revision: 0})));
  await cancel(panel).click(); await expect(panel.getByRole("alert")).toBeVisible();
  expect((await calls(page)).filter(call => call.command === "local_task_run_cancel")).toHaveLength(1);
  await expect(start(panel)).toBeDisabled();
});

test("a passed run shows the verifier summary, shortened hashes and the diff as classified plain text lines", async ({page}) => {
  await freezeClock(page); await mockNative(page, passed); const panel = await open(page);
  await expect(panel).toContainText("34/34 örnek geçti");
  await expect(panel.locator(`code[title="${candidateHash}"]`)).toHaveText(candidateHash.slice(0, 12) + "…");
  await expect(panel.locator(`code[title="${patchHash}"]`)).toHaveText(patchHash.slice(0, 12) + "…");
  await expect(panel.locator(`code[aria-label="${patchHash}"]`)).toHaveCount(1);
  const diff = panel.getByTestId("task-run-diff");
  await expect(diff.locator(".task-run-diff-add")).toHaveText(["+  return values.reduce((a, b) => a + b, 0);", "+  // <img src=x onerror=\"window.__pwned = true\">"]);
  await expect(diff.locator(".task-run-diff-del")).toHaveText(["-  return values.reduce((a, b) => a - b, 0);"]);
  await expect(diff.locator(".task-run-diff-hunk")).toHaveText(["@@ -1,4 +1,4 @@"]);
  await expect(diff.locator(".task-run-diff-meta")).toHaveText(["diff --git a/sum.mjs b/sum.mjs", "--- a/sum.mjs", "+++ b/sum.mjs"]);
  await expect(diff.locator(".task-run-diff-context")).toHaveCount(2);
  await expect(diff.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as MockWindow).__pwned)).toBeUndefined();
  await expect(diff).toHaveAttribute("aria-label", "Doğrulanmış diff");
  await expect(panel.getByText("Gözlenen model: gpt-6-luna")).toBeVisible();
  // A finished run can be followed by a new one after approval.
  await approve(panel); await expect(start(panel)).toBeEnabled();
});

test("Diff'i kopyala copies the exact patch and reports clipboard failure honestly", async ({page}) => {
  await freezeClock(page); await mockNative(page, passed); const panel = await open(page);
  await panel.getByRole("button", {name: "Diff'i kopyala", exact: true}).click();
  await expect(panel).toContainText("Diff panoya kopyalandı.");
  expect(await page.evaluate(() => (window as MockWindow).__taskMock.copied)).toBe(patch);
  await page.evaluate(() => { (window as MockWindow).__taskMock.copyFails = true; });
  await panel.getByRole("button", {name: "Diff'i kopyala", exact: true}).click();
  await expect(panel).toContainText("Diff panoya kopyalanamadı.");
});

test("a rejected run shows the verifier summary and no diff or patch hash", async ({page}) => {
  await freezeClock(page); await mockNative(page, rejected); const panel = await open(page);
  await expect(panel).toContainText("reddedildi"); await expect(panel).toContainText("34 örnekli doğrulayıcı adayı reddetti");
  await expect(panel).toContainText("JSON örnekleri: geçti"); await expect(panel).toContainText("seyrek örnekler: kaldı");
  await expect(panel.getByTestId("task-run-diff")).toHaveCount(0);
  await expect(panel.getByRole("button", {name: "Diff'i kopyala", exact: true})).toHaveCount(0);
  await expect(panel.locator("code[title]")).toHaveCount(0);
});

test("needs_review blocks every new start until reviewed", async ({page}) => {
  await freezeClock(page); await mockNative(page, needsReview); const panel = await open(page);
  await expect(panel).toContainText("İnceleme gerekli; yeni görev başlatılmaz.");
  await expect(panel.getByRole("checkbox")).toBeDisabled(); await expect(start(panel)).toBeDisabled();
  await expect(panel.getByTestId("task-run-diff")).toHaveCount(0);
});

test("a durable profile_needs_review refusal points to the Yerel işlem günlüğü panel in both languages and keeps Başlat blocked", async ({page}) => {
  await freezeClock(page);
  await mockNative(page, envelope(operation({revision: 1, phase: "finished", outcome: "needs_review", error_code: "profile_needs_review", cleanup: "unknown", tool_calls: 0, model: {requested: "gpt-6-luna", observed: null}})));
  const panel = await open(page); const result = panel.locator(".task-run-result");
  await expect(result).toContainText("Bu profilde önceki bir işlem kapanmadı veya doğrulanamadı; görev çalıştırılmadı.");
  await expect(result).toContainText("Yerel işlem günlüğü"); await expect(result).not.toContainText("profile_needs_review");
  await expect(panel.getByRole("checkbox")).toBeDisabled(); await expect(start(panel)).toBeDisabled();
  await expect(panel.getByTestId("task-run-diff")).toHaveCount(0);
  // The named panel really exists on this page.
  await expect(page.getByRole("heading", {name: "Yerel işlem günlüğü", exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Change language", exact: true}).click();
  await expect(result).toContainText("An earlier operation on this profile was not closed or could not be verified; the task did not run.");
  await expect(result).toContainText("Local operation journal"); await expect(result).not.toContainText("profile_needs_review");
  await expect(panel.getByRole("button", {name: "Start", exact: true})).toBeDisabled();
  await expect(page.getByRole("heading", {name: "Local operation journal", exact: true})).toBeVisible();
  expect((await calls(page)).some(call => call.command === "local_task_run_start")).toBe(false);
});

test("model_unavailable says the cheap model was unavailable and that nothing fell back (tr and en)", async ({page}) => {
  await mockNative(page, failed("model_unavailable")); const panel = await open(page);
  await expect(panel).toContainText("ucuz model (gpt-6-luna) kullanılamadı"); await expect(panel).toContainText("Ücretli veya varsayılan bir modele geçilmedi");
  await expect(start(panel)).toBeDisabled(); await approve(panel); await expect(start(panel)).toBeEnabled();
  await page.getByRole("button", {name: "Change language", exact: true}).click();
  await expect(panel).toContainText("cheap test model (gpt-6-luna) was unavailable"); await expect(panel).toContainText("Nothing fell back to a paid or default model");
});

for (const code of taskRunErrors.filter(code => code !== "cancelled" && code !== "candidate_rejected")) {
  test(`error ${code} has a readable explanation in both languages`, async ({page}) => {
    await mockNative(page, failed(code)); const panel = await open(page);
    const result = panel.locator(".task-run-result");
    await expect(result).toContainText("Görev tamamlanamadı"); await expect(result.locator("p")).not.toBeEmpty();
    const turkish = await result.locator("p").innerText();
    expect(turkish).not.toContain(code); expect(turkish.length).toBeGreaterThan(15);
    await page.getByRole("button", {name: "Change language", exact: true}).click();
    await expect(result).toContainText("The task could not complete");
    const english = await result.locator("p").innerText();
    expect(english).not.toContain(code); expect(english).not.toBe(turkish);
    if (code === "profile_unbound" || code === "auth_required") { expect(english).toContain("panel above"); expect(turkish).toContain("Yukarıdaki panelden"); }
    if (code === "quota_exhausted") expect(english).toContain("subscription");
  });
}

for (const [name, changes] of [
  ["revision regression", {revision: 2}],
  ["phase regression", {revision: 4, phase: "preparing"}],
  ["tool calls regression", {revision: 4, tool_calls: 2}],
  ["observed model change", {revision: 4, model: {requested: "gpt-6-luna", observed: "gpt-6"}}],
  ["same revision change", {tool_calls: 6}],
  ["provider mismatch", {revision: 4, provider: "claude", model: {requested: "haiku", observed: null}}],
  ["tool calls above the limit", {revision: 4, tool_calls: 17}],
  ["unknown error code", {revision: 4, phase: "finished", outcome: "failed", error_code: "PRIVATE_PROVIDER_DETAIL", cleanup: "verified"}],
  ["private extra field", {revision: 4, token: "PRIVATE_PROVIDER_DETAIL"}],
] as const) {
  test(`invalid or stale status raises an alert, pauses polling and blocks starts: ${name}`, async ({page}) => {
    await freezeClock(page); await mockNative(page, running); const panel = await open(page);
    await expect(panel).toContainText("Araç çağrısı: 5 / 16");
    await setValue(page, envelope({...operation(), ...changes})); await refresh(page);
    await expect(panel.getByRole("alert")).toContainText("doğrulanamadı");
    await expect(panel).not.toContainText("PRIVATE_PROVIDER_DETAIL"); await expect(start(panel)).toBeDisabled();
    const before = (await calls(page)).length; await page.clock.fastForward(10_000);
    expect((await calls(page)).length).toBe(before);
    // A later valid observation of the same request recovers.
    await setValue(page, envelope(operation({revision: 8, tool_calls: 8}))); await refresh(page);
    await expect(panel.getByRole("alert")).toHaveCount(0); await expect(panel).toContainText("Araç çağrısı: 8 / 16");
  });
}

test("native errors and oversized replies hide private details and never use HTTP fallback", async ({page}) => {
  await freezeClock(page); await mockNative(page, running); let fallback = 0;
  await page.route("**/local-task-run**", route => { fallback++; return route.abort(); }); const panel = await open(page);
  await page.evaluate(() => { (window as MockWindow).__taskMock.rejected = true; }); await refresh(page);
  await expect(panel.getByRole("alert")).toBeVisible(); await expect(panel).not.toContainText("PRIVATE_PROVIDER_DETAIL");
  await page.evaluate(() => { (window as MockWindow).__taskMock.rejected = false; });
  await setValue(page, {...running, private_data: "PRIVATE_PROVIDER_DETAIL" + "x".repeat(70_000)}); await refresh(page);
  await expect(panel.getByRole("alert")).toBeVisible(); await expect(panel).not.toContainText("PRIVATE_PROVIDER_DETAIL"); expect(fallback).toBe(0);
});

test("a lost start response blocks duplicates, ignores the late reply and reconciles through native status", async ({page}) => {
  await freezeClock(page); await mockNative(page); const panel = await open(page);
  await page.evaluate(() => { (window as MockWindow).__taskMock.deferStart = true; });
  await approve(panel); await start(panel).click();
  await expect(start(panel)).toBeDisabled(); await page.clock.fastForward(5100); await expect(panel.getByRole("alert")).toBeVisible();
  await expect(start(panel)).toBeDisabled();
  await refresh(page); await expect(panel).toContainText("Görev başlatılıyor");
  await page.evaluate(value => { (window as MockWindow).__taskMock.pending.splice(0).forEach(resolve => resolve(value)); }, empty);
  await expect(panel).toContainText("Görev başlatılıyor");
  expect((await calls(page)).filter(call => call.command === "local_task_run_start")).toHaveLength(1);
});

test("another profile's active run is announced without revealing its details and blocks starting", async ({page}) => {
  await freezeClock(page);
  await mockNative(page, envelope(operation({profile_id: secondId, provider: "claude", model: {requested: "haiku", observed: "claude-haiku-4-5"}, tool_calls: 7})));
  const panel = await open(page);
  await expect(panel).toContainText("Başka bir profilin görevi sürüyor.");
  await expect(panel.locator(".task-run-progress")).toHaveCount(0); await expect(panel).not.toContainText("7 / 16");
  await expect(panel).not.toContainText("claude-haiku-4-5"); await expect(cancel(panel)).toHaveCount(0);
  await expect(panel.getByRole("checkbox")).toBeDisabled(); await expect(start(panel)).toBeDisabled();
});

test("another profile's finished result is not displayed", async ({page}) => {
  await mockNative(page, envelope({...(passed.operation as TaskRunOperation), profile_id: secondId, provider: "claude", model: {requested: "haiku", observed: "claude-haiku-4-5"}}));
  const panel = await open(page);
  await expect(panel.getByTestId("task-run-diff")).toHaveCount(0); await expect(panel).not.toContainText("Görev doğrulandı");
  await approve(panel); await expect(start(panel)).toBeEnabled();
});

test("leaving the page never cancels the native run and returning resumes polling from the current status", async ({page}) => {
  await freezeClock(page); await mockNative(page, running); const panel = await open(page);
  await expect(panel).toContainText("Ajan çalışıyor");
  await page.getByRole("navigation").getByRole("button", {name: /^Çalışma alanı/}).click();
  const before = (await calls(page)).length; await page.clock.fastForward(10_000);
  expect((await calls(page)).length).toBe(before); expect((await calls(page)).some(call => call.command === "local_task_run_cancel")).toBe(false);
  await setValue(page, envelope(operation({revision: 6, phase: "verifying", tool_calls: 7})));
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  await expect(panel).toContainText("Bağımsız doğrulayıcı çalışıyor"); await expect(panel).toContainText("Araç çağrısı: 7 / 16");
  await setValue(page, passed); await page.clock.fastForward(1100); await expect(panel).toContainText("Görev doğrulandı");
  expect((await calls(page)).some(call => call.command === "local_task_run_cancel")).toBe(false);
});

test("switching profiles never cancels the native run", async ({page}) => {
  await freezeClock(page); await mockNative(page, running); const panel = await open(page);
  await expect(panel).toContainText("Ajan çalışıyor");
  await page.locator(".managed-profile-list li").filter({hasText: "Claude profilim"}).getByRole("button", {name: "Bu profili seç", exact: true}).click();
  await expect(panel).toContainText("Başka bir profilin görevi sürüyor.");
  expect((await calls(page)).some(call => call.command === "local_task_run_cancel")).toBe(false);
});

test("observation pauses after the run deadline window and refresh resumes it without cancelling", async ({page}) => {
  await freezeClock(page); await mockNative(page, running); const panel = await open(page);
  await page.clock.fastForward(1_290_000); await expect(panel).not.toContainText("Otomatik güncelleme durdu");
  await page.clock.fastForward(11_000); await expect(panel).toContainText("Otomatik güncelleme durdu");
  const before = (await calls(page)).length; await page.clock.fastForward(10_000);
  expect((await calls(page)).length).toBe(before); expect((await calls(page)).some(call => call.command === "local_task_run_cancel")).toBe(false);
  await expect(panel).toContainText("Ajan çalışıyor");
  await setValue(page, passed); await refresh(page); await expect(panel).toContainText("Görev doğrulandı");
});

async function workspace(page: Page) {
  await page.getByRole("navigation").getByRole("button", {name: /^Çalışma alanı/}).click();
  await expect(page.locator(".task-card").first()).toBeVisible();
}
async function prepareCatalog(page: Page, task: {title: string}, strategy: string) {
  await page.locator(".task-card").filter({hasText: task.title}).click();
  await page.locator("#strategy").selectOption(strategy);
  await page.getByRole("button", {name: "Profil seçimini hazırla", exact: true}).click();
  const selection = page.getByTestId("execution-selection");
  await expect(selection).toHaveAttribute("data-selection-kind", "catalog");
  return selection;
}
const prepareSoftware = (page: Page, strategy = "boundary-first") => prepareCatalog(page, softwareTask, strategy);
const prepareLean = (page: Page, strategy = "induction") => prepareCatalog(page, leanTask, strategy);

test("workspace's explicit controlled entry opens the selected profile and retains the strict native start request", async ({page}) => {
  await freezeClock(page); await mockNative(page); await page.goto("/");
  const entry = page.locator(".local-controlled-task");
  await expect(entry).toContainText("Kontrollü doğrulama görevi: sum.mjs");
  await entry.getByRole("button", {name: "Kontrollü görevi seç", exact: true}).click();
  await expect(page.getByTestId("execution-selection")).toHaveAttribute("data-selection-kind", "controlled");
  const panel = page.locator(".task-run-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  await approve(panel); await start(panel).click();
  const starts = (await calls(page)).filter(call => call.command === "local_task_run_start");
  expect(starts).toHaveLength(1);
  expect(starts[0].args.request).toEqual({schema_version: "1.0", request_id: expect.stringMatching(/^[a-f0-9-]{36}$/), profile_id: profileId, task_id: taskId, strategy_id: null, approved: true});
});

test("catalog preparation captures contract and strategy, blocks execution and explains the boundary in Turkish and English", async ({page}) => {
  await mockNative(page); await page.goto("/");
  let writes = 0;
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/v1/")) writes++; });
  const selection = await prepareLean(page);
  for (const value of [leanTask.title, leanTask.id, leanTask.type, leanTask.kind, String(leanTask.task_version), leanTask.contract_hash, leanTask.workspace.commit, "induction"])
    await expect(selection).toContainText(value);
  await expect(selection).toContainText("Bu katalog görevi henüz çalıştırılamıyor.");
  const panel = page.locator(".task-run-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await expect(panel.locator(".task-run-approval")).toHaveCount(0);
  await expect(start(panel)).toHaveCount(0);
  await page.getByRole("button", {name: "Change language", exact: true}).click();
  await expect(selection).toContainText("This catalog task cannot run yet.");
  await expect(panel.locator(".task-run-approval")).toHaveCount(0);
  await expect(panel.getByRole("button", {name: "Start", exact: true})).toHaveCount(0);
  expect((await calls(page)).some(call => call.command === "local_task_run_start" || call.command === "local_task_run_cancel")).toBe(false);
  expect(writes).toBe(0);
});

test("a prepared catalog snapshot survives navigation, filtering and refresh until another task is explicitly prepared", async ({page}) => {
  await mockNative(page); await page.goto("/");
  const selection = await prepareSoftware(page);
  await workspace(page);
  await page.getByRole("textbox", {name: "Görevlerde ara…"}).fill("Doğal sayılarda");
  await expect(page.locator(".task-card")).toHaveCount(1);
  await page.locator(".catalog-panel").getByRole("button", {name: "Yenile", exact: true}).click();
  await expect(page.locator(".task-card")).toHaveCount(1);
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  await expect(selection).toContainText(softwareTask.title);
  await expect(selection).toContainText(softwareTask.contract_hash);
  await expect(selection).toContainText("boundary-first");
  await workspace(page);
  await page.locator(".task-card").click();
  await page.getByRole("button", {name: "Profil seçimini hazırla", exact: true}).click();
  await expect(selection).toContainText("lean-add-comm");
  await expect(selection).not.toContainText(softwareTask.contract_hash);
  await expect(page.locator(".task-run-panel .task-run-approval")).toHaveCount(0);
  expect((await calls(page)).some(call => call.command === "local_task_run_start")).toBe(false);
});

test("changing the prepared task or selected profile consumes approval and requires an explicit controlled switch", async ({page}) => {
  await mockNative(page); const panel = await open(page);
  await approve(panel); await expect(start(panel)).toBeEnabled();
  await workspace(page); const selection = await prepareLean(page);
  await expect(start(panel)).toHaveCount(0);
  await selection.getByRole("button", {name: "Kontrollü görevi seç", exact: true}).click();
  await expect(selection).toHaveAttribute("data-selection-kind", "controlled");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  await expect(start(panel)).toBeDisabled();
  await approve(panel); await expect(start(panel)).toBeEnabled();
  await page.locator(".managed-profile-list li").filter({hasText: "Claude profilim"}).getByRole("button", {name: "Bu profili seç", exact: true}).click();
  await expect(panel.locator(".task-run-card code")).toHaveText("haiku");
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  await expect(start(panel)).toBeDisabled();
  await approve(panel); await start(panel).click();
  expect((await calls(page)).filter(call => call.command === "local_task_run_start").map(call => call.args.request.profile_id)).toEqual([secondId]);
});

test("catalog selection keeps an active controlled run and its eventual result identified as the actual local task", async ({page}) => {
  await freezeClock(page); await mockNative(page, running); await page.goto("/");
  const selection = await prepareLean(page);
  const panel = page.locator(".task-run-panel");
  await expect(panel).toContainText("Ajan çalışıyor");
  const progress = panel.locator(".task-run-progress");
  await expect(progress).toContainText(taskId);
  await expect(progress).toContainText("sum.mjs");
  await expect(progress).not.toContainText(leanTask.id);
  await expect(start(panel)).toHaveCount(0);
  await expect(cancel(panel)).toBeEnabled();
  await setValue(page, passed); await refresh(page);
  const result = panel.locator(".task-run-result");
  await expect(result).toContainText("Görev doğrulandı");
  await expect(result).toContainText(taskId);
  await expect(result).not.toContainText(leanTask.id);
  await expect(panel.getByTestId("task-run-diff")).toBeVisible();
  await expect(selection).toContainText(leanTask.id);
  await expect(panel.locator(".task-run-approval")).toHaveCount(0);
  expect((await calls(page)).some(call => call.command === "local_task_run_start" || call.command === "local_task_run_cancel")).toBe(false);
});

// Runnable catalog task: software-bounds from a pinned local source bundle.
// Tests marked "(pin)" need the catalog fixture to equal taskRunCatalogPins["software-bounds"].
const softwarePin = taskRunCatalogPins[softwareId]!;
async function mockChangedSoftwareContract(page: Page) {
  const changed: {hash: string | null} = {hash: null};
  await page.route("**/api/v1/tasks**", async route => {
    const response = await route.fetch(), body = await response.json();
    body.items = await Promise.all(body.items.map(async (item: Record<string, any>) => {
      if (item.id !== softwareId) return item;
      const edited = {...item, description: item.description + " (sözleşmesi değişti)"};
      edited.contract_hash = changed.hash = await contractHash(edited as never);
      return edited;
    }));
    await route.fulfill({response, json: body});
  });
  return changed;
}

test("(pin) the catalog fixture's software-bounds contract equals the contract the runner pins", () => {
  expect(softwareTask.task_version).toBe(softwarePin.task_version);
  expect(softwareTask.contract_hash).toBe(softwarePin.contract_hash);
});

test("(pin) software-bounds prepared from the catalog explains the local bundle, needs approval and starts with the strict request", async ({page}) => {
  await freezeClock(page); await mockNative(page); await page.goto("/");
  const selection = await prepareSoftware(page);
  for (const value of [softwareTask.title, softwareTask.id, softwareTask.contract_hash, "boundary-first", "Bu katalog görevi yerelde çalıştırılabilir.",
    "depo klonlanmadan sabitlenmiş yerel bir kaynak paketinden", "Seçtiğin onaylı yaklaşım bu çalıştırmaya uygulanır", "yönergeleri sabitlenmiş sözleşmeden gelir", "yeniden hazırlaman ve onaylaman gerekir"])
    await expect(selection).toContainText(value);
  await expect(selection).not.toContainText("henüz çalıştırılamıyor"); await expect(selection).not.toContainText("henüz uygulanmaz");
  const panel = page.locator(".task-run-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await expect(panel.locator(".task-run-card h4")).toHaveText("Yerel kaynak paketi görevi: src/search.ts");
  await expect(panel.locator(".task-run-card")).toContainText("lowerBound");
  for (const text of ["Görev çalışma alanında ağ erişimi yok", "En fazla 16 araç çağrısı", "Etkin süre sınırı 20 dk (görev 20 dk · tek deneme 30 dk · son 24 saatte kalan 120 dk). Ücretli API kapalı.", "Yalnız src/search.ts değiştirilebilir", "gizli örnekleri geçmeli", "Yalnız doğrulanmış diff gösterilir"])
    await expect(panel.locator(".task-run-card")).toContainText(text);
  await expect(panel.locator(".task-run-card")).not.toContainText("34 örnekli");
  await expect(panel.locator(".task-run-card code")).toHaveText(["boundary-first", "gpt-6-luna"]);
  await expect(panel.getByRole("checkbox")).not.toBeChecked(); await expect(start(panel)).toBeDisabled();
  await approve(panel); await expect(start(panel)).toBeEnabled();
  await page.getByRole("button", {name: "Change language", exact: true}).click();
  await expect(selection).toContainText("This catalog task can run locally.");
  await expect(selection).toContainText("pinned local source bundle without cloning a repository");
  await expect(selection).toContainText("approved strategy you selected is applied to this run; its instructions come from the pinned contract");
  await expect(selection).toContainText("you must prepare and approve the task again");
  await expect(selection).not.toContainText("not applied");
  await expect(panel.locator(".task-run-card h4")).toHaveText("Local source bundle task: src/search.ts");
  await expect(panel.getByRole("checkbox")).toBeChecked();
  await panel.getByRole("button", {name: "Start", exact: true}).click();
  await expect(panel).toContainText("Starting task…");
  const starts = (await calls(page)).filter(call => call.command === "local_task_run_start");
  expect(starts).toHaveLength(1);
  expect(starts[0].args).toEqual({request: {schema_version: "1.0", request_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), profile_id: profileId, task_id: softwareId, strategy_id: "boundary-first", approved: true}});
  expect(Object.keys(starts[0].args.request).sort()).toEqual(["approved", "profile_id", "request_id", "schema_version", "strategy_id", "task_id"]);
  const progress = panel.locator(".task-run-progress");
  await expect(progress).toContainText("Applied strategy: boundary-first"); await expect(progress).toContainText(softwareId); await expect(progress).toContainText("src/search.ts"); await expect(progress).not.toContainText("sum.mjs");
  await expect(panel.getByRole("checkbox")).not.toBeChecked(); await expect(panel.getByRole("button", {name: "Start", exact: true})).toBeDisabled();
});

test("(pin) switching from the prepared software task back to the controlled task consumes approval and changes the start request", async ({page}) => {
  await freezeClock(page); await mockNative(page); await page.goto("/");
  const selection = await prepareSoftware(page);
  const panel = page.locator(".task-run-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await approve(panel); await expect(start(panel)).toBeEnabled();
  await selection.getByRole("button", {name: "Kontrollü görevi seç", exact: true}).click();
  await expect(selection).toHaveAttribute("data-selection-kind", "controlled");
  await expect(panel.getByRole("checkbox")).not.toBeChecked(); await expect(start(panel)).toBeDisabled();
  await approve(panel); await start(panel).click();
  expect((await calls(page)).filter(call => call.command === "local_task_run_start").map(call => [call.args.request.task_id, call.args.request.strategy_id])).toEqual([[taskId, null]]);
});

for (const strategy of ["invariant", "boundary-first"]) {
  test(`(pin) the workspace's ${strategy} strategy is shown on the task card and travels as the only strategy field of the start request`, async ({page}) => {
    await freezeClock(page); await mockNative(page); await page.goto("/");
    const selection = await prepareSoftware(page, strategy);
    await expect(selection).toContainText(strategy);
    const panel = page.locator(".task-run-panel");
    await expect(panel).toHaveAttribute("aria-busy", "false");
    const card = panel.locator(".task-run-card");
    await expect(card).toContainText("Uygulanan yaklaşım"); await expect(card.locator("dd code").first()).toHaveText(strategy);
    await expect(card).toContainText("yönergeleri doğrulanmış görev sözleşmesinden okunur; arayüz yönerge göndermez");
    // The card shows the id only, never the contract's instruction text.
    const instructions = softwareTask.strategies.find((item: {id: string}) => item.id === strategy).instructions as string;
    await expect(card).not.toContainText(instructions);
    await approve(panel); await start(panel).click();
    const starts = (await calls(page)).filter(call => call.command === "local_task_run_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].args.request).toEqual({schema_version: "1.0", request_id: expect.stringMatching(/^[0-9a-f-]{36}$/), profile_id: profileId, task_id: softwareId, strategy_id: strategy, approved: true});
    await expect(panel.locator(".task-run-progress")).toContainText(`Uygulanan yaklaşım: ${strategy}`);
    await page.getByRole("button", {name: "Change language", exact: true}).click();
    await expect(panel.locator(".task-run-progress")).toContainText(`Applied strategy: ${strategy}`);
  });
}

test("(pin) choosing another strategy only counts once it is prepared again: approval is consumed and the start request changes", async ({page}) => {
  await freezeClock(page); await mockNative(page); await page.goto("/");
  const selection = await prepareSoftware(page, "boundary-first");
  const panel = page.locator(".task-run-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await approve(panel); await expect(start(panel)).toBeEnabled();
  // Picking a strategy in the workspace without preparing leaves the prepared snapshot and its approval untouched.
  await workspace(page); await page.locator(".task-card").filter({hasText: softwareTask.title}).click();
  await page.locator("#strategy").selectOption("invariant");
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  await expect(selection).toContainText("boundary-first"); await expect(selection).not.toContainText("invariant");
  // Preparing again with the other strategy consumes the approval.
  await workspace(page); await page.locator(".task-card").filter({hasText: softwareTask.title}).click();
  await page.getByRole("button", {name: "Profil seçimini hazırla", exact: true}).click();
  await expect(selection).toContainText("invariant");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await expect(panel.locator(".task-run-card dd code").first()).toHaveText("invariant");
  await expect(panel.getByRole("checkbox")).not.toBeChecked(); await expect(start(panel)).toBeDisabled();
  await approve(panel); await start(panel).click();
  const starts = (await calls(page)).filter(call => call.command === "local_task_run_start");
  expect(starts.map(call => call.args.request.strategy_id)).toEqual(["invariant"]);
});

test("native operations show their strategy in progress, result and history, and a mismatched strategy is an invalid observation", async ({page}) => {
  await freezeClock(page); await mockNative(page, running); const panel = await open(page);
  await expect(panel.locator(".task-run-progress")).not.toContainText("Uygulanan yaklaşım");
  await setValue(page, passed); await refresh(page);
  await expect(panel.locator(".task-run-result")).not.toContainText("Uygulanan yaklaşım");
  const next = "c0000000-0000-4000-8000-000000000002";
  await setValue(page, envelope(softwareOperation({request_id: next, strategy_id: "boundary-first"}))); await refresh(page);
  await expect(panel.locator(".task-run-progress")).toContainText("Uygulanan yaklaşım: boundary-first");
  await setValue(page, envelope({...(softwarePassed.operation as TaskRunOperation), request_id: next, strategy_id: "boundary-first"})); await refresh(page);
  await expect(panel.locator(".task-run-result")).toContainText("Uygulanan yaklaşım: boundary-first");
  // A strategy that does not belong to the task is not rendered.
  for (const bad of [envelope(operation({strategy_id: "invariant"})), envelope(softwareOperation({strategy_id: null})), envelope(softwareOperation({strategy_id: "invented"}))]) {
    await setValue(page, bad); await refresh(page);
    await expect(panel.getByRole("alert")).toContainText("doğrulanamadı");
  }
});

test("a catalog software task whose contract hash differs from the runner's pin stays unsupported and cannot start", async ({page}) => {
  // Re-hashing the rewritten contract in the browser takes ~16 s on its own.
  test.slow();
  await mockNative(page); const changed = await mockChangedSoftwareContract(page); await page.goto("/");
  const selection = await prepareSoftware(page);
  expect(changed.hash).not.toBeNull(); expect(changed.hash).not.toBe(softwarePin.contract_hash);
  await expect(selection).toContainText(changed.hash!);
  await expect(selection).toContainText("Bu katalog görevi henüz çalıştırılamıyor.");
  await expect(selection).not.toContainText("yerelde çalıştırılabilir");
  const panel = page.locator(".task-run-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await expect(panel.locator(".task-run-approval")).toHaveCount(0); await expect(start(panel)).toHaveCount(0);
  await page.getByRole("button", {name: "Change language", exact: true}).click();
  await expect(selection).toContainText("This catalog task cannot run yet.");
  await expect(panel.getByRole("button", {name: "Start", exact: true})).toHaveCount(0);
  expect((await calls(page)).some(call => call.command === "local_task_run_start")).toBe(false);
});

test("a software run that passed shows the verifier checks, hashes and the src/search.ts diff as plain text lines", async ({page}) => {
  await freezeClock(page); await mockNative(page, softwarePassed); const panel = await open(page);
  const result = panel.locator(".task-run-result");
  await expect(result).toContainText("Görev doğrulandı");
  await expect(result).toContainText(`${softwareId} · src/search.ts`); await expect(result).not.toContainText("sum.mjs");
  await expect(result).toContainText("Uygulanan yaklaşım: invariant");
  await expect(result).toContainText("40/40 örnek geçti"); await expect(result).toContainText("görünür testler: geçti"); await expect(result).toContainText("gizli örnekler: geçti");
  await expect(panel.locator(`code[title="${candidateHash}"]`)).toHaveText(candidateHash.slice(0, 12) + "…");
  await expect(panel.locator(`code[title="${patchHash}"]`)).toHaveText(patchHash.slice(0, 12) + "…");
  const diff = panel.getByTestId("task-run-diff");
  await expect(diff.locator(".task-run-diff-meta")).toHaveText(["diff --git a/src/search.ts b/src/search.ts", "--- a/src/search.ts", "+++ b/src/search.ts"]);
  await expect(diff.locator(".task-run-diff-hunk")).toHaveText(["@@ -2,3 +2,3 @@"]);
  await expect(diff.locator(".task-run-diff-del")).toHaveText(["-  let hi = values.length - 1;"]);
  await expect(diff.locator(".task-run-diff-add")).toHaveText(["+  let hi = values.length;", "+  // <b onmouseover=\"window.__pwned = true\">"]);
  await expect(diff.locator("b")).toHaveCount(0);
  expect(await page.evaluate(() => (window as MockWindow).__pwned)).toBeUndefined();
  await panel.getByRole("button", {name: "Diff'i kopyala", exact: true}).click();
  expect(await page.evaluate(() => (window as MockWindow).__taskMock.copied)).toBe(softwarePatch);
  await page.getByRole("button", {name: "Change language", exact: true}).click();
  await expect(result).toContainText("Applied strategy: invariant"); await expect(result).toContainText("40/40 cases passed"); await expect(result).toContainText("visible tests: passed"); await expect(result).toContainText("hidden cases: passed");
});

for (const [name, visible, hidden, tr, en] of [
  ["hidden cases", true, false, ["görünür testler: geçti", "gizli örnekler: kaldı"], ["visible tests: passed", "hidden cases: failed"]],
  ["visible tests", false, true, ["görünür testler: kaldı", "gizli örnekler: geçti"], ["visible tests: failed", "hidden cases: passed"]],
] as const) {
  test(`a software run rejected by the ${name} names the failed check and shows no diff`, async ({page}) => {
    await freezeClock(page); await mockNative(page, softwareRejected(visible, hidden)); const panel = await open(page);
    const result = panel.locator(".task-run-result");
    await expect(result).toContainText("reddedildi"); await expect(result).toContainText(`${softwareId} · src/search.ts`);
    await expect(result).toContainText("40 örnekli doğrulayıcı adayı reddetti");
    for (const text of tr) await expect(result).toContainText(text);
    await expect(result).not.toContainText("JSON örnekleri"); await expect(result).not.toContainText("seyrek");
    await expect(panel.getByTestId("task-run-diff")).toHaveCount(0);
    await expect(panel.getByRole("button", {name: "Diff'i kopyala", exact: true})).toHaveCount(0);
    await expect(panel.locator("code[title]")).toHaveCount(0);
    await page.getByRole("button", {name: "Change language", exact: true}).click();
    await expect(result).toContainText("The 40-case verifier rejected the candidate");
    for (const text of en) await expect(result).toContainText(text);
  });
}

test("a software result for a mismatched shape is an invalid observation, not a rendered verifier", async ({page}) => {
  await freezeClock(page); await mockNative(page, empty); const panel = await open(page);
  const crossed = envelope(softwareOperation({
    revision: 9, phase: "finished", outcome: "passed", cleanup: "verified", tool_calls: 6,
    result: {verifier: {passed: true, cases: 34, json_cases_passed: true, sparse_cases_passed: true}, candidate_sha256: candidateHash, patch_sha256: patchHash, patch},
  }));
  await setValue(page, crossed); await refresh(page);
  await expect(panel.getByRole("alert")).toContainText("doğrulanamadı");
  await expect(panel.getByTestId("task-run-diff")).toHaveCount(0); await expect(panel).not.toContainText("Görev doğrulandı");
});

test("history mode labels the task that is really running or last ran, not the selected catalog task", async ({page}) => {
  await freezeClock(page); await mockNative(page, envelope(softwareOperation({revision: 4, tool_calls: 3}))); await page.goto("/");
  await prepareLean(page);
  const panel = page.locator(".task-run-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await expect(panel.locator(".task-run-approval")).toHaveCount(0); await expect(start(panel)).toHaveCount(0);
  await expect(panel.getByRole("heading", {level: 3})).toHaveText("Yerel görev durumu");
  const progress = panel.locator(".task-run-progress");
  await expect(progress).toContainText("Çalışan görev"); await expect(progress).toContainText(`${softwareId} · src/search.ts`);
  await expect(progress).not.toContainText("sum.mjs"); await expect(progress).not.toContainText(leanTask.id);
  await expect(progress).toContainText("Uygulanan yaklaşım: invariant");
  await expect(cancel(panel)).toBeEnabled();
  await setValue(page, softwarePassed); await refresh(page);
  const result = panel.locator(".task-run-result");
  await expect(result).toContainText("Son görev"); await expect(result).toContainText(`${softwareId} · src/search.ts`);
  await expect(result).not.toContainText(leanTask.id);
  await expect(panel.getByTestId("task-run-diff").locator(".task-run-diff-meta").first()).toHaveText("diff --git a/src/search.ts b/src/search.ts");
  await setValue(page, envelope({...(passed.operation as TaskRunOperation), request_id: "c0000000-0000-4000-8000-000000000002"})); await refresh(page);
  await expect(result).toContainText(`${taskId} · sum.mjs`); await expect(result).not.toContainText("src/search.ts");
  await expect(result).not.toContainText("Uygulanan yaklaşım");
  await expect(result).toContainText("34/34 örnek geçti"); await expect(result).toContainText("JSON örnekleri: geçti");
  await expect(panel.getByTestId("task-run-diff").locator(".task-run-diff-meta").first()).toHaveText("diff --git a/sum.mjs b/sum.mjs");
});

// Second runnable catalog task: software-intervals (same flow, own card, strategies and diff path).
const intervalsId = "software-intervals";
const intervalsTask = catalogFixture.tasks.find((task: {id: string}) => task.id === intervalsId);
const intervalsPin = taskRunCatalogPins[intervalsId]!;
const intervalsPatch = [
  "diff --git a/src/intervals.ts b/src/intervals.ts", "--- a/src/intervals.ts", "+++ b/src/intervals.ts", "@@ -4,3 +4,3 @@", " export function mergeIntervals(intervals: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {",
  "-  const sorted = intervals as Array<[number, number]>;", "+  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);", "+  // <b onmouseover=\"window.__pwned = true\">", " }", "",
].join("\n");
const intervalsOperation = (changes: Partial<TaskRunOperation> = {}) => operation({task_id: intervalsId, strategy_id: "sort-first", ...changes});
const intervalsPassed = envelope(intervalsOperation({
  revision: 9, phase: "finished", outcome: "passed", cleanup: "verified", tool_calls: 5,
  result: {verifier: {passed: true, cases: 40, visible_tests_passed: true, hidden_cases_passed: true}, candidate_sha256: candidateHash, patch_sha256: patchHash, patch: intervalsPatch},
}));

test("(pin) the catalog fixture's software-intervals contract equals the contract the runner pins and differs from software-bounds", () => {
  expect(intervalsTask).toBeDefined();
  expect(intervalsTask.task_version).toBe(intervalsPin.task_version);
  expect(intervalsTask.contract_hash).toBe(intervalsPin.contract_hash);
  expect(intervalsTask.contract_hash).not.toBe(softwareTask.contract_hash);
  expect(intervalsTask.strategies.map((item: {id: string}) => item.id)).toEqual(["sort-first", "sweep"]);
});

for (const strategy of ["sort-first", "sweep"]) {
  test(`(pin) software-intervals prepared from the catalog with ${strategy} explains the local bundle, needs approval and starts with the strict request`, async ({page}) => {
    await freezeClock(page); await mockNative(page); await page.goto("/");
    await expect(page.locator(".task-card")).toHaveCount(catalogFixture.tasks.length);
    const selection = await prepareCatalog(page, intervalsTask, strategy);
    for (const value of [intervalsTask.title, intervalsTask.id, intervalsTask.contract_hash, strategy, "Bu katalog görevi yerelde çalıştırılabilir.", "depo klonlanmadan sabitlenmiş yerel bir kaynak paketinden"])
      await expect(selection).toContainText(value);
    await expect(selection).not.toContainText("henüz çalıştırılamıyor");
    const panel = page.locator(".task-run-panel");
    await expect(panel).toHaveAttribute("aria-busy", "false");
    const card = panel.locator(".task-run-card");
    await expect(card.locator("h4")).toHaveText("Yerel kaynak paketi görevi: src/intervals.ts");
    await expect(card).toContainText("mergeIntervals"); await expect(card).toContainText("Yalnız src/intervals.ts değiştirilebilir");
    await expect(card).not.toContainText("lowerBound"); await expect(card).not.toContainText("src/search.ts"); await expect(card).not.toContainText("34 örnekli");
    await expect(card.locator("code")).toHaveText([strategy, "gpt-6-luna"]);
    // The card shows the id only, never the contract's instruction text.
    await expect(card).not.toContainText(intervalsTask.strategies.find((item: {id: string}) => item.id === strategy).instructions as string);
    await expect(panel.getByRole("checkbox")).not.toBeChecked(); await expect(start(panel)).toBeDisabled();
    await approve(panel); await expect(start(panel)).toBeEnabled();
    await page.getByRole("button", {name: "Change language", exact: true}).click();
    await expect(selection).toContainText("This catalog task can run locally.");
    await expect(card.locator("h4")).toHaveText("Local source bundle task: src/intervals.ts");
    await panel.getByRole("button", {name: "Start", exact: true}).click();
    const starts = (await calls(page)).filter(call => call.command === "local_task_run_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].args).toEqual({request: {schema_version: "1.0", request_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), profile_id: profileId, task_id: intervalsId, strategy_id: strategy, approved: true}});
    expect(Object.keys(starts[0].args.request).sort()).toEqual(["approved", "profile_id", "request_id", "schema_version", "strategy_id", "task_id"]);
    const progress = panel.locator(".task-run-progress");
    await expect(progress).toContainText(`Applied strategy: ${strategy}`); await expect(progress).toContainText(intervalsId); await expect(progress).toContainText("src/intervals.ts");
    await expect(progress).not.toContainText("src/search.ts"); await expect(progress).not.toContainText("sum.mjs");
  });
}

test("a software-intervals run that passed shows the verifier checks, hashes and the src/intervals.ts diff as plain text lines", async ({page}) => {
  await freezeClock(page); await mockNative(page, intervalsPassed); const panel = await open(page);
  const result = panel.locator(".task-run-result");
  await expect(result).toContainText("Görev doğrulandı");
  await expect(result).toContainText(`${intervalsId} · src/intervals.ts`); await expect(result).not.toContainText("sum.mjs"); await expect(result).not.toContainText("src/search.ts");
  await expect(result).toContainText("Uygulanan yaklaşım: sort-first");
  await expect(result).toContainText("40/40 örnek geçti"); await expect(result).toContainText("görünür testler: geçti"); await expect(result).toContainText("gizli örnekler: geçti");
  const diff = panel.getByTestId("task-run-diff");
  await expect(diff.locator(".task-run-diff-meta")).toHaveText(["diff --git a/src/intervals.ts b/src/intervals.ts", "--- a/src/intervals.ts", "+++ b/src/intervals.ts"]);
  await expect(diff.locator(".task-run-diff-add")).toHaveText(["+  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);", "+  // <b onmouseover=\"window.__pwned = true\">"]);
  await expect(diff.locator("b")).toHaveCount(0);
  expect(await page.evaluate(() => (window as MockWindow).__pwned)).toBeUndefined();
  await panel.getByRole("button", {name: "Diff'i kopyala", exact: true}).click();
  expect(await page.evaluate(() => (window as MockWindow).__taskMock.copied)).toBe(intervalsPatch);
  await page.getByRole("button", {name: "Change language", exact: true}).click();
  await expect(result).toContainText("Task verified"); await expect(result).toContainText("Applied strategy: sort-first"); await expect(result).toContainText("visible tests: passed");
});

test("a software-intervals patch for the wrong file or another task's strategy is an invalid observation", async ({page}) => {
  await freezeClock(page); await mockNative(page, intervalsPassed); const panel = await open(page);
  await expect(panel.locator(".task-run-result")).toContainText(`${intervalsId} · src/intervals.ts`);
  const wrongFile = envelope({...(intervalsPassed.operation as TaskRunOperation), result: {...(intervalsPassed.operation as TaskRunOperation).result!, patch: softwarePatch}});
  const wrongStrategy = envelope({...(intervalsPassed.operation as TaskRunOperation), request_id: "c0000000-0000-4000-8000-000000000002", strategy_id: "invariant"});
  for (const bad of [wrongFile, wrongStrategy]) {
    await setValue(page, bad); await refresh(page);
    await expect(panel.getByRole("alert")).toContainText("Görev durumu doğrulanamadı");
    await expect(panel.getByTestId("task-run-diff")).not.toContainText("src/search.ts");
  }
});

// Native-owned local run limits (ADR 0024): wall time only, enforced natively.
const settingsButton = (page: Page) => page.getByRole("button", {name: "Katkı ayarları", exact: true});

test("the effective local limit is shown before Başlat and replaces the fixed 20 minute line", async ({page}) => {
  await mockNative(page, empty, profiles, {attempt_sec: 600, daily_sec: 1500, used_sec: 600});
  const panel = await open(page);
  const line = panel.getByTestId("run-limits-effective");
  await expect(line).toHaveText("Etkin süre sınırı 10 dk (görev 20 dk · tek deneme 10 dk · son 24 saatte kalan 15 dk). Ücretli API kapalı.");
  await expect(panel).not.toContainText("20 dakika süre sınırı");
  await expect(panel.getByTestId("run-limits-blocked")).toHaveCount(0);
  await approve(panel); await expect(start(panel)).toBeEnabled();
  const read = await limitCalls(page);
  expect(read.length).toBeGreaterThan(0);
  expect(read.every(call => call.command === "local_run_limits_status" && JSON.stringify(call.args) === "{}")).toBe(true);
  await page.getByRole("button", {name: "Change language", exact: true}).click();
  await expect(line).toHaveText("Effective time limit 10 min (task 20 min · per attempt 10 min · remaining in the last 24 hours 15 min). Paid API is off.");
});

test("an exhausted local budget disables Başlat with the explanation and never reaches the native start", async ({page}) => {
  await mockNative(page, empty, profiles, {used_sec: 7200});
  const panel = await open(page);
  await expect(panel.getByTestId("run-limits-blocked")).toContainText("Son 24 saatteki yerel çalışma süresi doldu. Ayarlardan artırabilir veya bekleyebilirsin");
  await expect(panel.getByTestId("run-limits-effective")).toContainText("Etkin süre sınırı 0 dk");
  await expect(panel.getByRole("checkbox")).toBeDisabled(); await expect(start(panel)).toBeDisabled();
  await start(panel).click({force: true});
  expect((await calls(page)).some(call => call.command === "local_task_run_start")).toBe(false);
});

test("a run that finished with local_budget_exhausted or local_budget_unavailable explains it", async ({page}) => {
  await mockNative(page, failed("local_budget_exhausted")); const panel = await open(page);
  const result = panel.locator(".task-run-result");
  await expect(result).toContainText("Görev tamamlanamadı");
  await expect(result).toContainText("Son 24 saatteki yerel çalışma süresi doldu");
  await setValue(page, envelope(operation({request_id: "c0000000-0000-4000-8000-000000000002", revision: 10, phase: "finished", outcome: "failed", error_code: "local_budget_unavailable", cleanup: "verified", tool_calls: 0, model: {requested: "gpt-6-luna", observed: null}})));
  await refresh(page);
  await expect(result).toContainText("Yerel süre sınırı kaydı okunamadı. Ayarları yeniden kaydet");
  await page.getByRole("button", {name: "Change language", exact: true}).click();
  await expect(result).toContainText("The local time-limit record could not be read");
});

test("the limits are read again after a run finishes", async ({page}) => {
  await mockNative(page, running); const panel = await open(page);
  const before = (await limitCalls(page)).length;
  await page.evaluate(() => { (window as MockWindow).__taskMock.limits.used_sec = 1200; });
  await setValue(page, passed); await refresh(page);
  await expect(panel.locator(".task-run-result")).toContainText("Görev doğrulandı");
  await expect(panel.getByTestId("run-limits-effective")).toContainText("son 24 saatte kalan 100 dk");
  expect((await limitCalls(page)).length).toBeGreaterThan(before);
});

test("an unreadable native limits record is reported but native still decides", async ({page}) => {
  await mockNative(page);
  await page.addInitScript(() => {
    const target = window as MockWindow, invoke = target.__TAURI_INTERNALS__.invoke;
    target.__TAURI_INTERNALS__.invoke = (command, args) => command === "local_run_limits_status" ? Promise.reject(new Error("PRIVATE_NATIVE_DETAIL")) : invoke(command, args);
  });
  const panel = await open(page);
  await expect(panel.getByTestId("run-limits-unreadable")).toContainText("Yerel süre sınırı kaydı okunamadı");
  await expect(panel).toContainText("20 dakika süre sınırı");
  await expect(panel).not.toContainText("PRIVATE_NATIVE_DETAIL");
  await approve(panel); await expect(start(panel)).toBeEnabled();
});

test("saving the settings in the desktop app also saves the limits natively in seconds", async ({page}) => {
  await mockNative(page); await page.goto("/");
  await settingsButton(page).click();
  await expect(page.getByLabel("Tek deneme (dakika)")).toHaveValue("30");
  await expect(page.getByLabel("Günlük aktif süre (dakika)")).toHaveValue("120");
  await expect(page.getByLabel("Eşzamanlı deneme")).toBeDisabled(); await expect(page.getByLabel("Eşzamanlı deneme")).toHaveValue("1");
  await expect(page.getByTestId("concurrency-fixed")).toContainText("sabittir");
  await expect(page.getByTestId("run-limits-usage")).toContainText("Son 24 saatte kullanılan yerel çalışma süresi: 0 dk · kalan: 120 dk");
  await expect(page.getByTestId("run-limits-usage")).toContainText("token veya abonelik kullanımı değildir");
  await page.getByLabel("Tek deneme (dakika)").fill("15"); await page.getByLabel("Günlük aktif süre (dakika)").fill("90");
  await page.getByRole("button", {name: "Tercihleri kaydet"}).click();
  await expect(page.getByRole("status")).toContainText("kaydedildi");
  const saves = (await limitCalls(page)).filter(call => call.command === "local_run_limits_save");
  expect(saves).toHaveLength(1);
  expect(saves[0].args).toEqual({request: {schema_version: "1.0", attempt_sec: 900, daily_sec: 5400}});
  await expect(page.getByTestId("run-limits-usage")).toContainText("kalan: 90 dk");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("commongrid.settings.v1")!))).toMatchObject({taskMinutes: 15, dailyMinutes: 90, concurrency: 1});
});

test("a native save failure is reported and the stored preferences stay as they were", async ({page}) => {
  await mockNative(page); await page.goto("/");
  await settingsButton(page).click();
  await page.evaluate(() => { (window as MockWindow).__taskMock.limitsSaveFails = true; });
  await page.getByLabel("Tek deneme (dakika)").fill("15");
  await page.getByRole("button", {name: "Tercihleri kaydet"}).click();
  await expect(page.getByRole("status")).toContainText("Yerel süre sınırı kaydedilemedi");
  await expect(page.locator("body")).not.toContainText("PRIVATE_NATIVE_DETAIL");
  expect(await page.evaluate(() => localStorage.getItem("commongrid.settings.v1"))).toBeNull();
});

test("the native limits win over a drifted browser copy of the settings", async ({page}) => {
  await page.addInitScript(() => localStorage.setItem("commongrid.settings.v1", JSON.stringify({language: "tr", cpu: 2, memoryMb: 4096, taskMinutes: 50, dailyMinutes: 400, concurrency: 3})));
  await mockNative(page, empty, profiles, {attempt_sec: 600, daily_sec: 3600}); await page.goto("/");
  await settingsButton(page).click();
  await expect(page.getByLabel("Tek deneme (dakika)")).toHaveValue("10");
  await expect(page.getByLabel("Günlük aktif süre (dakika)")).toHaveValue("60");
  await expect(page.getByLabel("Eşzamanlı deneme")).toHaveValue("1");
});

test("the native effective maximum caps the workspace time limit", async ({page}) => {
  await mockNative(page, empty, profiles, {attempt_sec: 300, daily_sec: 3600}); await page.goto("/");
  await page.locator(".task-card").first().click();
  await expect(page.locator(".resource-grid span").filter({hasText: "SÜRE LİMİTİ"})).toContainText(/5\s*dk/i);
});
