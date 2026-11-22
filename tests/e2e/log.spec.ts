/** AT-E for Cycle 5: the execution log on the screen and as a download holds codes and digests, never values. */
import { readFileSync } from "node:fs";
import { expect, test } from "./egress";

test("a rejected file is logged by stage and code, and the downloaded log holds no value or file name", async ({ page }) => {
  await page.goto("/#import");
  await page.getByLabel("Sample files").selectOption({ label: "ERP value with a decimal comma" });
  await page.getByRole("button", { name: "Import sample" }).click();
  await expect(page.getByTestId("import-error")).toHaveAttribute("data-code", "decimal-comma");

  const log = page.getByTestId("execution-log");
  await log.locator("summary").click();
  const entry = log.locator('[data-testid="log-entry"][data-event="import-rejected"]');
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("decimal-comma");
  await expect(entry).toContainText("semantics");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-log").click()]);
  const text = readFileSync(await download.path(), "utf8");
  const doc = JSON.parse(text);
  expect(doc.entries[0]).toMatchObject({ seq: 1, event: "import-rejected", stage: "semantics", code: "decimal-comma", fileRole: "erp", outcome: "rejected" });
  const csv = readFileSync("fixtures/n/erp-decimal-comma.csv", "utf8");
  for (const cell of csv.split(/\r?\n/).flatMap((l) => l.split(";")).filter((c) => c.length >= 3)) expect(new RegExp(`(?<![\\w.-])${cell.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(text), `"${cell}" is in the log`).toBe(false);
  expect(text).not.toContain("erp-decimal-comma");
});

test("the log keeps what happened across screens and survives a reload", async ({ page }) => {
  await page.goto("/#outputs");
  await page.getByRole("button", { name: "Load record state" }).click();
  await expect(page.getByTestId("outputs-record")).toBeVisible();
  const log = page.getByTestId("execution-log");
  await log.locator("summary").click();
  await expect(log.locator('[data-testid="log-entry"][data-event="import-accepted"]').first()).toBeVisible();
  await expect(log.locator('[data-testid="log-entry"][data-event="output-made"]').first()).toBeVisible();
  await expect(log.locator('[data-testid="log-entry"][data-event="release"]').first()).toBeVisible();
  await page.reload();
  await page.getByTestId("execution-log").locator("summary").click();
  await expect(page.locator('[data-testid="log-entry"][data-event="release"]').first()).toBeVisible();
});
