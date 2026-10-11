import { test, expect, type Page } from "@playwright/test";
import type { ManagedProfilesStatus } from "../../packages/agent-adapters/src/managed-profile-protocol";
import type { ProfileSessionOperation, ProfileSessionStatus } from "../../packages/agent-adapters/src/profile-session-protocol";

const profileId = "a0000000-0000-4000-8000-000000000001";
const secondId = "a0000000-0000-4000-8000-000000000002";
const requestId = "b0000000-0000-4000-8000-000000000001";
const empty: ProfileSessionStatus = {schema_version: "1.0", availability: "available", operation: null};
const profiles: ManagedProfilesStatus = {
  schema_version: "1.0", availability: "available", revision: 1, selected_profile_id: profileId,
  profiles: [{profile_id: profileId, provider: "codex", name: "Codex profilim"}, {profile_id: secondId, provider: "claude", name: "Claude profilim"}],
};
const waiting: ProfileSessionOperation = {
  request_id: requestId, profile_id: profileId, provider: "codex", action: "login", revision: 3,
  phase: "waiting_for_login", outcome: null, session_state: "unknown", error_code: null, cleanup: "pending",
  challenge: {verification_url: "https://auth.openai.com/codex/device", user_code: "TEST-1234"},
};
const envelope = (operation: unknown) => ({...empty, operation});
type Call = {command: string; args: any};
type Mock = {
  profiles: ManagedProfilesStatus; value: unknown; calls: Call[]; rejected: boolean;
  deferredRead: number; deferStart: boolean; deferCancel: boolean; pending: ((value: unknown) => void)[];
  openResult: unknown; cancelConflictValue: unknown | null;
};
type MockWindow = Window & {isTauri: boolean; __sessionMock: Mock; __TAURI_INTERNALS__: {invoke: (command: string, args: any) => Promise<unknown>}};
async function freezeClock(page: Page) {
  const time = new Date("2026-10-11T12:00:00Z");
  await page.clock.install({time}); await page.clock.pauseAt(new Date(time.getTime() + 1000));
}
async function mockNative(page: Page, value: unknown = empty, profileState = profiles) {
  await page.addInitScript(({value, profiles}) => {
    const target = window as MockWindow; target.isTauri = true;
    target.__sessionMock = {value, profiles, calls: [], rejected: false, deferredRead: 0, deferStart: false, deferCancel: false, pending: [], openResult: true, cancelConflictValue: null};
    target.__TAURI_INTERNALS__ = {invoke: (command, args) => {
      const mock = target.__sessionMock;
      if (command === "local_managed_profiles_status") return Promise.resolve(mock.profiles);
      if (command === "local_managed_profile_select") {
        mock.profiles = {...mock.profiles, revision: mock.profiles.revision + 1, selected_profile_id: args.request.profile_id};
        return Promise.resolve(mock.profiles);
      }
      if (command === "local_cli_check_status") return Promise.resolve({schema_version: "1.0", availability: "available", operation: null});
      if (command === "local_operation_status") return Promise.resolve({status: "unavailable", reason: "operation_journal_missing", execution_enabled: false, automatic_recovery: false, worker_quiescence: "unknown", daemon_state: "unknown", operations: []});
      if (!command.startsWith("local_profile_session_")) return Promise.reject(new Error("unexpected_fixture_command"));
      mock.calls.push({command, args});
      if (mock.rejected) return Promise.reject(new Error("PRIVATE_AUTH_DETAIL"));
      if (command === "local_profile_session_open_device") return Promise.resolve(mock.openResult);
      if (command === "local_profile_session_start") {
        const request = args.request;
        const profile = mock.profiles.profiles.find(profile => profile.profile_id === request.profile_id)!;
        const login = request.action === "login";
        mock.value = {schema_version: "1.0", availability: "available", operation: {
          request_id: request.request_id, profile_id: request.profile_id, provider: profile.provider, action: request.action, revision: 0,
          phase: login ? "waiting_for_login" : "checking", outcome: null, session_state: "unknown", error_code: null, cleanup: "pending",
          challenge: login ? {verification_url: "https://auth.openai.com/codex/device", user_code: "TEST-1234"} : null,
        }};
        if (mock.deferStart) return new Promise(resolve => mock.pending.push(resolve));
      }
      if (command === "local_profile_session_cancel") {
        if (mock.cancelConflictValue !== null) {
          mock.value = mock.cancelConflictValue; mock.cancelConflictValue = null;
          return Promise.reject(new Error("PRIVATE_REVISION_CONFLICT"));
        }
        const state = mock.value as ProfileSessionStatus;
        mock.value = {...state, operation: {...state.operation!, revision: args.request.expected_revision + 1, phase: "finished", outcome: "cancelled", session_state: "unknown", challenge: null, error_code: "cancelled", cleanup: "verified"}};
        if (mock.deferCancel) return new Promise(resolve => mock.pending.push(resolve));
      }
      if (command === "local_profile_session_status" && mock.deferredRead-- > 0) return new Promise(resolve => mock.pending.push(resolve));
      return Promise.resolve(mock.value);
    }};
  }, {value, profiles: profileState});
}
async function open(page: Page) {
  await page.goto("/"); await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  return page.locator(".profile-session-panel");
}
async function setValue(page: Page, value: unknown) { await page.evaluate(value => { (window as MockWindow).__sessionMock.value = value; }, value); }
async function refresh(page: Page) { await page.getByRole("button", {name: "Bağlantı durumunu yenile", exact: true}).click(); }
async function calls(page: Page) { return page.evaluate(() => (window as MockWindow).__sessionMock.calls); }

test("profile selection is not authentication and Codex login sends only native profile identity", async ({page}) => {
  await freezeClock(page); await mockNative(page); const panel = await open(page);
  await expect(panel).toContainText("CLI hesabı henüz doğrulanmadı");
  await panel.getByRole("button", {name: "Codex hesabını bağla", exact: true}).click();
  await expect(panel.getByTestId("profile-session-code")).toHaveText("TEST-1234");
  await expect(panel.getByRole("button", {name: "CLI hesabını kontrol et", exact: true})).toBeDisabled();
  const starts = (await calls(page)).filter(call => call.command === "local_profile_session_start");
  expect(starts).toHaveLength(1);
  expect(starts[0].args).toEqual({request: {schema_version: "1.0", request_id: expect.stringMatching(/^[a-f0-9-]{36}$/), profile_id: profileId, action: "login"}});
  expect((await calls(page)).filter(call => call.command === "local_profile_session_status").every(call => JSON.stringify(call.args) === "{}")).toBe(true);
  await panel.getByRole("button", {name: "Codex giriş sayfasını aç", exact: true}).click();
  expect((await calls(page)).filter(call => call.command === "local_profile_session_open_device")).toEqual([{command: "local_profile_session_open_device", args: {}}]);
  const request = starts[0].args.request;
  await setValue(page, envelope({...waiting, request_id: request.request_id, revision: 4, phase: "finished", outcome: "passed", session_state: "authenticated", challenge: null, cleanup: "verified"}));
  await page.clock.fastForward(1100);
  await expect(panel).toContainText("CLI hesabı bağlı."); await expect(panel.getByTestId("profile-session-code")).toHaveCount(0);
});

test("cancel clears the code immediately, targets the observed revision, and suppresses late reads", async ({page}) => {
  await freezeClock(page); await mockNative(page, envelope(waiting)); const panel = await open(page);
  await expect(panel.getByTestId("profile-session-code")).toBeVisible();
  await page.evaluate(() => { (window as MockWindow).__sessionMock.deferredRead = 1; });
  await refresh(page); await expect(panel).toHaveAttribute("aria-busy", "true");
  await page.evaluate(() => { (window as MockWindow).__sessionMock.deferCancel = true; });
  await panel.getByRole("button", {name: "Bağlantı işlemini iptal et", exact: true}).click();
  await expect(panel.getByTestId("profile-session-code")).toHaveCount(0);
  expect((await calls(page)).filter(call => call.command === "local_profile_session_cancel")).toEqual([{command: "local_profile_session_cancel", args: {request: {schema_version: "1.0", request_id: requestId, expected_revision: 3}}}]);
  await page.evaluate(value => { (window as MockWindow).__sessionMock.pending.splice(0).forEach(resolve => resolve(value)); }, envelope(waiting));
  await expect(panel).toHaveAttribute("aria-busy", "false"); await expect(panel.getByTestId("profile-session-code")).toHaveCount(0);
  await setValue(page, envelope({...waiting, revision: 4})); await refresh(page);
  await expect(panel.getByTestId("profile-session-code")).toHaveCount(0);
});

test("another profile's running login blocks actions without revealing its device code", async ({page}) => {
  await freezeClock(page); await mockNative(page, envelope({...waiting, profile_id: secondId})); const panel = await open(page);
  await expect(panel).toContainText("Başka bir profilin bağlantı işlemi sürüyor");
  await expect(panel.getByTestId("profile-session-code")).toHaveCount(0);
  await expect(panel.getByRole("button", {name: "Codex hesabını bağla", exact: true})).toBeDisabled();
  await expect(panel.getByRole("button", {name: "CLI hesabını kontrol et", exact: true})).toBeDisabled();
  await expect(panel.getByRole("button", {name: "CLI hesabından çıkış yap", exact: true})).toBeDisabled();
  await expect(panel.getByRole("button", {name: "Bağlantı işlemini iptal et", exact: true})).toHaveCount(0);
});

test("Claude login remains terminal-only and unsupported terminal status stays honest", async ({page}) => {
  await mockNative(page, envelope({...waiting, profile_id: secondId, provider: "claude", action: "login", revision: 4, phase: "finished", outcome: "failed", challenge: null, error_code: "unsupported", cleanup: "verified"}), {...profiles, selected_profile_id: secondId});
  const panel = await open(page);
  await expect(panel).toContainText("etkileşimli terminal gerektirir");
  await expect(panel).toContainText("CLI hesabı henüz doğrulanmadı"); await expect(panel).toContainText("henüz desteklenmiyor");
  await expect(panel.getByRole("button", {name: "Codex hesabını bağla", exact: true})).toHaveCount(0);
  await expect(panel.getByTestId("profile-session-code")).toHaveCount(0);
});

for (const action of ["status", "logout"] as const) {
  test(`${action} uses the selected profile and observes unauthenticated only after verified completion`, async ({page}) => {
    await freezeClock(page); await mockNative(page); const panel = await open(page);
    await panel.getByRole("button", {name: action === "status" ? "CLI hesabını kontrol et" : "CLI hesabından çıkış yap", exact: true}).click();
    await expect(panel).toContainText("CLI hesap işlemi sürüyor");
    const starts = (await calls(page)).filter(call => call.command === "local_profile_session_start");
    expect(starts).toHaveLength(1); expect(starts[0].args.request).toMatchObject({profile_id: profileId, action});
    await setValue(page, envelope({...waiting, request_id: starts[0].args.request.request_id, action, revision: 4, phase: "finished", outcome: "passed", session_state: "unauthenticated", challenge: null, cleanup: "verified"}));
    await page.clock.fastForward(1100); await expect(panel).toContainText("CLI hesabı bağlı değil.");
  });
}

test("a delayed logout start hides the prior authenticated state until verified completion", async ({page}) => {
  await freezeClock(page);
  await mockNative(page, envelope({...waiting, revision: 4, phase: "finished", outcome: "passed", session_state: "authenticated", challenge: null, cleanup: "verified"}));
  const panel = await open(page);
  await expect(panel.getByText("CLI hesabı bağlı.", {exact: true})).toBeVisible();
  await page.evaluate(() => { (window as MockWindow).__sessionMock.deferStart = true; });
  await panel.getByRole("button", {name: "CLI hesabından çıkış yap", exact: true}).click();
  await expect(panel).toContainText("İstek gönderiliyor");
  await expect(panel.getByText("CLI hesabı henüz doğrulanmadı.", {exact: true})).toBeVisible();
  await expect(panel.getByText("CLI hesabı bağlı.", {exact: true})).toHaveCount(0);
  await expect(panel.getByText("CLI hesabı bağlı değil.", {exact: true})).toHaveCount(0);
  const start = (await calls(page)).find(call => call.command === "local_profile_session_start")!;
  await page.evaluate(value => {
    const mock = (window as MockWindow).__sessionMock;
    mock.value = value; mock.pending.splice(0).forEach(resolve => resolve(value));
  }, envelope({...waiting, request_id: start.args.request.request_id, action: "logout", revision: 1, phase: "finished", outcome: "passed", session_state: "unauthenticated", challenge: null, cleanup: "verified"}));
  await expect(panel.getByText("CLI hesabı bağlı değil.", {exact: true})).toBeVisible();
  await expect(panel.getByText("CLI hesabı henüz doğrulanmadı.", {exact: true})).toHaveCount(0);
});

for (const [name, changes] of [
  ["revision regression", {revision: 2}],
  ["phase regression", {revision: 4, phase: "preparing", challenge: null}],
  ["same revision code replacement", {challenge: {...waiting.challenge, user_code: "TEST-5678"}}],
  ["same revision code removal", {challenge: null}],
  ["unsafe URL", {revision: 4, challenge: {...waiting.challenge, verification_url: "https://invalid.example/device"}}],
  ["invalid code", {revision: 4, challenge: {...waiting.challenge, user_code: "PRIVATE_AUTH_DETAIL<script>"}}],
  ["private extra field", {revision: 4, token: "PRIVATE_AUTH_DETAIL"}],
  ["provider mismatch", {revision: 4, provider: "claude", phase: "checking", challenge: null}],
  ["unknown error", {revision: 4, phase: "finished", outcome: "failed", error_code: "PRIVATE_AUTH_DETAIL", challenge: null, cleanup: "verified"}],
] as const) {
  test(`invalid update hides the code and blocks mutations: ${name}`, async ({page}) => {
    await freezeClock(page); await mockNative(page, envelope(waiting)); const panel = await open(page);
    await expect(panel.getByTestId("profile-session-code")).toBeVisible();
    await setValue(page, envelope({...waiting, ...changes})); await refresh(page);
    await expect(panel.getByRole("alert")).toContainText("doğrulanamadı"); await expect(panel.getByTestId("profile-session-code")).toHaveCount(0);
    await expect(panel.getByRole("button", {name: "Codex hesabını bağla", exact: true})).toBeDisabled();
    await expect(panel).not.toContainText("PRIVATE_AUTH_DETAIL");
  });
}

test("profile switching cancels only the observed active login, clears its code, and resets selected profile state", async ({page}) => {
  await freezeClock(page); await mockNative(page, envelope(waiting)); const panel = await open(page);
  await expect(panel.getByTestId("profile-session-code")).toBeVisible();
  await page.locator(".managed-profile-list li").filter({hasText: "Claude profilim"}).getByRole("button", {name: "Bu profili seç", exact: true}).click();
  await expect(panel).toContainText("etkileşimli terminal gerektirir"); await expect(panel.getByTestId("profile-session-code")).toHaveCount(0);
  expect((await calls(page)).filter(call => call.command === "local_profile_session_cancel")).toEqual([{command: "local_profile_session_cancel", args: {request: {schema_version: "1.0", request_id: requestId, expected_revision: 3}}}]);
});

for (const action of ["status", "logout"] as const) {
  test(`leaving an active ${action} stops observation without cancelling the CLI`, async ({page}) => {
    await freezeClock(page); await mockNative(page, envelope({...waiting, action, phase: "checking", challenge: null})); const panel = await open(page);
    await expect(panel).toContainText("CLI hesap işlemi sürüyor");
    await page.getByRole("navigation").getByRole("button", {name: /^Çalışma alanı/}).click();
    const before = (await calls(page)).length; await page.clock.fastForward(10_000);
    expect((await calls(page)).length).toBe(before); expect((await calls(page)).some(call => call.command === "local_profile_session_cancel")).toBe(false);
  });
}

test("lost start response blocks duplicates, ignores the late reply, and reconciles through native status", async ({page}) => {
  await freezeClock(page); await mockNative(page); const panel = await open(page);
  await expect(panel.getByRole("button", {name: "Codex hesabını bağla", exact: true})).toBeEnabled();
  await page.evaluate(() => { (window as MockWindow).__sessionMock.deferStart = true; });
  await panel.getByRole("button", {name: "Codex hesabını bağla", exact: true}).click();
  await expect(panel.getByRole("button", {name: "Codex hesabını bağla", exact: true})).toBeDisabled();
  await page.clock.fastForward(5100); await expect(panel.getByRole("alert")).toBeVisible();
  await expect(panel.getByTestId("profile-session-code")).toHaveCount(0); await refresh(page);
  await expect(panel.getByTestId("profile-session-code")).toBeVisible();
  await page.evaluate(value => { (window as MockWindow).__sessionMock.pending.splice(0).forEach(resolve => resolve(value)); }, empty);
  await expect(panel.getByTestId("profile-session-code")).toBeVisible();
  expect((await calls(page)).filter(call => call.command === "local_profile_session_start")).toHaveLength(1);
});

test("native errors and oversized replies hide private details and never use HTTP fallback", async ({page}) => {
  await freezeClock(page); await mockNative(page, envelope(waiting)); let fallback = 0;
  await page.route("**/local-profile-session**", route => { fallback++; return route.abort(); }); const panel = await open(page);
  await expect(panel.getByTestId("profile-session-code")).toBeVisible();
  await page.evaluate(() => { (window as MockWindow).__sessionMock.rejected = true; }); await refresh(page);
  await expect(panel.getByRole("alert")).toBeVisible(); await expect(panel.getByTestId("profile-session-code")).toHaveCount(0);
  await page.evaluate(() => { (window as MockWindow).__sessionMock.rejected = false; });
  await setValue(page, {...empty, private_data: "PRIVATE_AUTH_DETAIL" + "x".repeat(4096)}); await refresh(page);
  await expect(panel.getByRole("alert")).toBeVisible(); await expect(panel).not.toContainText("PRIVATE_AUTH_DETAIL"); expect(fallback).toBe(0);
});

test("native device opening rejects anything except true and clears the code", async ({page}) => {
  await freezeClock(page); await mockNative(page, envelope(waiting)); const panel = await open(page);
  await expect(panel.getByTestId("profile-session-code")).toBeVisible();
  await page.evaluate(() => { (window as MockWindow).__sessionMock.openResult = {url: "PRIVATE_AUTH_DETAIL"}; });
  await panel.getByRole("button", {name: "Codex giriş sayfasını aç", exact: true}).click();
  await expect(panel.getByRole("alert")).toBeVisible(); await expect(panel.getByTestId("profile-session-code")).toHaveCount(0);
  await expect(panel).not.toContainText("PRIVATE_AUTH_DETAIL");
});

test("unknown cleanup prevents every new operation until reviewed", async ({page}) => {
  await mockNative(page, envelope({...waiting, revision: 4, phase: "finished", outcome: "needs_review", challenge: null, error_code: "cleanup_failed", cleanup: "unknown"})); const panel = await open(page);
  await expect(panel).toContainText("inceleme gerekli");
  for (const name of ["CLI hesabını kontrol et", "Codex hesabını bağla", "CLI hesabından çıkış yap"])
    await expect(panel.getByRole("button", {name, exact: true})).toBeDisabled();
  await expect(panel.getByTestId("profile-session-code")).toHaveCount(0);
});

test("login observation expires after twelve minutes, clears the code, and does not invent completion", async ({page}) => {
  await freezeClock(page); await mockNative(page, envelope(waiting)); const panel = await open(page);
  await expect(panel.getByTestId("profile-session-code")).toBeVisible();
  await page.clock.fastForward(600_000); await expect(panel.getByTestId("profile-session-code")).toBeVisible();
  await expect(panel).not.toContainText("Otomatik güncelleme durdu");
  await page.clock.fastForward(121_000); await expect(panel).toContainText("Otomatik güncelleme durdu");
  await expect(panel.getByTestId("profile-session-code")).toHaveCount(0);
  const before = (await calls(page)).length; await page.clock.fastForward(10_000);
  expect((await calls(page)).length).toBe(before); expect((await calls(page)).some(call => call.command === "local_profile_session_cancel")).toBe(false);
  await expect(panel).toContainText("Tarayıcıda giriş yapman bekleniyor");
});

test("departing login resynchronizes one revision conflict and retries cancellation once", async ({page}) => {
  await freezeClock(page); await mockNative(page, envelope(waiting)); const panel = await open(page);
  await expect(panel.getByTestId("profile-session-code")).toBeVisible();
  await page.evaluate(value => { (window as MockWindow).__sessionMock.cancelConflictValue = value; }, envelope({...waiting, revision: 4}));
  await page.getByRole("button", {name: "Katkı ayarları", exact: true}).click();
  await expect.poll(async () => (await calls(page)).filter(call => call.command === "local_profile_session_cancel").length).toBe(2);
  expect((await calls(page)).filter(call => call.command === "local_profile_session_cancel").map(call => call.args)).toEqual([
    {request: {schema_version: "1.0", request_id: requestId, expected_revision: 3}},
    {request: {schema_version: "1.0", request_id: requestId, expected_revision: 4}},
  ]);
  await expect(page.getByTestId("profile-session-code")).toHaveCount(0);
  const before = (await calls(page)).length; await page.clock.fastForward(20_000); expect((await calls(page)).length).toBe(before);
});

test("departing login never retries cancellation against a replacement operation", async ({page}) => {
  await freezeClock(page); await mockNative(page, envelope(waiting)); const panel = await open(page);
  await expect(panel.getByTestId("profile-session-code")).toBeVisible();
  const beforeReads = (await calls(page)).filter(call => call.command === "local_profile_session_status").length;
  await page.evaluate(value => { (window as MockWindow).__sessionMock.cancelConflictValue = value; }, envelope({...waiting, request_id: "b0000000-0000-4000-8000-000000000002", revision: 0}));
  await page.getByRole("button", {name: "Katkı ayarları", exact: true}).click();
  await expect.poll(async () => (await calls(page)).filter(call => call.command === "local_profile_session_status").length).toBe(beforeReads + 1);
  await page.clock.fastForward(20_000);
  expect((await calls(page)).filter(call => call.command === "local_profile_session_cancel")).toHaveLength(1);
  await expect(page.getByTestId("profile-session-code")).toHaveCount(0);
});

test("non-login observation stops after seven minutes without cancelling", async ({page}) => {
  await freezeClock(page); await mockNative(page, envelope({...waiting, action: "status", phase: "checking", challenge: null})); const panel = await open(page);
  await expect(panel).toContainText("CLI hesap işlemi sürüyor");
  await page.clock.fastForward(421_000); await expect(panel).toContainText("Otomatik güncelleme durdu");
  expect((await calls(page)).some(call => call.command === "local_profile_session_cancel")).toBe(false);
});

for (const language of ["tr", "en"] as const) {
  test(`missing runtime image explains setup without claiming Docker is stopped (${language})`, async ({page}) => {
    await mockNative(page, envelope({...waiting, revision: 4, phase: "finished", outcome: "failed", challenge: null, error_code: "image_missing", cleanup: "verified"})); const panel = await open(page);
    if (language === "en") await page.getByRole("button", {name: "Change language", exact: true}).click();
    await expect(panel).toContainText(language === "tr" ? "Ortam kurulumunu tamamlayıp tekrar dene." : "Complete environment setup and try again.");
    await expect(panel).not.toContainText(language === "tr" ? "Docker'ı başlat" : "Start Docker");
    await expect(panel.getByRole("button", {name: language === "tr" ? "Codex hesabını bağla" : "Connect Codex account", exact: true})).toBeEnabled();
    await expect(panel.getByTestId("profile-session-code")).toHaveCount(0);
  });
}
