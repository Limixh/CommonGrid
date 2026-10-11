import { test, expect, type Page } from "@playwright/test";
import type { ManagedProfilesStatus } from "../../packages/agent-adapters/src/managed-profile-protocol";
import { taskRunErrors, type TaskRunOperation, type TaskRunStatus } from "../../packages/agent-adapters/src/task-run-protocol";

const profileId = "a0000000-0000-4000-8000-000000000001";
const secondId = "a0000000-0000-4000-8000-000000000002";
const runId = "c0000000-0000-4000-8000-000000000001";
const taskId = "controlled-sum-integers-v1";
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
  request_id: runId, profile_id: profileId, provider: "codex", task_id: taskId, revision: 3, phase: "running", outcome: null, error_code: null,
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
const failed = (error_code: string) => envelope(operation({revision: 9, phase: "finished", outcome: "failed", error_code: error_code as never, cleanup: "verified", tool_calls: 0, model: {requested: "gpt-6-luna", observed: null}}));
const needsReview = envelope(operation({revision: 9, phase: "finished", outcome: "needs_review", error_code: "cleanup_failed", cleanup: "unknown"}));

type Call = {command: string; args: any};
type Mock = {
  profiles: ManagedProfilesStatus; value: unknown; calls: Call[]; rejected: boolean; pending: ((value: unknown) => void)[];
  deferStart: boolean; cancelConflictValue: unknown | null; copied: string | null; copyFails: boolean;
};
type MockWindow = Window & {isTauri: boolean; __taskMock: Mock; __pwned?: boolean; __TAURI_INTERNALS__: {invoke: (command: string, args: any) => Promise<unknown>}};
async function freezeClock(page: Page) {
  const time = new Date("2026-10-11T12:00:00Z");
  await page.clock.install({time}); await page.clock.pauseAt(new Date(time.getTime() + 1000));
}
async function mockNative(page: Page, value: unknown = empty, profileState = profiles) {
  await page.addInitScript(({value, profiles}) => {
    const target = window as MockWindow; target.isTauri = true;
    target.__taskMock = {value, profiles, calls: [], rejected: false, pending: [], deferStart: false, cancelConflictValue: null, copied: null, copyFails: false};
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
      if (!command.startsWith("local_task_run_")) return Promise.reject(new Error("unexpected_fixture_command"));
      mock.calls.push({command, args});
      if (mock.rejected) return Promise.reject(new Error("PRIVATE_PROVIDER_DETAIL"));
      if (command === "local_task_run_start") {
        const request = args.request;
        const profile = mock.profiles.profiles.find(profile => profile.profile_id === request.profile_id)!;
        mock.value = {schema_version: "1.0", availability: "available", operation: {
          request_id: request.request_id, profile_id: request.profile_id, provider: profile.provider, task_id: request.task_id, revision: 0,
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
  }, {value, profiles: profileState});
}
async function open(page: Page) {
  await page.goto("/"); await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  const panel = page.locator(".task-run-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  return panel;
}
async function setValue(page: Page, value: unknown) { await page.evaluate(value => { (window as MockWindow).__taskMock.value = value; }, value); }
async function refresh(page: Page) { await page.getByRole("button", {name: "Görev durumunu yenile", exact: true}).click(); }
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
  for (const text of ["Görev çalışma alanında ağ erişimi yok", "En fazla 16 araç çağrısı", "20 dakika süre sınırı", "34 örnekli bağımsız doğrulayıcı", "Yalnız doğrulanmış diff gösterilir", "kendi Claude veya Codex aboneliğinin kotasını"])
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
  expect(starts[0].args).toEqual({request: {schema_version: "1.0", request_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), profile_id: profileId, task_id: taskId, approved: true}});
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
  await expect(panel).toContainText("inceleme gerekli");
  await expect(panel.getByRole("checkbox")).toBeDisabled(); await expect(start(panel)).toBeDisabled();
  await expect(panel.getByTestId("task-run-diff")).toHaveCount(0);
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
