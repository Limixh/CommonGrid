import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
// The served catalog is the coordinator fixture: counts follow it instead of a hard-coded number of cards.
const catalog = JSON.parse(readFileSync(path.join(process.cwd(), "services/coordinator/internal/catalog/catalog.json"), "utf8"));
const total: number = catalog.tasks.length;
const softwareTotal: number = catalog.tasks.filter((task: { type: string }) => task.type === "software").length;
test("loads verified contracts, filters tasks and displays immutable JSON", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("/");
  await expect(page.getByText("Koordinatör bağlı")).toBeVisible();
  await expect(page.locator(".task-card")).toHaveCount(total);
  await page.getByRole("button", { name: `Yazılım ${softwareTotal}`, exact: true }).click();
  await expect(page.locator(".task-card")).toHaveCount(softwareTotal);
  await expect(
    page.getByRole("button", { name: "Görevi başlat", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Sözleşme", exact: true }).click();
  await expect(page.getByTestId("contract-json")).toContainText(
    "contract_hash",
  );
  await page
    .getByRole("textbox", { name: "Görevlerde ara…" })
    .fill("not-found");
  await expect(
    page.getByText("Bu filtrelerle eşleşen görev bulunamadı."),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("local budget settings survive reload and reject overspending", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Katkı ayarları", exact: true })
    .click();
  await page.getByLabel("Tek deneme (dakika)").fill("50");
  await page.getByLabel("Günlük aktif süre (dakika)").fill("40");
  await page.getByRole("button", { name: "Tercihleri kaydet" }).click();
  await expect(page.getByRole("status")).toContainText("günlük bütçeyi aşamaz");
  await page.getByLabel("Günlük aktif süre (dakika)").fill("100");
  await page.getByRole("button", { name: "Tercihleri kaydet" }).click();
  await expect(page.getByRole("status")).toContainText("kaydedildi");
  await page.reload();
  await page
    .getByRole("button", { name: "Katkı ayarları", exact: true })
    .click();
  await expect(page.getByLabel("Tek deneme (dakika)")).toHaveValue("50");
});
test("locale persists and API failure has an explicit retry state", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Change language" }).click();
  await expect(
    page.getByRole("heading", { name: "Be part of the solution." }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Contribution settings", exact: true }),
  ).toBeVisible();
  await page.route("**/api/v1/tasks", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Tasks could not load");
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }).last(),
  ).toBeVisible();
});
test("workspace fits narrow screen without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 780, height: 1000 });
  await page.goto("/");
  await expect(page.locator(".task-card")).toHaveCount(total);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
