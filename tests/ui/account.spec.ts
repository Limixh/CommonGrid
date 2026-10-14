import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";

const catalog = JSON.parse(readFileSync(path.join(process.cwd(), "services/coordinator/internal/catalog/catalog.json"), "utf8"));
const signedIn = { authenticated: true, user: { id: "user-one", display_name: "Ada <script>private</script>", provider: "github" }, csrf_token: "private-csrf-value", expires_at: "2099-01-01T00:00:00Z" };
const dated = { created_at: "2026-10-08T08:00:00Z" };
type Options = {
  authenticated?: boolean; database?: boolean; empty?: boolean; enabled?: boolean;
  sessionFail?: boolean; logoutFail?: boolean; receiptStatus?: number;
  receiptHandler?: (route: Route) => Promise<void>;
};
async function mockAccount(page: Page, options: Options = {}) {
  let authenticated = options.authenticated ?? false;
  let sessionFail = options.sessionFail ?? false;
  let logoutFail = options.logoutFail ?? false;
  let receiptStatus = options.receiptStatus ?? 200;
  const receiptsRequested: string[] = [];
  let logoutHeaders: Record<string, string> = {};
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown;
    if (path === "/api/v1/auth/providers") body = { providers: [{ id: "github", enabled: options.enabled ?? false }, { id: "google", enabled: options.enabled ?? false }] };
    else if (path === "/api/v1/auth/session") {
      if (sessionFail) return route.fulfill({ status: 503, body: "unavailable" });
      body = authenticated ? signedIn : { authenticated: false };
    } else if (path === "/api/v1/auth/logout") {
      logoutHeaders = await route.request().allHeaders();
      if (logoutFail) return route.fulfill({ status: 503, body: "unavailable" });
      authenticated = false;
      return route.fulfill({ status: 204 });
    } else if (["/api/v1/projects", "/api/v1/tasks"].includes(path)) {
      if (options.database && !authenticated) return route.fulfill({ status: 401, json: { error: { code: "unauthenticated" } } });
      body = { source: options.database ? "database" : "fixture", execution_enabled: false, items: options.empty ? [] : path.endsWith("projects") ? catalog.projects : catalog.tasks, statuses: {} };
    } else if (path.startsWith("/api/v1/me/")) {
      receiptsRequested.push(path);
      if (options.receiptHandler) return options.receiptHandler(route);
      if (receiptStatus !== 200) return route.fulfill({ status: receiptStatus, body: "unavailable" });
      const item = path.endsWith("leases") ? { ...dated, id: "lease-one", task_id: "private-task", state: "reserved" }
        : path.endsWith("submissions") ? { ...dated, id: "submission-one", task_id: "private-task", status: "submitted" }
        : { ...dated, metadata: { checkpoint_id: "checkpoint-one", task_id: "private-task" }, status: "usable" };
      body = { source: "database", execution_enabled: false, items: options.empty ? [] : [item], next_cursor: "" };
    } else return route.fulfill({ status: 404, body: "unavailable" });
    await route.fulfill({ json: body });
  });
  return { receiptsRequested, logoutHeaders: () => logoutHeaders, setLogoutFail: (value: boolean) => { logoutFail = value; }, setSessionFail: (value: boolean) => { sessionFail = value; }, setReceiptStatus: (value: number) => { receiptStatus = value; } };
}

async function mockSelectedExecutionProfile(page: Page) {
  await page.addInitScript(() => {
    const target = window as Window & { isTauri: boolean; __executionStarts: unknown[]; __TAURI_INTERNALS__: { invoke: (command: string, args: any) => Promise<unknown> } };
    target.isTauri = true;
    target.__executionStarts = [];
    target.__TAURI_INTERNALS__ = { invoke: (command, args) => {
      if (command === "local_managed_profiles_status") return Promise.resolve({
        schema_version: "1.0", availability: "available", revision: 1,
        selected_profile_id: "a0000000-0000-4000-8000-000000000001",
        profiles: [{ profile_id: "a0000000-0000-4000-8000-000000000001", provider: "codex", name: "Yerel profil" }],
      });
      if (command === "local_run_limits_status") return Promise.resolve({schema_version: "1.0", availability: "available", limits: {attempt_sec: 1800, daily_sec: 7200, concurrency: 1}, usage: {used_sec: 0, open_sec: 0, remaining_sec: 7200, window_seconds: 86400}, effective: {max_sec: 1200, startable: true, reason: null}, paid_mode: "disabled"});
      if (["local_profile_session_status", "local_cli_check_status", "local_task_run_status"].includes(command))
        return Promise.resolve({ schema_version: "1.0", availability: "available", operation: null });
      if (command === "local_operation_status") return Promise.resolve({ status: "unavailable", reason: "operation_journal_missing", execution_enabled: false, automatic_recovery: false, worker_quiescence: "unknown", daemon_state: "unknown", operations: [] });
      if (command === "local_task_run_start") target.__executionStarts.push(args);
      return Promise.reject(new Error("unexpected_fixture_command"));
    } };
  });
}

async function preparePrivateExecutionSelection(page: Page) {
  const task = catalog.tasks.find((item: { id: string }) => item.id === "software-bounds");
  await expect(page.locator(".task-card")).toHaveCount(catalog.tasks.length);
  await page.locator(".task-card").filter({ hasText: task.title }).click();
  await page.getByRole("button", { name: "Profil seçimini hazırla", exact: true }).click();
  const selection = page.getByTestId("execution-selection");
  await expect(selection).toHaveAttribute("data-selection-kind", "catalog");
  await expect(selection).toContainText(task.title);
  await expect(selection).toContainText(task.contract_hash);
  return task;
}

async function expectPrivateExecutionSelectionCleared(page: Page, task: { title: string; contract_hash: string }) {
  await page.getByRole("button", { name: "Ajanlar ve ortam", exact: true }).click();
  const selection = page.getByTestId("execution-selection");
  await expect(selection).toHaveAttribute("data-selection-kind", "controlled");
  await expect(selection).not.toContainText(task.title);
  await expect(selection).not.toContainText(task.contract_hash);
  await expect(page.getByText(task.title, { exact: true })).toHaveCount(0);
  const panel = page.locator(".task-run-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  await expect(panel.getByRole("button", { name: "Başlat", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as Window & { __executionStarts: unknown[] }).__executionStarts)).toEqual([]);
}

test("successful logout clears the captured private catalog execution selection without starting a local task", async ({ page }) => {
  await mockAccount(page, { authenticated: true, database: true });
  await mockSelectedExecutionProfile(page);
  await page.goto("/");
  const task = await preparePrivateExecutionSelection(page);
  await page.getByRole("navigation").getByRole("button", { name: "Hesabım", exact: true }).click();
  await page.getByRole("button", { name: "Çıkış yap", exact: true }).click();
  await expect(page.getByTestId("account-name")).toHaveCount(0);
  await expectPrivateExecutionSelectionCleared(page, task);
});

test("failed logout preserves a captured private task, while receipt expiry clears it without implicit execution", async ({ page }) => {
  const mocked = await mockAccount(page, { authenticated: true, database: true, logoutFail: true });
  await mockSelectedExecutionProfile(page);
  await page.goto("/");
  const task = await preparePrivateExecutionSelection(page);
  await page.getByRole("navigation").getByRole("button", { name: "Hesabım", exact: true }).click();
  await page.getByRole("button", { name: "Çıkış yap", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Hesabın hâlâ bağlı");
  await page.getByRole("button", { name: "Ajanlar ve ortam", exact: true }).click();
  await expect(page.getByTestId("execution-selection")).toHaveAttribute("data-selection-kind", "catalog");
  await expect(page.getByTestId("execution-selection")).toContainText(task.contract_hash);
  await page.getByRole("navigation").getByRole("button", { name: "Katkılarım", exact: true }).click();
  await expect(page.locator(".receipt-card")).toHaveCount(1);
  mocked.setReceiptStatus(401);
  await page.getByRole("button", { name: "Gönderilen sonuçlar", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Oturumun sona erdi");
  await expectPrivateExecutionSelectionCleared(page, task);
});

test("fixture account clearly shows disabled providers without a pretend login", async ({ page }) => {
  await mockAccount(page);
  await page.goto("/");
  await expect(page.locator(".task-card")).toHaveCount(catalog.tasks.length);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Hesabım", exact: true }).click();
  await expect(page.getByText("Hesap bağlantısı hazırlanıyor", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /ile giriş yap/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Change language" }).click();
  await expect(page.getByText("Account connection is being prepared", { exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "My contributions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to see your contribution records." })).toBeVisible();
});

test("authenticated database catalog and private receipts clear on successful logout", async ({ page }) => {
  const mocked = await mockAccount(page, { authenticated: true, database: true });
  await page.goto("/");
  await expect(page.getByText("Ortak görev kataloğu", { exact: true })).toBeVisible();
  await expect(page.locator(".task-card")).toHaveCount(catalog.tasks.length);
  await expect(page.getByRole("button", { name: "Görevi başlat", exact: true })).toBeDisabled();
  expect(mocked.receiptsRequested).toEqual([]);
  await page.getByRole("textbox", { name: "Görevlerde ara…" }).fill("private query");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Katkılarım", exact: true }).click();
  await expect(page.getByTestId("account-name")).toHaveText(signedIn.user.display_name);
  await expect(page.locator(".receipt-card")).toContainText("Ayrıldı");
  await page.getByRole("button", { name: "Gönderilen sonuçlar", exact: true }).click();
  await expect(page.locator(".receipt-card")).toContainText("Gönderildi");
  await page.getByRole("button", { name: "Kaydedilen ilerleme", exact: true }).click();
  await expect(page.locator(".receipt-card")).toContainText("Devam için hazır");
  await page.getByRole("button", { name: "Çıkış yap", exact: true }).click();
  await expect(page.locator(".receipt-card")).toHaveCount(0);
  await expect(page.getByTestId("account-name")).toHaveCount(0);
  expect(mocked.logoutHeaders()["x-csrf-token"]).toBe(signedIn.csrf_token);
  expect(mocked.logoutHeaders().origin).toBe(new URL(page.url()).origin);
  expect(mocked.logoutHeaders().authorization).toBeUndefined();
  await page.getByRole("button", { name: "Çalışma alanı", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Görevleri görmek için hesabına giriş yap.");
  await expect(page.getByRole("textbox", { name: "Görevlerde ara…" })).toHaveValue("");
  await expect(page.locator(".stats-strip")).toHaveCount(0);
  const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
  expect(JSON.stringify(stored)).not.toMatch(/private-csrf|user-one|private-task|private query/);
  expect(stored.cookie).toBe("");
});

test("a valid empty database is distinct from signed-out access", async ({ page }) => {
  await mockAccount(page, { authenticated: true, database: true, empty: true });
  await page.goto("/");
  await expect(page.getByText("Henüz paylaşılmış bir görev yok.")).toBeVisible();
  await expect(page.locator(".stats-strip")).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Katkılarım", exact: true }).click();
  await expect(page.getByText("Bu bölümde henüz katkı kaydın yok.")).toBeVisible();
});

test("failed logout preserves the account, while expired receipts remove private context", async ({ page }) => {
  const mocked = await mockAccount(page, { authenticated: true, database: true, logoutFail: true });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Katkılarım", exact: true }).click();
  await expect(page.locator(".receipt-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Çıkış yap", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Hesabın hâlâ bağlı");
  await expect(page.getByTestId("account-name")).toBeVisible();
  await expect(page.locator(".receipt-card")).toHaveCount(1);
  mocked.setReceiptStatus(401);
  await page.getByRole("button", { name: "Gönderilen sonuçlar", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Oturumun sona erdi");
  await expect(page.getByTestId("account-name")).toHaveCount(0);
  await expect(page.locator(".receipt-card")).toHaveCount(0);
});

test("account and receipt failures have recoverable loading and retry states", async ({ page }) => {
  const mocked = await mockAccount(page, { authenticated: true, database: true, sessionFail: true, receiptStatus: 503 });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Hesabım", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Hesap bilgilerine ulaşılamadı");
  mocked.setSessionFail(false);
  await page.getByRole("button", { name: "Tekrar dene", exact: true }).click();
  await expect(page.getByTestId("account-name")).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Katkılarım", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Katkı kayıtlarına ulaşılamadı");
  mocked.setReceiptStatus(200);
  await page.getByRole("button", { name: "Tekrar dene", exact: true }).click();
  await expect(page.locator(".receipt-card")).toHaveCount(1);
});

test("configured provider uses only the fixed same-origin sign-in path", async ({ page }) => {
  await mockAccount(page, { enabled: true });
  let requested = "";
  await page.route("**/api/v1/auth/github/start", async (route) => {
    requested = route.request().url();
    await route.fulfill({ contentType: "text/html", body: "Sign-in begins" });
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Hesabım", exact: true }).click();
  await page.getByRole("button", { name: "GitHub ile giriş yap", exact: true }).click();
  await expect(page).toHaveURL("/api/v1/auth/github/start");
  expect(new URL(requested).pathname).toBe("/api/v1/auth/github/start");
  expect(new URL(requested).search).toBe("");
});

test("late receipt results cannot return after logout and account views fit mobile", async ({ page }) => {
  let release: (() => void) | undefined;
  let started = false;
  await mockAccount(page, { authenticated: true, database: true, receiptHandler: async (route) => {
    started = true;
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { items: [{ ...dated, id: "late-lease", task_id: "private-late-task", state: "active" }], next_cursor: "" } }).catch(() => {});
  } });
  await page.setViewportSize({ width: 390, height: 850 });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Katkılarım", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Katkı kayıtları yükleniyor");
  await expect.poll(() => started).toBe(true);
  await page.getByRole("button", { name: "Çıkış yap", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Katkı kayıtlarını görmek için hesabına giriş yap." })).toBeVisible();
  release?.();
  await expect(page.locator(".receipt-card")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("account and contribution panels remain accessible at desktop and phone widths", async ({ page }) => {
  await mockAccount(page, { authenticated: true, database: true });
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ...signedIn, user: { ...signedIn.user, display_name: "Ada Yılmaz" } } }));
  await page.goto("/");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1050 : 850 });
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Hesabım", exact: true }).click();
    await expect(page.getByTestId("account-name")).toHaveText("Ada Yılmaz");
    await expect(page.getByRole("button", { name: "Çıkış yap", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(process.cwd(), ".local/validation", `account-${width}.png`), fullPage: true });
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Katkılarım", exact: true }).click();
    await expect(page.locator(".receipt-card")).toContainText("Ayrıldı");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(process.cwd(), ".local/validation", `contributions-${width}.png`), fullPage: true });
  }
});
