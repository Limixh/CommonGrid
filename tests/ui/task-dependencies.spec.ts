import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { contractHash } from "../../packages/task-schema/src/index";

const catalog = JSON.parse(readFileSync(path.join(process.cwd(), "services/coordinator/internal/catalog/catalog.json"), "utf8"));
const leanBase = catalog.tasks[0];
const softwareBase = catalog.tasks[1];
const planBase = catalog.tasks[2];
const signedIn = { authenticated: true, user: { id: "user-one", display_name: "Ada Yılmaz", provider: "github" }, csrf_token: "csrf-value", expires_at: "2099-01-01T00:00:00Z" };
type Json = Record<string, any>;
type Over = { title?: string; depends_on?: string[]; kind?: string; project_id?: string };

async function make(base: Json, id: string, over: Over = {}) {
  const task: Json = { ...structuredClone(base), id, node_id: "node-" + id, title: over.title ?? `Task ${id}`, depends_on: over.depends_on ?? [] };
  if (over.kind) task.kind = over.kind;
  if (over.project_id) task.project_id = over.project_id;
  task.contract_hash = await contractHash(task as never);
  return task;
}
type Reply = { items?: Json[]; statuses?: Json; next_cursor?: string; status?: number; hold?: Promise<void>; raw?: Json };
type Mock = {
  tasks: Record<string, Reply>;
  projects?: Record<string, Reply>;
  source?: "database" | "fixture";
  onTasks?: (after: string, count: number) => Reply | undefined;
};
async function mock(page: Page, config: Mock) {
  const requested: string[] = [];
  const counts: Record<string, number> = {};
  const state = { signedIn: true };
  const projectPages = config.projects ?? { "": { items: catalog.projects } };
  const send = async (route: Route, reply: Reply | undefined, shape: (r: Reply) => Json) => {
    if (!reply) return route.fulfill({ status: 404, json: { code: "not_found" } });
    if (reply.hold) await reply.hold;
    if (reply.status && reply.status !== 200) return route.fulfill({ status: reply.status, json: { code: "x" } }).catch(() => {});
    return route.fulfill({ json: reply.raw ?? shape(reply) }).catch(() => {});
  };
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    requested.push(p + url.search);
    if (p === "/api/v1/auth/providers") return route.fulfill({ json: { providers: [{ id: "github", enabled: true }, { id: "google", enabled: false }] } });
    if (p === "/api/v1/auth/session") return route.fulfill({ json: state.signedIn ? signedIn : { authenticated: false } });
    const source = config.source ?? "database";
    if (p === "/api/v1/projects") {
      const after = url.searchParams.get("after") ?? "";
      return send(route, projectPages[after], (r) => ({ source, execution_enabled: false, items: r.items, next_cursor: r.next_cursor ?? "" }));
    }
    if (p === "/api/v1/tasks") {
      const after = url.searchParams.get("after") ?? "";
      counts[after] = (counts[after] ?? 0) + 1;
      const reply = config.onTasks?.(after, counts[after]) ?? config.tasks[after];
      return send(route, reply, (r) => ({ source, execution_enabled: false, items: r.items, statuses: r.statuses ?? {}, next_cursor: r.next_cursor ?? "" }));
    }
    return route.fulfill({ status: 404, json: { code: "not_found" } });
  });
  return { requested, counts, state };
}
const card = (page: Page, title: string) => page.locator(".task-card", { hasText: title });
const panel = (page: Page) => page.getByTestId("task-dependencies");
const loadMore = (page: Page) => page.locator(".td-pager").getByRole("button", { name: /Daha fazla görev yükle|Load more tasks/ });
async function openCatalog(page: Page, expectedCards: number) {
  await page.goto("/");
  await expect(page.locator(".task-card")).toHaveCount(expectedCards);
}

test("fixture catalog without statuses shows unknown status and the real kind labels", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".task-card")).toHaveCount(3);
  await expect(page.locator(".task-card .td-status-unknown")).toHaveCount(3);
  await expect(page.locator(".task-card .td-status-unknown").first()).toHaveText("Durum bilinmiyor");
  await expect(card(page, catalog.tasks[2].title).locator(".kind-badge")).toHaveText("AYRIŞTIRMA");
  await expect(card(page, catalog.tasks[0].title).locator(".kind-badge")).toHaveText("ÇÖZÜM");
  await expect(page.getByRole("button", { name: /Daha fazla görev yükle/ })).toHaveCount(0);
  await page.getByLabel("Duruma göre filtrele").selectOption("open");
  await expect(page.getByText("Bu filtrelerle eşleşen görev bulunamadı.")).toBeVisible();
  await page.getByLabel("Duruma göre filtrele").selectOption("unknown");
  await expect(page.locator(".task-card")).toHaveCount(3);
  await expect(panel(page)).toContainText("Bu görevin önkoşulu yok.");
});

test("refute and rebase are labelled as themselves and never as solve", async ({ page }) => {
  const refute = await make(softwareBase, "t-refute", { kind: "refute" });
  const rebase = await make(softwareBase, "t-rebase", { kind: "rebase" });
  const solve = await make(softwareBase, "t-solve");
  await mock(page, { tasks: { "": { items: [refute, rebase, solve] } } });
  await openCatalog(page, 3);
  await expect(card(page, "Task t-refute").locator(".kind-badge")).toHaveText("ÇÜRÜTME");
  await expect(card(page, "Task t-rebase").locator(".kind-badge")).toHaveText("TABAN GÜNCELLEME");
  await expect(card(page, "Task t-solve").locator(".kind-badge")).toHaveText("ÇÖZÜM");
  await page.getByRole("button", { name: "Change language" }).click();
  await expect(card(page, "Task t-refute").locator(".kind-badge")).toHaveText("REFUTATION");
  await expect(card(page, "Task t-rebase").locator(".kind-badge")).toHaveText("REBASE");
  await expect(page.locator(".detail-facts")).toContainText("Kind");
});

test("a prerequisite on the second page is explicit, then reachable by keyboard after loading more", async ({ page }) => {
  const a = await make(softwareBase, "t-a", { depends_on: ["t-z"] });
  const b = await make(softwareBase, "t-b");
  const z = await make(softwareBase, "t-z", { title: "Zeta prerequisite" });
  const { requested } = await mock(page, {
    projects: { "": { items: [catalog.projects[0]], next_cursor: "proof-lab" }, "proof-lab": { items: [catalog.projects[1]] } },
    tasks: {
      "": { items: [a, b], statuses: { "t-a": "open", "t-b": "awaiting_review" }, next_cursor: "t-b" },
      "t-b": { items: [z], statuses: { "t-z": "accepted" } },
    },
  });
  await openCatalog(page, 2);
  await expect(card(page, "Task t-a").locator(".td-status")).toHaveText("Açık");
  await expect(card(page, "Task t-b").locator(".td-status")).toHaveText("İnceleme bekliyor");
  const relation = panel(page).locator("[data-relation-state=unloaded]");
  await expect(relation).toContainText("t-z");
  await expect(relation).toContainText("Henüz yüklenmedi");
  await expect(relation).toContainText("Durum bilinmiyor");
  await expect(panel(page)).toContainText("yüklenmemiş sayfalardaki bağımlı");
  // Task and project cursors are independent.
  expect(requested.filter((r) => r.startsWith("/api/v1/tasks?"))).toEqual([]);
  expect(requested.filter((r) => r.startsWith("/api/v1/projects?"))).toEqual([]);
  await loadMore(page).click();
  await expect(page.locator(".task-card")).toHaveCount(3);
  expect(requested).toContain("/api/v1/tasks?after=t-b");
  expect(requested.filter((r) => r.startsWith("/api/v1/projects?"))).toEqual([]);
  await expect(loadMore(page)).toHaveCount(0);
  const visible = panel(page).locator("[data-relation-state=visible]");
  await expect(visible).toContainText("Zeta prerequisite");
  await expect(visible).toContainText("Kabul edildi");
  await expect(panel(page)).not.toContainText("yüklenmemiş sayfalardaki bağımlı");
  await visible.getByRole("button").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".detail-panel h2")).toHaveText("Zeta prerequisite");
  await expect(page.locator(".detail-panel h2")).toBeFocused();
  await expect(card(page, "Zeta prerequisite")).toHaveAttribute("aria-pressed", "true");
  await expect(panel(page).locator("[data-relation-state=visible]")).toContainText("Task t-a");
  await expect(panel(page)).toContainText("Bu görevin önkoşulu yok.");
  // Project paging only happens on request.
  await page.getByRole("button", { name: "Daha fazla proje yükle" }).click();
  await expect(page.getByRole("button", { name: "Daha fazla proje yükle" })).toHaveCount(0);
  expect(requested).toContain("/api/v1/projects?after=proof-lab");
});

test("a relation hidden by filters says so and can clear the filters to open it", async ({ page }) => {
  const lean = await make(leanBase, "t-lean", { title: "Lean prerequisite" });
  const soft = await make(softwareBase, "t-soft", { depends_on: ["t-lean"] });
  await mock(page, { tasks: { "": { items: [lean, soft], statuses: { "t-lean": "resumable", "t-soft": "open" } } } });
  await openCatalog(page, 2);
  await page.getByRole("button", { name: /^Yazılım/ }).click();
  await expect(page.locator(".task-card")).toHaveCount(1);
  const relation = panel(page).locator("[data-relation-state=filtered]");
  await expect(relation).toContainText("Lean prerequisite");
  await expect(relation).toContainText("Filtre dışında");
  await expect(relation).toContainText("Devam edilebilir");
  await relation.getByRole("button", { name: /Filtreleri temizle ve aç/ }).click();
  await expect(page.locator(".task-card")).toHaveCount(2);
  await expect(page.locator(".detail-panel h2")).toHaveText("Lean prerequisite");
  await expect(panel(page).locator("[data-relation-state=visible]")).toContainText("Task t-soft");
});

test("status filter uses server statuses and keeps the contract free of status", async ({ page }) => {
  const a = await make(softwareBase, "t-a");
  const b = await make(softwareBase, "t-b");
  const c = await make(softwareBase, "t-c");
  await mock(page, { tasks: { "": { items: [a, b, c], statuses: { "t-a": "open", "t-b": "archived", "t-c": "brand_new_state", "t-ghost": "open" } } } });
  await openCatalog(page, 3);
  await expect(card(page, "Task t-c").locator(".td-status")).toHaveText("Durum bilinmiyor");
  await page.getByLabel("Duruma göre filtrele").selectOption("archived");
  await expect(page.locator(".task-card")).toHaveCount(1);
  await expect(page.locator(".task-card")).toContainText("Task t-b");
  await page.getByLabel("Duruma göre filtrele").selectOption("unknown");
  await expect(page.locator(".task-card")).toHaveCount(1);
  await expect(page.locator(".task-card")).toContainText("Task t-c");
  await page.getByRole("button", { name: "Sözleşme", exact: true }).click();
  const contract = JSON.parse((await page.getByTestId("contract-json").textContent()) ?? "{}");
  expect(contract).toEqual(c);
  expect(Object.keys(contract)).not.toContain("status");
});

test("a repeated task id on a later page is ignored and counted", async ({ page }) => {
  const a = await make(softwareBase, "t-a");
  const b = await make(softwareBase, "t-b");
  const c = await make(softwareBase, "t-c");
  await mock(page, { tasks: {
    "": { items: [a, b], next_cursor: "t-b" },
    "t-b": { items: [b, c], next_cursor: "" },
  } });
  await openCatalog(page, 2);
  await loadMore(page).click();
  await expect(page.locator(".task-card")).toHaveCount(3);
  await expect(page.getByText("1 yinelenen kayıt yok sayıldı")).toBeVisible();
});

test("a server that repeats a cursor or returns nothing new stops paging instead of looping", async ({ page }) => {
  const a = await make(softwareBase, "t-a");
  const b = await make(softwareBase, "t-b");
  const c = await make(softwareBase, "t-c");
  const d = await make(softwareBase, "t-d");
  const { counts } = await mock(page, { tasks: {
    "": { items: [a, b], next_cursor: "t-b" },
    "t-b": { items: [c], next_cursor: "t-c" },
    "t-c": { items: [d], next_cursor: "t-b" },
  } });
  await openCatalog(page, 2);
  await loadMore(page).click();
  await expect(page.locator(".task-card")).toHaveCount(3);
  await loadMore(page).click();
  await expect(page.locator(".task-card")).toHaveCount(4);
  await expect(page.getByRole("alert").filter({ hasText: "sayfalama durduruldu" })).toBeVisible();
  await expect(loadMore(page)).toHaveCount(0);
  expect(counts).toEqual({ "": 1, "t-b": 1, "t-c": 1 });
});

test("a page with no new records but a cursor also stops paging", async ({ page }) => {
  const a = await make(softwareBase, "t-a");
  const b = await make(softwareBase, "t-b");
  await mock(page, { tasks: {
    "": { items: [a, b], next_cursor: "t-b" },
    "t-b": { items: [a, b], next_cursor: "t-x" },
  } });
  await openCatalog(page, 2);
  await loadMore(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "sayfalama durduruldu" })).toBeVisible();
  await expect(page.locator(".task-card")).toHaveCount(2);
  await expect(loadMore(page)).toHaveCount(0);
});

test("paging is bounded at 20 pages", async ({ page }) => {
  const pages: Record<string, Reply> = {};
  const all: Json[] = [];
  for (let i = 0; i < 22; i++) all.push(await make(softwareBase, `t-${String(i).padStart(2, "0")}`));
  for (let i = 0; i < 22; i++) pages[i === 0 ? "" : all[i - 1].id] = { items: [all[i]], next_cursor: all[i].id };
  const { counts } = await mock(page, { tasks: pages });
  await openCatalog(page, 1);
  for (let i = 2; i <= 20; i++) {
    await loadMore(page).click();
    await expect(page.locator(".task-card")).toHaveCount(i);
  }
  await expect(loadMore(page)).toHaveCount(0);
  await expect(page.getByText("en fazla 1000 kayıt ve 20 sayfayla sınırlıdır")).toBeVisible();
  expect(Object.keys(counts)).toHaveLength(20);
});

test("a later page over the page size bound is rejected and the loaded tasks stay", async ({ page }) => {
  const a = await make(softwareBase, "t-a");
  const extra = await make(softwareBase, "t-extra");
  await mock(page, { tasks: {
    "": { items: [a], next_cursor: "t-a" },
    "t-a": { items: Array.from({ length: 101 }, () => extra), next_cursor: "" },
  } });
  await openCatalog(page, 1);
  await loadMore(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "Sonraki kayıtlar yüklenemedi" })).toBeVisible();
  await expect(page.locator(".task-card")).toHaveCount(1);
});

test("an old load-more answer that arrives after a refresh is discarded", async ({ page }) => {
  const a = await make(softwareBase, "t-a");
  const b = await make(softwareBase, "t-b");
  const stale = await make(softwareBase, "t-stale", { title: "Stale page task" });
  const fresh = await make(softwareBase, "t-fresh", { title: "Fresh task" });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await mock(page, {
    tasks: { "t-b": { items: [stale], hold } },
    onTasks: (after, count) => after === "" ? (count === 1 ? { items: [a, b], next_cursor: "t-b" } : { items: [fresh] }) : undefined,
  });
  await openCatalog(page, 2);
  await loadMore(page).click();
  await expect(page.locator(".td-pager button")).toBeDisabled();
  await expect(page.locator(".td-pager button")).toHaveText("Yükleniyor…");
  await page.getByRole("button", { name: "Yenile", exact: true }).first().click();
  await expect(page.locator(".task-card")).toHaveCount(1);
  await expect(card(page, "Fresh task")).toBeVisible();
  release();
  await page.waitForTimeout(300);
  await expect(page.locator(".task-card")).toHaveCount(1);
  await expect(page.getByText("Stale page task")).toHaveCount(0);
  await expect(loadMore(page)).toHaveCount(0);
});

test("a failed next page keeps the loaded tasks, reports the error and retries the same cursor", async ({ page }) => {
  const a = await make(softwareBase, "t-a");
  const b = await make(softwareBase, "t-b");
  const c = await make(softwareBase, "t-c");
  const { requested } = await mock(page, {
    tasks: { "": { items: [a, b], next_cursor: "t-b" } },
    onTasks: (after, count) => after === "t-b" ? (count === 1 ? { status: 503 } : { items: [c] }) : undefined,
  });
  await openCatalog(page, 2);
  await loadMore(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "Sonraki kayıtlar yüklenemedi" })).toBeVisible();
  await expect(page.locator(".task-card")).toHaveCount(2);
  await page.getByRole("button", { name: /Tekrar dene/ }).click();
  await expect(page.locator(".task-card")).toHaveCount(3);
  expect(requested.filter((r) => r === "/api/v1/tasks?after=t-b")).toHaveLength(2);
});

test("a 401 on the next page clears the catalog and asks to sign in", async ({ page }) => {
  const a = await make(softwareBase, "t-a");
  const b = await make(softwareBase, "t-b");
  await mock(page, {
    tasks: { "": { items: [a, b], next_cursor: "t-b" }, "t-b": { status: 401 } },
  });
  await openCatalog(page, 2);
  await loadMore(page).click();
  await expect(page.getByRole("alert")).toContainText("giriş yap");
  await expect(page.locator(".task-card")).toHaveCount(0);
  await expect(page.getByTestId("task-dependencies")).toHaveCount(0);
});

test("503 on the first page shows the retry state", async ({ page }) => {
  await mock(page, { tasks: { "": { status: 503 } } });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Görevler yüklenemedi");
  await expect(page.locator(".task-card")).toHaveCount(0);
});

test("an id that is not in a fully loaded catalog is reported as absent", async ({ page }) => {
  const a = await make(softwareBase, "t-a", { depends_on: ["t-missing", "t-b"] });
  const b = await make(softwareBase, "t-b");
  await mock(page, { tasks: { "": { items: [a, b] } } });
  await openCatalog(page, 2);
  const absent = panel(page).locator("[data-relation-state=absent]");
  await expect(absent).toContainText("t-missing");
  await expect(absent).toContainText("Katalogda bulunamadı");
  await expect(absent.getByRole("button")).toHaveCount(0);
  await expect(panel(page).locator("[data-relation-state=visible]")).toHaveCount(1);
  await expect(panel(page)).toContainText("çalıştırma yetkisi vermez");
  await expect(page.getByRole("button", { name: "Görevi başlat", exact: true })).toBeDisabled();
});

test("English labels, dependents and a 780px layout without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 780, height: 1000 });
  const base = await make(softwareBase, "t-base", { title: "Base task with a rather long title that must wrap on narrow screens without breaking the layout" });
  const dependents: Json[] = [];
  for (let i = 0; i < 6; i++) dependents.push(await make(softwareBase, `t-dep-${i}`, { depends_on: ["t-base"], title: `Dependent ${i} ` + "long ".repeat(20) }));
  await mock(page, { tasks: { "": { items: [base, ...dependents], statuses: { "t-base": "accepted" } } } });
  await openCatalog(page, 7);
  await page.getByRole("button", { name: "Change language" }).click();
  await expect(page.getByLabel("Filter by status")).toBeVisible();
  await expect(card(page, "Base task").locator(".td-status")).toHaveText("Accepted");
  await card(page, "Base task").click();
  await expect(panel(page)).toContainText("Tasks that depend on this (6)");
  await expect(panel(page).locator("[data-relation-state=visible]")).toHaveCount(6);
  await expect(panel(page)).toContainText("grants no permission to run tasks");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel(page).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
