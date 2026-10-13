import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";

const catalog = JSON.parse(readFileSync(path.join(process.cwd(), "services/coordinator/internal/catalog/catalog.json"), "utf8"));
const firstTask = catalog.tasks[0];
const secondTask = catalog.tasks[1];
const HASH = "a1".repeat(32);
const ARTIFACT_HASH = "b2".repeat(32);
const COMMIT = "c3".repeat(20);
const signedIn = { authenticated: true, user: { id: "user-one", display_name: "Ada Yılmaz", provider: "github" }, csrf_token: "csrf-value", expires_at: "2099-01-01T00:00:00Z" };
type Json = Record<string, unknown>;
type Reply = { status?: number; json?: unknown; hold?: Promise<void>; code?: string };

function lease(over: Json = {}) {
  return { id: "lease-one", attempt_id: "attempt-one", user_id: "user-one", task_id: firstTask.id, task_version: 1, contract_hash: firstTask.contract_hash, strategy_id: "induction", state: "active", effective_limit_sec: 3600, reserved_ms: 4_320_000, spent_ms: 90_500, overrun_ms: 0, created_at: "2026-10-08T08:00:00Z", expires_at: "2026-10-08T09:00:00Z", started_at: "2026-10-08T08:01:00Z", ...over };
}
function submission(over: Json = {}) {
  return { id: "submission-one", lease_id: "lease-one", user_id: "user-one", task_id: firstTask.id, task_version: 1, contract_hash: firstTask.contract_hash, base_commit: COMMIT, artifact: { id: "artifact-one", sha256: ARTIFACT_HASH, size_bytes: 2048 }, status: "verified_candidate", created_at: "2026-10-08T08:30:00Z", verified_at: "2026-10-08T08:35:00Z", ...over };
}
function checkpoint(id: string, over: Json = {}, meta: Json = {}) {
  return {
    metadata: { schema_version: "1.0", checkpoint_id: id, task_id: firstTask.id, task_version: 1, contract_hash: firstTask.contract_hash, lease_id: "lease-one", type: "hard", base_commit: COMMIT, summary: `Summary of ${id}`, continuation_instructions: `Continue ${id} from the saved lemma.`, artifact_sha256: ARTIFACT_HASH, ...meta },
    artifact: { id: `artifact-${id}`, sha256: ARTIFACT_HASH, size_bytes: 4096 }, status: "usable", created_at: "2026-10-08T08:00:00Z", expires_at: "2099-10-15T08:00:00Z", verified_at: "2026-10-08T08:10:00Z", ...over,
  };
}

type Options = { lists?: Partial<Record<"leases" | "submissions" | "checkpoints", unknown[]>>; details?: Record<string, Reply>; resume?: (url: URL) => Reply | Promise<Reply> };
async function mock(page: Page, options: Options = {}) {
  const requested: string[] = [];
  const state = { user: { ...signedIn }, details: { ...(options.details ?? {}) }, resume: options.resume };
  const lists = { leases: [lease()], submissions: [submission()], checkpoints: [checkpoint("checkpoint-one")], ...(options.lists ?? {}) };
  const reply = async (route: Route, r: Reply) => {
    if (r.hold) await r.hold;
    if (r.json === undefined) return route.fulfill({ status: r.status ?? 500, json: { code: r.code ?? "internal_error" } }).catch(() => {});
    return route.fulfill({ status: r.status ?? 200, json: r.json }).catch(() => {});
  };
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    requested.push(p + url.search);
    if (p === "/api/v1/auth/providers") return route.fulfill({ json: { providers: [{ id: "github", enabled: true }, { id: "google", enabled: false }] } });
    if (p === "/api/v1/auth/session") return route.fulfill({ json: state.user.csrf_token ? state.user : { authenticated: false } });
    if (p === "/api/v1/auth/logout") { state.user = { ...state.user, csrf_token: "" }; return route.fulfill({ status: 204 }); }
    if (p === "/api/v1/projects") return route.fulfill({ json: { source: "database", execution_enabled: false, items: catalog.projects } });
    if (p === "/api/v1/tasks") return route.fulfill({ json: { source: "database", execution_enabled: false, items: catalog.tasks, statuses: {} } });
    const list = /^\/api\/v1\/me\/(leases|submissions|checkpoints)$/.exec(p);
    if (list) return route.fulfill({ json: { source: "database", execution_enabled: false, items: lists[list[1] as keyof typeof lists], next_cursor: "" } });
    const resume = /^\/api\/v1\/tasks\/([^/]+)\/resume$/.exec(p);
    if (resume) return reply(route, state.resume ? await state.resume(url) : { status: 404, code: "not_found" });
    const detail = /^\/api\/v1\/(leases|submissions|checkpoints)\/([^/]+)$/.exec(p);
    if (detail) {
      const configured = state.details[`${detail[1]}/${detail[2]}`];
      if (configured) return reply(route, configured);
      const source = lists[detail[1] as keyof typeof lists] as Json[];
      const found = source.find((item) => (item.id ?? (item.metadata as Json).checkpoint_id) === detail[2]);
      return reply(route, found ? { json: { source: "database", execution_enabled: false, item: found } } : { status: 404, code: "not_found" });
    }
    return route.fulfill({ status: 404, json: { code: "not_found" } });
  });
  return { requested, state };
}
const nav = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });
async function openContributions(page: Page, section?: "Gönderilen sonuçlar" | "Kaydedilen ilerleme") {
  await page.goto("/");
  await expect(page.locator(".task-card")).toHaveCount(catalog.tasks.length);
  await nav(page).getByRole("button", { name: "Katkılarım", exact: true }).click();
  if (section) await page.getByRole("button", { name: section, exact: true }).click();
  await expect(page.locator(".receipt-card")).not.toHaveCount(0);
}
const panel = (page: Page) => page.locator("#contribution-detail");

test("an attempt opens with strategy, state and time capacity that is not presented as money or tokens", async ({ page }) => {
  const { requested } = await mock(page);
  await openContributions(page);
  await expect(panel(page)).toHaveCount(0);
  await page.locator(".receipt-open").first().click();
  await expect(panel(page).getByRole("heading", { name: "Deneme ayrıntıları" })).toBeVisible();
  await expect(panel(page)).toContainText("induction");
  await expect(panel(page)).toContainText("Devam ediyor");
  await expect(panel(page)).toContainText("attempt-one");
  await expect(panel(page)).toContainText("Etkin süre sınırı1 sa");
  await expect(panel(page)).toContainText("Ayrılan süre1 sa 12 dk");
  await expect(panel(page)).toContainText("Kullanılan süre1 dk 30 sn");
  await expect(panel(page)).toContainText("Aşım0 ms");
  await expect(panel(page)).toContainText("para, token veya abonelik kotası değildir");
  await expect(panel(page)).not.toContainText("user-one");
  expect(requested).toContain("/api/v1/leases/lease-one");
});

test("a submission shows verification and artifact receipt without offering artifact content or approval", async ({ page }) => {
  const { requested } = await mock(page);
  await openContributions(page, "Gönderilen sonuçlar");
  await page.locator(".receipt-open").first().click();
  await expect(panel(page).getByRole("heading", { name: "Gönderim ayrıntıları" })).toBeVisible();
  await expect(panel(page)).toContainText("Doğrulandı, inceleme bekliyor");
  await expect(panel(page)).toContainText("artifact-one");
  await expect(panel(page)).toContainText(ARTIFACT_HASH);
  await expect(panel(page)).toContainText(COMMIT);
  await expect(panel(page)).toContainText("makbuzudur");
  await expect(panel(page)).toContainText("Kabul zamanıHenüz yok");
  await expect(panel(page).getByRole("link")).toHaveCount(0);
  expect(requested.some((entry) => entry.includes("/artifacts"))).toBe(false);
});

test("checkpoint states are shown as the server reports them and expiry is derived only from expires_at", async ({ page }) => {
  const records = [
    checkpoint("cp-submitted", { status: "submitted", verified_at: undefined }),
    checkpoint("cp-verifying", { status: "verifying", verified_at: undefined }),
    checkpoint("cp-usable", {}, { parent_checkpoint_id: "cp-submitted" }),
    checkpoint("cp-rejected", { status: "rejected", reason_code: "secret_detected" }),
    checkpoint("cp-expired", { expires_at: "2020-01-01T00:00:00Z" }),
  ];
  await mock(page, { lists: { checkpoints: records } });
  await openContributions(page, "Kaydedilen ilerleme");
  const open = async (id: string) => { await page.locator(".receipt-card").nth(records.findIndex((r) => r.metadata.checkpoint_id === id)).locator(".receipt-open").click(); };
  await open("cp-submitted");
  await expect(panel(page)).toContainText("Doğrulama durumuGönderildi");
  await expect(panel(page)).toContainText("Henüz doğrulanmadı");
  await expect(panel(page)).toContainText("Yok (ilk kayıt)");
  await open("cp-verifying");
  await expect(panel(page)).toContainText("Doğrulama durumuDoğrulanıyor");
  await open("cp-usable");
  await expect(panel(page)).toContainText("Doğrulama durumuDevam için hazır");
  await expect(panel(page)).toContainText("cp-submitted");
  await expect(panel(page)).toContainText(firstTask.id);
  await expect(panel(page)).toContainText(firstTask.contract_hash);
  await expect(panel(page)).toContainText(COMMIT);
  await expect(panel(page)).toContainText("Summary of cp-usable");
  await expect(panel(page)).toContainText("Continue cp-usable from the saved lemma.");
  await expect(page.getByTestId("checkpoint-expired")).toHaveCount(0);
  await open("cp-rejected");
  await expect(panel(page)).toContainText("Doğrulama durumuReddedildi");
  await expect(panel(page)).toContainText("Red nedeniGizli bilgi bulundu");
  await open("cp-expired");
  await expect(panel(page)).toContainText("Doğrulama durumuDevam için hazır");
  await expect(page.getByTestId("checkpoint-expired")).toContainText("Son kullanma tarihi geçti");
  await expect(panel(page)).not.toContainText("Süresi doldu");
});

test("missing checkpoint text and reason are shown as unknown instead of invented", async ({ page }) => {
  await mock(page, { lists: { checkpoints: [checkpoint("cp-bare", { status: "rejected", verified_at: undefined }, { summary: "", continuation_instructions: "" })] } });
  await openContributions(page, "Kaydedilen ilerleme");
  await page.locator(".receipt-open").first().click();
  await expect(panel(page)).toContainText("Özet kaydedilmemiş.");
  await expect(panel(page)).toContainText("Devam talimatı kaydedilmemiş.");
  await expect(panel(page)).toContainText("Red nedeniBilinmiyor");
  await expect(panel(page)).toContainText("Doğrulama zamanıBilinmiyor");
});

test("HTML-like summaries stay plain text", async ({ page }) => {
  const markup = `<img src=x onerror="window.__pwned=1"><b>bold</b><script>window.__pwned=2</script>`;
  await mock(page, { lists: { checkpoints: [checkpoint("cp-html", {}, { summary: markup, continuation_instructions: `<a href="https://example.invalid">link</a>` })] } });
  await openContributions(page, "Kaydedilen ilerleme");
  await page.locator(".receipt-open").first().click();
  await expect(page.getByTestId("checkpoint-summary")).toHaveText(markup);
  await expect(page.getByTestId("checkpoint-instructions")).toHaveText(`<a href="https://example.invalid">link</a>`);
  await expect(panel(page).locator("img, b, script, a")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test("checkpoint text uses the server's Unicode character limits", async ({ page }) => {
  const summary = "😀".repeat(4000);
  const instructions = "🧭".repeat(12001);
  await mock(page, { lists: { checkpoints: [checkpoint("cp-unicode", {}, { summary, continuation_instructions: instructions })] } });
  await openContributions(page, "Kaydedilen ilerleme");
  await page.locator(".receipt-open").first().click();
  await expect(page.getByTestId("checkpoint-summary")).toHaveText(summary);
  await expect(page.getByTestId("checkpoint-instructions")).toHaveText(instructions);
});

test("resume check sends the selected validated task and strategy and shows the server answer without assuming", async ({ page }) => {
  const seen: URL[] = [];
  await mock(page, { lists: { checkpoints: [checkpoint("cp-opened")] }, resume: (url) => { seen.push(url); return { json: { source: "database", execution_enabled: false, item: checkpoint("cp-other", {}, { summary: "Server latest", base_commit: firstTask.workspace.commit }) } }; } });
  await openContributions(page, "Kaydedilen ilerleme");
  await page.locator(".receipt-open").first().click();
  await expect(panel(page)).toContainText("Uyumlu son kayıt kontrolü");
  await expect(panel(page)).toContainText(firstTask.title);
  await expect(panel(page)).toContainText("salt okunur sorgular");
  expect(seen).toHaveLength(0);
  await panel(page).getByRole("button", { name: "Uyumlu kaydı kontrol et" }).click();
  await expect(page.getByTestId("resume-record")).toContainText("Server latest");
  await expect(panel(page)).toContainText("farklı bir kayıt");
  expect(seen).toHaveLength(1);
  expect(seen[0].pathname).toBe(`/api/v1/tasks/${firstTask.id}/resume`);
  expect(Object.fromEntries(seen[0].searchParams)).toEqual({ task_version: "1", contract_hash: firstTask.contract_hash, base_commit: firstTask.workspace.commit, strategy_id: "induction" });
  await expect(panel(page).getByRole("button", { name: /devam ettir|başlat/i })).toHaveCount(0);
});

test("a chosen strategy in the workspace is the one checked, and a stale answer is dropped when the page is left", async ({ page }) => {
  const seen: URL[] = [];
  await mock(page, { lists: { checkpoints: [checkpoint("cp-soft", {}, { task_id: secondTask.id, contract_hash: secondTask.contract_hash, base_commit: secondTask.workspace.commit })] }, resume: (url) => { seen.push(url); return { status: 404, code: "not_found" }; } });
  await page.goto("/");
  await page.locator(".task-card", { hasText: secondTask.title }).click();
  await page.locator("#strategy").selectOption("boundary-first");
  await nav(page).getByRole("button", { name: "Katkılarım", exact: true }).click();
  await page.getByRole("button", { name: "Kaydedilen ilerleme", exact: true }).click();
  await page.locator(".receipt-open").first().click();
  await panel(page).getByRole("button", { name: "Uyumlu kaydı kontrol et" }).click();
  await expect(panel(page)).toContainText("uyumlu, kullanılabilir bir kayıtlı ilerleme bulamadı");
  expect(seen[0].searchParams.get("strategy_id")).toBe("boundary-first");
  expect(seen[0].pathname).toBe(`/api/v1/tasks/${secondTask.id}/resume`);
  await nav(page).getByRole("button", { name: /^Çalışma alanı/ }).click();
  await nav(page).getByRole("button", { name: "Katkılarım", exact: true }).click();
  await page.getByRole("button", { name: "Kaydedilen ilerleme", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
});

test("a checkpoint of another task cannot be checked against the selected task", async ({ page }) => {
  const { requested } = await mock(page, { lists: { checkpoints: [checkpoint("cp-elsewhere", {}, { task_id: secondTask.id })] } });
  await openContributions(page, "Kaydedilen ilerleme");
  await page.locator(".receipt-open").first().click();
  await expect(panel(page)).toContainText("başka bir göreve ait");
  await expect(panel(page).getByRole("button", { name: "Uyumlu kaydı kontrol et" })).toHaveCount(0);
  expect(requested.some((entry) => entry.includes("/resume"))).toBe(false);
});

test("resume 503, 409 and a malformed answer have distinct messages from no compatible record", async ({ page }) => {
  let reply: Reply = { status: 503, code: "authentication_unavailable" };
  await mock(page, { resume: () => reply });
  await openContributions(page, "Kaydedilen ilerleme");
  await page.locator(".receipt-open").first().click();
  const check = panel(page).getByRole("button", { name: "Uyumlu kaydı kontrol et" });
  await check.click();
  await expect(panel(page)).toContainText("geçici olarak yanıt vermiyor");
  reply = { status: 409, code: "stale_contract" };
  await panel(page).getByRole("button", { name: "Tekrar dene" }).click();
  await expect(panel(page)).toContainText("görev sürümü veya sözleşmesi değişmiş");
  reply = { status: 409, code: "lease_or_task_closed" };
  await check.click();
  await expect(panel(page)).toContainText("kayıttan devam etmeyi şu anda sunmuyor");
  reply = { json: { item: checkpoint("cp-bad", {}, { task_id: secondTask.id }) } };
  await check.click();
  await expect(panel(page)).toContainText("Kontrol tamamlanamadı");
  await expect(page.getByTestId("resume-record")).toHaveCount(0);
  reply = { status: 404, code: "not_found" };
  await check.click();
  await expect(panel(page)).toContainText("bulamadı");
});

test("401 on a detail or a resume check clears private account data", async ({ page }) => {
  await mock(page, { details: { "leases/lease-one": { status: 401, code: "unauthenticated" } } });
  await openContributions(page);
  await page.locator(".receipt-open").first().click();
  await expect(page.getByRole("alert")).toContainText("Oturumun sona erdi");
  await expect(page.getByTestId("account-name")).toHaveCount(0);
  await expect(page.locator(".receipt-card")).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("attempt-one");

  const second = await page.context().newPage();
  await mock(second, { resume: () => ({ status: 401, code: "unauthenticated" }) });
  await openContributions(second, "Kaydedilen ilerleme");
  await second.locator(".receipt-open").first().click();
  await panel(second).getByRole("button", { name: "Uyumlu kaydı kontrol et" }).click();
  await expect(second.getByRole("alert")).toContainText("Oturumun sona erdi");
  await expect(second.locator(".receipt-card")).toHaveCount(0);
  await expect(second.locator("body")).not.toContainText("cp-");
});

test("404 and 503 details are distinct, and retry recovers", async ({ page }) => {
  const { state } = await mock(page, { lists: { leases: [lease(), lease({ id: "lease-gone" })] }, details: { "leases/lease-one": { status: 503, code: "authentication_unavailable" }, "leases/lease-gone": { status: 404, code: "not_found" } } });
  await openContributions(page);
  await page.locator(".receipt-open").nth(0).click();
  await expect(panel(page).getByRole("alert")).toContainText("geçici olarak yanıt vermiyor");
  delete state.details["leases/lease-one"];
  await panel(page).getByRole("button", { name: "Tekrar dene" }).click();
  await expect(panel(page)).toContainText("attempt-one");
  await page.locator(".receipt-open").nth(1).click();
  await expect(panel(page).getByRole("alert")).toContainText("bulunamadı veya bu hesapta görüntülenemiyor");
  await expect(panel(page).getByRole("button", { name: "Tekrar dene" })).toHaveCount(0);
});

test("malformed hashes, dates, numbers or a different record id are rejected, not displayed", async ({ page }) => {
  const bad: Record<string, Reply> = {
    "leases/l-date": { json: { item: lease({ id: "l-date", created_at: "not a date" }) } },
    "leases/l-num": { json: { item: lease({ id: "l-num", spent_ms: -5 }) } },
    "leases/l-id": { json: { item: lease({ id: "someone-else" }) } },
    "submissions/s-hash": { json: { item: submission({ id: "s-hash", artifact: { id: "artifact-one", sha256: "XYZ", size_bytes: 10 } }) } },
    "submissions/s-commit": { json: { item: submission({ id: "s-commit", base_commit: "abc" }) } },
    "checkpoints/c-hash": { json: { item: checkpoint("c-hash", {}, { contract_hash: "not-a-hash" }) } },
    "checkpoints/c-mismatch": { json: { item: checkpoint("c-mismatch", {}, { artifact_sha256: "d4".repeat(32) }) } },
    "checkpoints/c-envelope": { json: checkpoint("c-envelope") },
  };
  await mock(page, {
    lists: { leases: ["l-date", "l-num", "l-id"].map((id) => lease({ id })), submissions: ["s-hash", "s-commit"].map((id) => submission({ id })), checkpoints: ["c-hash", "c-mismatch", "c-envelope"].map((id) => checkpoint(id)) },
    details: bad,
  });
  await openContributions(page);
  for (let index = 0; index < 3; index++) {
    await page.locator(".receipt-open").nth(index).click();
    await expect(panel(page).getByRole("alert")).toContainText("Kayıt ayrıntıları yüklenemedi");
    await expect(panel(page)).not.toContainText("Etkin süre sınırı");
  }
  await page.getByRole("button", { name: "Gönderilen sonuçlar", exact: true }).click();
  for (let index = 0; index < 2; index++) {
    await page.locator(".receipt-open").nth(index).click();
    await expect(panel(page).getByRole("alert")).toContainText("yüklenemedi");
    await expect(panel(page)).not.toContainText("artifact-one");
  }
  await page.getByRole("button", { name: "Kaydedilen ilerleme", exact: true }).click();
  for (let index = 0; index < 3; index++) {
    await page.locator(".receipt-open").nth(index).click();
    await expect(panel(page).getByRole("alert")).toContainText("yüklenemedi");
    await expect(panel(page)).not.toContainText("Summary of");
  }
});

test("a late answer for a previous record, section or account is never shown", async ({ page }) => {
  let releaseOne!: () => void;
  const holdOne = new Promise<void>((resolve) => { releaseOne = resolve; });
  let releaseSection!: () => void;
  const holdSection = new Promise<void>((resolve) => { releaseSection = resolve; });
  await mock(page, {
    lists: { leases: [lease(), lease({ id: "lease-two", attempt_id: "attempt-two" })] },
    details: {
      "leases/lease-one": { hold: holdOne, json: { item: lease({ attempt_id: "attempt-late-one" }) } },
      "leases/lease-two": { json: { item: lease({ id: "lease-two", attempt_id: "attempt-two" }) } },
      "submissions/submission-one": { hold: holdSection, json: { item: submission({ artifact: { id: "artifact-late", sha256: ARTIFACT_HASH, size_bytes: 5 } }) } },
    },
  });
  await openContributions(page);
  await page.locator(".receipt-open").nth(0).click();
  await expect(panel(page)).toContainText("Ayrıntılar yükleniyor");
  await page.locator(".receipt-open").nth(1).click();
  await expect(panel(page)).toContainText("attempt-two");
  releaseOne();
  await page.waitForTimeout(150);
  await expect(panel(page)).toContainText("attempt-two");
  await expect(page.locator("body")).not.toContainText("attempt-late-one");

  await page.getByRole("button", { name: "Gönderilen sonuçlar", exact: true }).click();
  await page.locator(".receipt-open").first().click();
  await expect(panel(page)).toContainText("Ayrıntılar yükleniyor");
  await page.getByRole("button", { name: "Kaydedilen ilerleme", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  releaseSection();
  await page.waitForTimeout(150);
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("artifact-late");
});

test("a late detail cannot return after sign out", async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await mock(page, { details: { "leases/lease-one": { hold, json: { item: lease({ attempt_id: "attempt-private" }) } } } });
  await openContributions(page);
  await page.locator(".receipt-open").first().click();
  await expect(panel(page)).toContainText("Ayrıntılar yükleniyor");
  await page.getByRole("button", { name: "Çıkış yap", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Katkı kayıtlarını görmek için hesabına giriş yap." })).toBeVisible();
  release();
  await page.waitForTimeout(150);
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("attempt-private");
});

test("the detail panel is keyboard operable and focus returns to the record on close", async ({ page }) => {
  await mock(page);
  await openContributions(page);
  const record = page.locator(".receipt-open").first();
  await record.focus();
  await expect(record).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeFocused();
  await expect(record).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(panel(page).getByRole("button", { name: "Ayrıntıları kapat" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(panel(page)).toHaveCount(0);
  await expect(record).toBeFocused();
  await page.keyboard.press("Space");
  await expect(panel(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(record).toBeFocused();
});

test("Turkish and English labels follow the language switch", async ({ page }) => {
  await mock(page, { lists: { checkpoints: [checkpoint("cp-lang")] } });
  await openContributions(page, "Kaydedilen ilerleme");
  await page.locator(".receipt-open").first().click();
  await expect(panel(page).getByRole("heading", { name: "Kayıtlı ilerleme ayrıntıları" })).toBeVisible();
  await expect(panel(page)).toContainText("Devam talimatları");
  await page.getByRole("button", { name: "Change language" }).click();
  await expect(panel(page).getByRole("heading", { name: "Saved progress details" })).toBeVisible();
  await expect(panel(page)).toContainText("Continuation instructions");
  await expect(panel(page)).toContainText("Verification statusReady to continue");
  await expect(panel(page)).toContainText("None (first checkpoint)");
  await expect(panel(page).getByRole("button", { name: "Check for a compatible record" })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Close details" })).toBeVisible();
  await page.getByRole("button", { name: "Attempts", exact: true }).click();
  await page.locator(".receipt-open").first().click();
  await expect(panel(page)).toContainText("These values are scheduled run-time capacity, not money, tokens or a subscription quota.");
  await expect(panel(page)).toContainText("Reserved time1 h 12 min");
});

test("long values fit a phone width and the panel stays within the viewport", async ({ page }) => {
  const long = "word".repeat(900);
  await mock(page, { lists: { checkpoints: [checkpoint("cp-long", {}, { summary: long, continuation_instructions: long })] } });
  await page.setViewportSize({ width: 390, height: 850 });
  await openContributions(page, "Kaydedilen ilerleme");
  await page.locator(".receipt-open").first().click();
  await expect(panel(page)).toContainText(ARTIFACT_HASH);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1050 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a resume answer that arrives after the panel was closed or changed is not shown", async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  await mock(page, { lists: { checkpoints: [checkpoint("cp-one"), checkpoint("cp-two")] }, resume: () => { calls++; return { hold, json: { item: checkpoint("cp-late", {}, { summary: "Late answer", base_commit: firstTask.workspace.commit }) } }; } });
  await openContributions(page, "Kaydedilen ilerleme");
  await page.locator(".receipt-open").nth(0).click();
  await panel(page).getByRole("button", { name: "Uyumlu kaydı kontrol et" }).click();
  await expect(panel(page)).toContainText("Sunucu kontrol ediliyor");
  await page.locator(".receipt-open").nth(1).click();
  await expect(panel(page)).toContainText("Summary of cp-two");
  release();
  await page.waitForTimeout(150);
  expect(calls).toBe(1);
  await expect(page.locator("body")).not.toContainText("Late answer");
  await expect(page.getByTestId("resume-record")).toHaveCount(0);
});
