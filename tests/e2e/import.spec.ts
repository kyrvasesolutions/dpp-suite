/** AT-E for Cycle 2: imports through the UI and checks the statuses the Import screen shows. */
import { expect, test } from "./egress";

test.beforeEach(async ({ page }) => {
  await page.goto("/#import");
});

const importSample = async (page: import("@playwright/test").Page, label: string) => {
  await page.getByLabel("Sample files").selectOption({ label });
  await page.getByRole("button", { name: "Import sample" }).click();
};

test("a clean pair is accepted through every stage and builds one record", async ({ page }) => {
  await importSample(page, "Clean pair");
  await expect(page.getByTestId("import-erp")).toHaveAttribute("data-ok", "true");
  await expect(page.getByTestId("import-lab")).toHaveAttribute("data-ok", "true");
  await expect(page.getByTestId("import-erp").locator('[data-state="passed"]')).toHaveCount(5);
  await expect(page.getByTestId("record-digest")).toHaveCount(1);
  await expect(page.locator('[data-testid="record-value"][data-status="challenged"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="record-value"][data-status="agreeing"]')).toHaveCount(3);
});

test("disagreeing sources show one challenged value with both assertions", async ({ page }) => {
  await importSample(page, "Sources disagree on the alloy");
  const challenged = page.locator('[data-testid="record-value"][data-status="challenged"]');
  await expect(challenged).toHaveCount(1);
  await expect(challenged).toContainText("EN AW-5754");
  await expect(challenged).toContainText("EN AW-5083");
});

test("a faulty file shows its typed error, stage and location", async ({ page }) => {
  await importSample(page, "ERP value with a decimal comma");
  await expect(page.getByTestId("import-erp")).toHaveAttribute("data-ok", "false");
  const error = page.getByTestId("import-error");
  await expect(error).toHaveAttribute("data-code", "decimal-comma");
  await expect(error).toHaveAttribute("data-stage", "semantics");
  await expect(error).toContainText("column thickness_nominal_mm");
});

test("an unknown code is kept and flagged", async ({ page }) => {
  await importSample(page, "Unknown company code");
  await expect(page.locator('[data-flag="unknown-code"]').first()).toBeVisible();
  await expect(page.getByText("SI99")).toBeVisible();
});

test("a file chosen by the operator is imported the same way", async ({ page }) => {
  await page.getByTestId("pick-erp").setInputFiles("fixtures/n/d03a-erp-extract.csv");
  await expect(page.getByTestId("import-erp")).toHaveAttribute("data-ok", "true");
  await page.getByTestId("pick-lab").setInputFiles("fixtures/n/lab-duplicate-key.json");
  await expect(page.getByTestId("import-lab")).toHaveAttribute("data-ok", "false");
  await expect(page.getByTestId("import-error")).toHaveAttribute("data-code", "duplicate-key");
});

test("importing the same files again gives the identical record digest", async ({ page }) => {
  await importSample(page, "Clean pair");
  const digest = await page.getByTestId("record-digest").getAttribute("title");
  await page.getByRole("button", { name: "Import the same files again" }).click();
  await expect(page.getByTestId("reimport")).toHaveAttribute("data-same", "true");
  await expect(page.getByTestId("record-digest")).toHaveAttribute("title", digest!);
});
