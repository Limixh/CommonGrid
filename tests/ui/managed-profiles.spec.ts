import { test, expect, type Page } from "@playwright/test";
import type { ManagedProfileCreate, ManagedProfilesStatus } from "../../packages/agent-adapters/src/managed-profile-protocol";

type Mock = {value: unknown; calls: {command: string; args: any}[]; deferredCreate: boolean; pending: ((value: unknown) => void)[]; reject: boolean; failCreateBeforeCommit: boolean};
type MockWindow = Window & {isTauri: boolean; __profilesMock: Mock; __TAURI_INTERNALS__: {invoke: (command: string, args: any) => Promise<unknown>}};
const empty: ManagedProfilesStatus = {schema_version: "1.0", availability: "available", revision: 0, profiles: [], selected_profile_id: null};
const id = "a0000000-0000-4000-8000-000000000001";
const populated: ManagedProfilesStatus = {...empty, revision: 1, profiles: [{profile_id: id, provider: "codex", name: "İlk profil"}]};
async function mockNative(page: Page, value: unknown = empty) {
  await page.addInitScript(value => {
    const target = window as MockWindow; target.isTauri = true;
    target.__profilesMock = {value, calls: [], deferredCreate: false, pending: [], reject: false, failCreateBeforeCommit: false};
    target.__TAURI_INTERNALS__ = {invoke: (command, args) => {
      if (command === "local_cli_check_status") return Promise.resolve({schema_version: "1.0", availability: "available", operation: null});
      if (command === "local_operation_status") return Promise.resolve({status: "unavailable", reason: "operation_journal_missing", execution_enabled: false, automatic_recovery: false, worker_quiescence: "unknown", daemon_state: "unknown", operations: []});
      const mock = target.__profilesMock; mock.calls.push({command, args});
      if (mock.reject) return Promise.reject(new Error("PRIVATE_AUTH_PATH"));
      if (command === "local_managed_profile_create") {
        if (mock.failCreateBeforeCommit) return Promise.reject(new Error("PRIVATE_WRITE_FAILURE"));
        const request = args.request as ManagedProfileCreate;
        const state = mock.value as ManagedProfilesStatus;
        if (!state.profiles.some(profile => profile.profile_id === request.request_id)) {
          if (state.revision !== request.expected_revision) return Promise.reject(new Error("CONFLICT"));
          mock.value = {...state, revision: state.revision + 1, profiles: [...state.profiles, {profile_id: request.request_id, provider: request.provider, name: request.name}]};
        }
        if (mock.deferredCreate) return new Promise(resolve => mock.pending.push(resolve));
      } else if (command === "local_managed_profile_select") {
        const state = mock.value as ManagedProfilesStatus;
        if (state.revision !== args.request.expected_revision) return Promise.reject(new Error("CONFLICT"));
        mock.value = {...state, revision: state.revision + 1, selected_profile_id: args.request.profile_id};
      }
      return Promise.resolve(mock.value);
    }};
  }, value);
}
async function open(page: Page) {
  await page.goto("/"); await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  return page.locator(".managed-profiles-panel");
}
test("browser profile controls stay unavailable without a local HTTP fallback", async ({page}) => {
  let requests = 0; page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/local-managed-profile")) requests++; });
  const panel = await open(page);
  await expect(panel).toContainText("masaüstü uygulamasında");
  await expect(panel.getByRole("button", {name: "Profil oluştur"})).toBeDisabled(); expect(requests).toBe(0);
});
test("native profile creation sends metadata only, selection persists across page navigation", async ({page}) => {
  await mockNative(page); const panel = await open(page);
  await expect(panel.getByRole("button", {name: "Profil oluştur"})).toBeEnabled();
  await panel.getByLabel("Profil adı").fill("Benim Claude"); await panel.getByLabel("Ajan", {exact: true}).selectOption("claude");
  await panel.getByRole("button", {name: "Profil oluştur"}).click();
  await expect(panel.getByText("Benim Claude", {exact: true})).toBeVisible();
  const calls = await page.evaluate(() => (window as MockWindow).__profilesMock.calls);
  const request = calls.find(call => call.command === "local_managed_profile_create")!.args.request;
  expect(request).toEqual({schema_version: "1.0", request_id: expect.stringMatching(/^[a-f0-9-]{36}$/), provider: "claude", name: "Benim Claude", expected_revision: 0});
  await panel.getByRole("button", {name: "Bu profili seç"}).click(); await expect(panel).toContainText("Seçili profil");
  await page.getByRole("navigation").getByRole("button", {name: /^Çalışma alanı/}).click();
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  await expect(panel.getByText("Benim Claude", {exact: true})).toBeVisible(); await expect(panel).toContainText("Seçili profil");
  await expect(panel).toContainText("CLI hesabı henüz kontrol edilmedi");
  await page.setViewportSize({width: 390, height: 844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("profile create wait blocks duplicates and navigation does not send cancellation", async ({page}) => {
  await mockNative(page); const panel = await open(page);
  await expect(panel.getByRole("button", {name: "Profil oluştur"})).toBeEnabled();
  await page.evaluate(() => { (window as MockWindow).__profilesMock.deferredCreate = true; });
  await panel.getByLabel("Profil adı").fill("Bekleyen"); await panel.getByRole("button", {name: "Profil oluştur"}).click();
  await expect(panel.getByRole("button", {name: "Profil oluştur"})).toBeDisabled();
  await expect(panel.getByRole("button", {name: "Profilleri yenile"})).toBeDisabled();
  await page.getByRole("navigation").getByRole("button", {name: /^Çalışma alanı/}).click();
  await page.evaluate(() => { const mock = (window as MockWindow).__profilesMock; mock.pending.splice(0).forEach(resolve => resolve(mock.value)); });
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click(); await expect(panel.getByText("Bekleyen", {exact: true})).toBeVisible();
  const calls = await page.evaluate(() => (window as MockWindow).__profilesMock.calls);
  expect(calls.filter(call => call.command === "local_managed_profile_create")).toHaveLength(1);
  expect(calls.some(call => call.command.includes("cancel") || call.command.includes("login"))).toBe(false);
});
test("timed out create is reconciled by refreshing without creating a duplicate", async ({page}) => {
  await page.clock.install({time: new Date("2026-10-11T12:00:00Z")});
  await mockNative(page); const panel = await open(page);
  await expect(panel.getByRole("button", {name: "Profil oluştur"})).toBeEnabled();
  await page.evaluate(() => { (window as MockWindow).__profilesMock.deferredCreate = true; });
  await panel.getByLabel("Profil adı").fill("Tek profil"); await panel.getByRole("button", {name: "Profil oluştur"}).click();
  await page.clock.runFor(5100); await expect(panel.getByRole("alert")).toBeVisible();
  await panel.getByRole("button", {name: "Profilleri yenile"}).click();
  await expect(panel.getByText("Tek profil", {exact: true})).toBeVisible(); await expect(panel.getByRole("button", {name: "Profil oluştur"})).toBeEnabled();
  await page.evaluate(() => { const mock = (window as MockWindow).__profilesMock; mock.pending.splice(0).forEach(resolve => resolve(mock.value)); });
  expect(await page.evaluate(() => (window as MockWindow).__profilesMock.calls.filter(call => call.command === "local_managed_profile_create").length)).toBe(1);
});
test("invalid and stale profile reads preserve last observation and block mutations", async ({page}) => {
  await mockNative(page, populated); const panel = await open(page); await expect(panel.getByText("İlk profil", {exact: true})).toBeVisible();
  await page.evaluate(value => { (window as MockWindow).__profilesMock.value = value; }, empty);
  await panel.getByRole("button", {name: "Profilleri yenile"}).click();
  await expect(panel.getByRole("alert")).toBeVisible(); await expect(panel.getByText("İlk profil", {exact: true})).toBeVisible();
  await expect(panel.getByRole("button", {name: "Bu profili seç"})).toBeDisabled();
  await page.evaluate(value => { (window as MockWindow).__profilesMock.value = {...value, token: "PRIVATE_AUTH_PATH"}; }, populated);
  await panel.getByRole("button", {name: "Profilleri yenile"}).click(); await expect(panel.getByRole("alert")).toBeVisible();
  await expect(page.getByText("PRIVATE_AUTH_PATH", {exact: false})).toHaveCount(0);
});
test("uncommitted create retries the same identity with the freshly observed revision", async ({page}) => {
  await mockNative(page); const panel = await open(page);
  await expect(panel.getByRole("button", {name: "Profil oluştur"})).toBeEnabled();
  await page.evaluate(() => { (window as MockWindow).__profilesMock.failCreateBeforeCommit = true; });
  await panel.getByLabel("Profil adı").fill("Tekrar denenecek"); await panel.getByRole("button", {name: "Profil oluştur"}).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await page.evaluate(value => { const mock = (window as MockWindow).__profilesMock; mock.failCreateBeforeCommit = false; mock.value = value; }, populated);
  await panel.getByRole("button", {name: "Profilleri yenile"}).click();
  await expect(panel.getByRole("button", {name: "Aynı kaydı tekrar dene"})).toBeEnabled();
  await panel.getByRole("button", {name: "Aynı kaydı tekrar dene"}).click();
  await expect(panel.getByText("Tekrar denenecek", {exact: true})).toBeVisible();
  const creates = await page.evaluate(() => (window as MockWindow).__profilesMock.calls.filter(call => call.command === "local_managed_profile_create"));
  expect(creates).toHaveLength(2); expect(creates[0].args.request.request_id).toBe(creates[1].args.request.request_id);
  expect(creates[0].args.request.expected_revision).toBe(0); expect(creates[1].args.request.expected_revision).toBe(1);
});
test("native profile errors do not reveal details, invoke login or fall back to HTTP", async ({page}) => {
  await mockNative(page); let fallback = 0; await page.route("**/local-managed-profile**", route => { fallback++; return route.abort(); });
  const panel = await open(page); await expect(panel.getByRole("button", {name: "Profil oluştur"})).toBeEnabled();
  await page.evaluate(() => { (window as MockWindow).__profilesMock.reject = true; });
  await panel.getByRole("button", {name: "Profilleri yenile"}).click(); await expect(panel.getByRole("alert")).toBeVisible();
  await expect(page.getByText("PRIVATE_AUTH_PATH", {exact: false})).toHaveCount(0); expect(fallback).toBe(0);
  await expect(panel.getByRole("button", {name: "Profil oluştur"})).toBeDisabled();
});
