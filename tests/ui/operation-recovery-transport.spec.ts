import { test, expect, type Page } from "@playwright/test";

const operation = {identity: {owner: "a0000000-0000-4000-8000-000000000001", provider: "codex", operation: "a0000000-0000-4000-8000-000000000002"}, last_sequence: 4, last_hash: "a".repeat(64), status: "needs_review", pending_count: 1, recorded_namespace_count: 1, durability: "process_crash"};
const envelope = {status: "available", execution_enabled: false, automatic_recovery: false, worker_quiescence: "unknown", daemon_state: "unknown", operations: [operation]};
const revised = {...envelope, operations: [{...operation, last_sequence: 8, last_hash: "b".repeat(64)}]};
type MockState = {
  calls: {command: string; args: unknown; options: unknown}[];
  value: unknown;
  deferred: number;
  pending: ((value: unknown) => void)[];
};
type MockWindow = Window & {isTauri: boolean; __operationMock: MockState; __TAURI_INTERNALS__: {invoke: (command: string, args: unknown, options: unknown) => Promise<unknown>}};

// This mocks the JS IPC boundary in Chromium; it does not launch a native application.
async function mockNative(page: Page, value: unknown = envelope, deferred = 0, reject = false) {
  await page.addInitScript(({value, deferred, reject}) => {
    const target = window as MockWindow;
    target.isTauri = true;
    target.__operationMock = {calls: [], value, deferred, pending: []};
    target.__TAURI_INTERNALS__ = {invoke: (command, args, options) => {
      const mock = target.__operationMock;
      mock.calls.push({command, args, options});
      if (reject) return Promise.reject(new Error("private/auth/native-error"));
      if (mock.deferred-- > 0) return new Promise(resolve => mock.pending.push(resolve));
      return Promise.resolve(mock.value);
    }};
  }, {value, deferred, reject});
}

async function openRecovery(page: Page) {
  await page.goto("/");
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
}
async function review(page: Page) {
  await page.getByRole("button", {name: "İnceleme isteğini göster", exact: true}).click();
  return page.getByTestId("operation-review-request");
}

test("mocked native IPC takes precedence over DEV HTTP and sends only a no-argument status command", async ({page}) => {
  let httpReads = 0;
  await page.route("**/local-operation-status", route => { httpReads++; return route.fulfill({json: revised}); });
  await mockNative(page);
  await openRecovery(page);
  const request = await review(page);
  await expect(request).toContainText('"expected_sequence": 4');
  await expect(request).toContainText('"expected_hash": "' + "a".repeat(64) + '"');
  await expect(request).toContainText('"action": "inspect_only"');
  await expect(request).toContainText('"execution_enabled": false');
  await expect(request).toContainText('"automatic_recovery": false');
  const initialReads = await page.evaluate(() => (window as MockWindow).__operationMock.calls.length);
  await page.evaluate(value => { (window as MockWindow).__operationMock.value = value; }, revised);
  await page.getByRole("button", {name: "İşlem kayıtlarını yenile"}).click();
  await expect(request).toHaveCount(0);
  await expect(await review(page)).toContainText('"expected_sequence": 8');
  const calls = await page.evaluate(() => (window as MockWindow).__operationMock.calls.map(({command, args}) => ({command, args})));
  expect(calls).toHaveLength(initialReads + 1);
  for (const call of calls) expect(call).toEqual({command: "local_operation_status", args: {}});
  expect(httpReads).toBe(0);
});

for (const scenario of [
  {name: "rejected invoke", value: envelope, reject: true},
  {name: "invalid authority fields", value: {...envelope, execution_enabled: true}, reject: false},
  {name: "unprojected response", value: {...envelope, secret: "private/auth/native-error"}, reject: false},
  {name: "oversized native response", value: {...envelope, secret: "private/auth/native-error" + "x".repeat(1048576)}, reject: false},
]) test(`mocked native ${scenario.name} fails closed without DEV HTTP fallback`, async ({page}) => {
  let httpReads = 0;
  await page.route("**/local-operation-status", route => { httpReads++; return route.fulfill({json: envelope}); });
  await mockNative(page, scenario.value, 0, scenario.reject);
  await openRecovery(page);
  await expect(page.locator(".operation-recovery").getByRole("alert")).toContainText("İşlem kayıtları doğrulanamadı");
  await expect(page.getByRole("button", {name: "İnceleme isteğini göster"})).toHaveCount(0);
  await expect(page.getByText("private/auth/native-error", {exact: false})).toHaveCount(0);
  expect(httpReads).toBe(0);
});

test("mocked native refresh ignores a superseded noncancellable invoke completion", async ({page}) => {
  // React StrictMode performs the initial effect twice in DEV.
  await mockNative(page, revised, 2);
  await openRecovery(page);
  await expect(page.locator(".operation-recovery").getByRole("status")).toContainText("İşlem kayıtları okunuyor");
  await page.getByRole("button", {name: "İşlem kayıtlarını yenile"}).click();
  const request = await review(page);
  await expect(request).toContainText('"expected_sequence": 8');
  await page.evaluate(value => { (window as MockWindow).__operationMock.pending.splice(0).forEach(resolve => resolve(value)); }, envelope);
  await expect(request).toContainText('"expected_sequence": 8');
  await expect(page.locator(".operation-record")).toContainText("Günlük sürümü: 8");
});

test("mocked native timeout ends waiting and ignores a late completion after refresh", async ({page}) => {
  await page.clock.install();
  await mockNative(page, revised, 2);
  await openRecovery(page);
  await expect(page.locator(".operation-recovery").getByRole("status")).toContainText("İşlem kayıtları okunuyor");
  await page.clock.fastForward(5100);
  await expect(page.locator(".operation-recovery").getByRole("alert")).toContainText("İşlem kayıtları doğrulanamadı");
  await page.getByRole("button", {name: "İşlem kayıtlarını yenile"}).click();
  const request = await review(page);
  await expect(request).toContainText('"expected_sequence": 8');
  await page.evaluate(value => { (window as MockWindow).__operationMock.pending.splice(0).forEach(resolve => resolve(value)); }, envelope);
  await expect(request).toContainText('"expected_sequence": 8');
  await expect(page.locator(".operation-recovery").getByRole("alert")).toHaveCount(0);
});

test("mocked native completion after unmount cannot overwrite the remounted panel", async ({page}) => {
  await mockNative(page, revised, 2);
  await openRecovery(page);
  await expect(page.locator(".operation-recovery").getByRole("status")).toContainText("İşlem kayıtları okunuyor");
  await page.getByRole("button", {name: "Katkı ayarları", exact: true}).click();
  await expect(page.locator(".operation-recovery")).toHaveCount(0);
  await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  const request = await review(page);
  await expect(request).toContainText('"expected_sequence": 8');
  await page.evaluate(value => { (window as MockWindow).__operationMock.pending.splice(0).forEach(resolve => resolve(value)); }, envelope);
  await expect(request).toContainText('"expected_sequence": 8');
  expect(await page.evaluate(() => (window as MockWindow).__operationMock.calls.length)).toBeGreaterThan(2);
});

test("DEV HTTP response byte bound rejects oversized otherwise-valid JSON", async ({page}) => {
  await page.route("**/local-operation-status", route => route.fulfill({body: " ".repeat(1048576) + JSON.stringify(envelope), contentType: "application/json"}));
  await openRecovery(page);
  await expect(page.locator(".operation-recovery").getByRole("alert")).toContainText("İşlem kayıtları doğrulanamadı");
  await expect(page.getByRole("button", {name: "İnceleme isteğini göster"})).toHaveCount(0);
  await expect(page.locator(".operation-record")).toHaveCount(0);
});
