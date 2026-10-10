import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const operation = {identity: {owner: "a0000000-0000-4000-8000-000000000001", provider: "codex", operation: "a0000000-0000-4000-8000-000000000002"}, last_sequence: 4, last_hash: "a".repeat(64), status: "needs_review", pending_count: 1, recorded_namespace_count: 1, durability: "process_crash"};
const envelope = {status: "available", execution_enabled: false, automatic_recovery: false, worker_quiescence: "unknown", daemon_state: "unknown", operations: [operation]};
test("historical operation observations produce only revision-bound inspect requests", async ({page}) => {
  let revision = 4;
  await page.route("**/local-operation-status", route => route.fulfill({json: {...envelope, operations: [{...operation, last_sequence: revision}]}}));
  await page.goto("/"); await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  await expect(page.getByText("Görev başlatma ve otomatik kurtarma kapalı.", {exact: false})).toBeVisible();
  await page.getByRole("button", {name: "İnceleme isteğini göster"}).click();
  await expect(page.getByTestId("operation-review-request")).toContainText('"expected_sequence": 4');
  await expect(page.getByTestId("operation-review-request")).toContainText('"action": "inspect_only"');
  revision = 5;
  await page.getByRole("button", {name: "İşlem kayıtlarını yenile"}).click();
  await expect(page.getByTestId("operation-review-request")).toHaveCount(0);
  await page.getByRole("button", {name: "İnceleme isteğini göster"}).click();
  await expect(page.getByTestId("operation-review-request")).toContainText('"expected_sequence": 5');
  await mkdir(".local/recovery-ui", {recursive: true});
  await page.locator(".operation-recovery").screenshot({path: ".local/recovery-ui/recovery-panel-1440.png"});
  await page.setViewportSize({width: 390, height: 1100});
  await page.locator(".operation-recovery").screenshot({path: ".local/recovery-ui/recovery-panel-390.png"});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", {name: "Change language"}).click();
  await expect(page.getByRole("heading", {name: "Local operation journal"})).toBeVisible();
  await expect(page.getByText("Worker and Docker states are unknown.", {exact: false})).toBeVisible();
});
test("HTTP failure rejects even a valid observation body", async ({page}) => {
  await page.route("**/local-operation-status", route => route.fulfill({status: 503, json: envelope}));
  await page.goto("/"); await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  await expect(page.getByRole("alert")).toContainText("İşlem kayıtları doğrulanamadı");
  await expect(page.getByRole("button", {name: "İnceleme isteğini göster"})).toHaveCount(0);
});
test("missing journal is unavailable and invalid response hides all rows", async ({page}) => {
  let invalid = false;
  await page.route("**/local-operation-status", route => route.fulfill({json: invalid ? {...envelope, execution_enabled: true, secret: "private/auth"} : {...envelope, status: "unavailable", reason: "operation_journal_missing", operations: []}}));
  await page.goto("/"); await page.getByRole("button", {name: "Ajanlar ve ortam", exact: true}).click();
  await expect(page.getByText("Yerel işlem günlüğü kullanılamıyor.", {exact: true})).toBeVisible();
  invalid = true; await page.getByRole("button", {name: "İşlem kayıtlarını yenile"}).click();
  await expect(page.getByRole("alert")).toContainText("İşlem kayıtları doğrulanamadı");
  await expect(page.getByRole("button", {name: "İnceleme isteğini göster"})).toHaveCount(0);
  await expect(page.getByText("private/auth")).toHaveCount(0);
});
