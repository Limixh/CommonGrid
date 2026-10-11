import { test, expect, type Page } from "@playwright/test";

const id = "a0000000-0000-4000-8000-000000000001";
const empty = {schema_version: "1.0", availability: "available", operation: null};
const running = {request_id: id, provider: "codex", revision: 3, phase: "checking", outcome: null, cli_version: null, error_code: null, cleanup: "pending"};
const envelope = (operation: unknown) => ({...empty, operation});
async function freezeClock(page: Page) {
  const time = new Date("2026-10-10T12:00:00Z");
  await page.clock.install({time});
  await page.clock.pauseAt(new Date(time.getTime() + 1000));
}

type Mock = {calls: {command: string; args: unknown}[]; value: unknown; deferred: number; pending: ((value: unknown) => void)[]; startDeferred: boolean; rejected: boolean};
type MockWindow = Window & {isTauri: boolean; __cliMock: Mock; __TAURI_INTERNALS__: {invoke: (command: string, args: unknown) => Promise<unknown>}};
async function mockNative(page: Page, value: unknown = empty, deferred = 0) {
  await page.addInitScript(({value, deferred}) => {
    const target = window as MockWindow;
    target.isTauri = true;
    target.__cliMock = {calls: [], value, deferred, pending: [], startDeferred: false, rejected: false};
    target.__TAURI_INTERNALS__ = {invoke: (command, args) => {
      if (command === "local_managed_profiles_status") return Promise.resolve({schema_version: "1.0", availability: "unavailable", revision: 0, profiles: [], selected_profile_id: null});
      if (command === "local_operation_status") return Promise.resolve({status: "unavailable", reason: "operation_journal_missing", execution_enabled: false, automatic_recovery: false, worker_quiescence: "unknown", daemon_state: "unknown", operations: []});
      const mock = target.__cliMock; mock.calls.push({command, args});
      if (mock.rejected) return Promise.reject(new Error("private/auth/secret"));
      if (command === "local_cli_check_start") {
        const request = (args as {request: {request_id: string; provider: string}}).request;
        mock.value = {schema_version: "1.0", availability: "available", operation: {request_id: request.request_id, provider: request.provider, revision: 0, phase: "starting", outcome: null, cli_version: null, error_code: null, cleanup: "pending"}};
        if (mock.startDeferred) return new Promise(resolve => mock.pending.push(resolve));
      }
      if (command === "local_cli_check_cancel") {
        const request = (args as {request: {request_id: string; expected_revision: number}}).request;
        const provider = (mock.value as {operation: {provider: string}}).operation.provider;
        mock.value = {schema_version: "1.0", availability: "available", operation: {request_id: request.request_id, provider, revision: request.expected_revision + 1, phase: "finished", outcome: "cancelled", cli_version: null, error_code: "cancelled", cleanup: "verified"}};
      }
      if (mock.deferred-- > 0) return new Promise(resolve => mock.pending.push(resolve));
      return Promise.resolve(mock.value);
    }};
  }, {value, deferred});
}
async function openPanel(page: Page) {
  await page.goto("/");
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  return page.locator(".cli-check-panel");
}

test("browser check stays unavailable and sends no launcher HTTP request", async ({page}) => {
  let launcherRequests = 0;
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/local-cli-check")) launcherRequests++; });
  const panel = await openPanel(page);
  await expect(panel.getByRole("status")).toContainText("masaüstü uygulamasında");
  await expect(panel.getByRole("button", {name: "Codex'i kontrol et"})).toBeDisabled();
  await expect(panel.getByRole("button", {name: "Claude Code'u kontrol et"})).toBeDisabled();
  expect(launcherRequests).toBe(0);
});

test("native check sends a bounded provider-only start, blocks duplicates, polls and shows verified version", async ({page}) => {
  await freezeClock(page);
  await mockNative(page);
  const panel = await openPanel(page);
  await panel.getByRole("button", {name: "Codex'i kontrol et"}).click();
  await expect(panel).toContainText("Kontrol başlatılıyor");
  await expect(panel.getByRole("button", {name: "Codex'i kontrol et"})).toBeDisabled();
  await expect(panel.getByRole("button", {name: "Claude Code'u kontrol et"})).toBeDisabled();
  const calls = await page.evaluate(() => (window as MockWindow).__cliMock.calls);
  const started = calls.find(call => call.command === "local_cli_check_start")!;
  const request = (started.args as {request: {schema_version: string; provider: string; request_id: string}}).request;
  expect(started.args).toEqual({request: {schema_version: "1.0", provider: "codex", request_id: request.request_id}});
  expect(request.request_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(calls.filter(call => call.command === "local_cli_check_status").every(call => JSON.stringify(call.args) === "{}")).toBe(true);
  await page.evaluate(({id}) => {
    (window as MockWindow).__cliMock.value = {schema_version: "1.0", availability: "available", operation: {request_id: id, provider: "codex", revision: 4, phase: "finished", outcome: "passed", cli_version: "codex-cli 0.157.1", error_code: null, cleanup: "verified"}};
  }, {id: request.request_id});
  await page.clock.fastForward(1100);
  await expect(panel.getByTestId("cli-check-version")).toHaveText("codex-cli 0.157.1");
  await expect(panel.getByRole("button", {name: "Codex'i kontrol et"})).toBeEnabled();
});

test("cancel invokes the exact observed operation and revision instead of only aborting the UI wait", async ({page}) => {
  await mockNative(page, envelope(running));
  const panel = await openPanel(page);
  await expect(panel).toContainText("CLI sürümü kontrol ediliyor");
  await panel.getByRole("button", {name: "Kontrolü iptal et"}).click();
  await expect(panel).toContainText("Kontrol iptal edildi");
  const calls = await page.evaluate(() => (window as MockWindow).__cliMock.calls);
  expect(calls.filter(call => call.command === "local_cli_check_cancel")).toEqual([{command: "local_cli_check_cancel", args: {request: {schema_version: "1.0", request_id: id, expected_revision: 3}}}]);
});

for (const language of ["tr", "en"] as const) {
  test(`image_missing explains environment setup and permits retry after verified cleanup (${language})`, async ({page}) => {
    await freezeClock(page);
    await mockNative(page, envelope(running));
    const panel = await openPanel(page);
    await expect(panel).toContainText("CLI sürümü kontrol ediliyor");
    if (language === "en") await page.getByRole("button", {name: "Change language"}).click();
    await page.evaluate(value => { (window as MockWindow).__cliMock.value = value; }, envelope({...running, revision: 4, phase: "finished", outcome: "failed", error_code: "image_missing", cleanup: "verified"}));
    await panel.getByRole("button", {name: language === "tr" ? "Kontrol durumunu yenile" : "Refresh check status"}).click();
    await expect(panel.getByRole("status")).toContainText(language === "tr" ? "CLI kontrolü tamamlanamadı" : "The CLI check could not complete");
    await expect(panel).toContainText(language === "tr"
      ? "Gerekli çalışma ortamı imajı bulunamadı. Ortam kurulumunu tamamlayıp tekrar dene."
      : "The required runtime image was not found. Complete environment setup and try again.");
    await expect(panel).not.toContainText(language === "tr" ? "Docker'ı başlat" : "Start Docker");
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(panel.getByRole("button", {name: language === "tr" ? "Claude Code'u kontrol et" : "Check Claude Code"})).toBeEnabled();
    await panel.getByRole("button", {name: language === "tr" ? "Codex'i kontrol et" : "Check Codex"}).click();
    await expect(panel).toContainText(language === "tr" ? "Kontrol başlatılıyor" : "Starting check");
    expect(await page.evaluate(() => (window as MockWindow).__cliMock.calls.filter(call => call.command === "local_cli_check_start").length)).toBe(1);
  });
}

for (const changes of [{revision: 2}, {revision: 4, phase: "preparing"}, {request_id: "a0000000-0000-4000-8000-000000000002"}, {revision: 4, private_error: "private/auth/secret"}, {revision: 4, error_code: "private/auth/secret"}]) {
  test(`invalid or stale native update fails closed ${JSON.stringify(changes)}`, async ({page}) => {
    await freezeClock(page); await mockNative(page, envelope(running));
    const panel = await openPanel(page);
    await expect(panel).toContainText("CLI sürümü kontrol ediliyor");
    await page.evaluate(value => { (window as MockWindow).__cliMock.value = value; }, envelope({...running, ...changes}));
    await panel.getByRole("button", {name: "Kontrol durumunu yenile"}).click();
    await expect(panel.getByRole("alert")).toContainText("doğrulanamadı");
    await expect(panel).toContainText("CLI sürümü kontrol ediliyor");
    await expect(panel).not.toContainText("private/auth/secret");
    await expect(panel.getByRole("button", {name: "Codex'i kontrol et"})).toBeDisabled();
  });
}

test("superseded and unmounted native reads cannot replace newer state or cancel a process", async ({page}) => {
  await freezeClock(page);
  await mockNative(page, envelope(running), 2);
  const panel = await openPanel(page);
  await panel.getByRole("button", {name: "Kontrol durumunu yenile"}).click();
  await expect(panel).toContainText("CLI sürümü kontrol ediliyor");
  await page.evaluate(value => { (window as MockWindow).__cliMock.pending.splice(0).forEach(resolve => resolve(value)); }, empty);
  await expect(panel).toContainText("CLI sürümü kontrol ediliyor");
  await page.evaluate(() => { (window as MockWindow).__cliMock.deferred = 1; });
  await panel.getByRole("button", {name: "Kontrol durumunu yenile"}).click();
  await expect(panel).toHaveAttribute("aria-busy", "true");
  await page.getByRole("button", {name: "Katkı ayarları", exact: true}).click();
  expect(await page.evaluate(() => (window as MockWindow).__cliMock.calls.filter(call => call.command === "local_cli_check_cancel").length)).toBe(0);
  const finished = envelope({...running, revision: 5, phase: "finished", outcome: "passed", cli_version: "codex-cli 0.157.1", error_code: null, cleanup: "verified"});
  await page.evaluate(value => { (window as MockWindow).__cliMock.value = value; }, finished);
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  await expect(panel.getByTestId("cli-check-version")).toHaveText("codex-cli 0.157.1");
  await page.evaluate(value => { (window as MockWindow).__cliMock.pending.splice(0).forEach(resolve => resolve(value)); }, envelope(running));
  await expect(panel.getByTestId("cli-check-version")).toHaveText("codex-cli 0.157.1");
});

test("native errors never display private details or fall back to HTTP", async ({page}) => {
  await mockNative(page);
  await page.addInitScript(() => { (window as MockWindow).__cliMock.rejected = true; });
  let fallback = 0; await page.route("**/local-cli-check**", route => { fallback++; return route.abort(); });
  const panel = await openPanel(page);
  await expect(panel.getByRole("alert")).toContainText("doğrulanamadı");
  await expect(panel).not.toContainText("private/auth/secret");
  expect(fallback).toBe(0);
});

test("native wait timeout ignores late replies and requires a new status before another start", async ({page}) => {
  await freezeClock(page); await mockNative(page, empty, 2);
  const panel = await openPanel(page);
  await page.clock.fastForward(5100);
  await expect(panel.getByRole("alert")).toContainText("doğrulanamadı");
  await expect(panel.getByRole("button", {name: "Codex'i kontrol et"})).toBeDisabled();
  await panel.getByRole("button", {name: "Kontrol durumunu yenile"}).click();
  await expect(panel.getByRole("button", {name: "Codex'i kontrol et"})).toBeEnabled();
  await page.evaluate(value => { (window as MockWindow).__cliMock.pending.splice(0).forEach(resolve => resolve(value)); }, envelope(running));
  await expect(panel.getByRole("button", {name: "Codex'i kontrol et"})).toBeEnabled();
});

test("a pending start cannot submit a second provider and a lost reply reconciles through status", async ({page}) => {
  await freezeClock(page); await mockNative(page);
  const panel = await openPanel(page);
  await expect(panel.getByRole("button", {name: "Codex'i kontrol et"})).toBeEnabled();
  await page.evaluate(() => { (window as MockWindow).__cliMock.startDeferred = true; });
  await panel.getByRole("button", {name: "Codex'i kontrol et"}).click();
  await expect(panel.getByRole("button", {name: "Codex'i kontrol et"})).toBeDisabled();
  await expect(panel.getByRole("button", {name: "Claude Code'u kontrol et"})).toBeDisabled();
  await page.clock.fastForward(5100);
  await expect(panel.getByRole("alert")).toContainText("doğrulanamadı");
  await panel.getByRole("button", {name: "Kontrol durumunu yenile"}).click();
  await expect(panel).toContainText("Kontrol başlatılıyor");
  await expect(panel.getByRole("button", {name: "Codex'i kontrol et"})).toBeDisabled();
  expect(await page.evaluate(() => (window as MockWindow).__cliMock.calls.filter(call => call.command === "local_cli_check_start").length)).toBe(1);
  await page.evaluate(() => { const mock = (window as MockWindow).__cliMock; mock.pending.splice(0).forEach(resolve => resolve(mock.value)); });
  await expect(panel).toContainText("Kontrol başlatılıyor");
});

test("unknown cleanup prevents another check and oversized IPC never reaches the display", async ({page}) => {
  await mockNative(page, envelope({...running, revision: 4, phase: "finished", outcome: "needs_review", error_code: "cleanup_failed", cleanup: "unknown"}));
  const panel = await openPanel(page);
  await expect(panel).toContainText("inceleme gerekli");
  await expect(panel.getByRole("button", {name: "Codex'i kontrol et"})).toBeDisabled();
  await page.evaluate(value => { (window as MockWindow).__cliMock.value = value; }, {...empty, private_data: "private/auth/secret" + "x".repeat(4096)});
  await panel.getByRole("button", {name: "Kontrol durumunu yenile"}).click();
  await expect(panel.getByRole("alert")).toContainText("doğrulanamadı");
  await expect(panel).not.toContainText("private/auth/secret");
});

test("automatic observation stops after 420 polls without inventing completion or cancelling", async ({page}) => {
  // The 420 sequential browser observations need wall-clock headroom during native builds.
  // Virtual time and the exact product polling cap remain asserted below.
  test.setTimeout(180_000);
  await freezeClock(page); await mockNative(page, envelope(running));
  const panel = await openPanel(page);
  await expect(panel).toContainText("CLI sürümü kontrol ediliyor");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  const initial = await page.evaluate(() => (window as MockWindow).__cliMock.calls.length);
  for (let poll = 0; poll < 420; poll++) {
    await page.clock.fastForward(1100);
    await expect.poll(() => page.evaluate(() => ({
      calls: (window as MockWindow).__cliMock.calls.length,
      busy: document.querySelector(".cli-check-panel")?.getAttribute("aria-busy"),
    }))).toEqual({calls: initial + poll + 1, busy: "false"});
  }
  await expect(panel).toContainText("Otomatik güncelleme durdu");
  const calls = await page.evaluate(() => (window as MockWindow).__cliMock.calls);
  await page.clock.fastForward(10_000);
  expect(await page.evaluate(() => (window as MockWindow).__cliMock.calls.length)).toBe(calls.length);
  expect(calls.filter(call => call.command === "local_cli_check_cancel")).toHaveLength(0);
  await expect(panel).toContainText("CLI sürümü kontrol ediliyor");
});
