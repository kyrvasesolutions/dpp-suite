/**
 * Replays the Cycle 0 baseline walkthrough (docs/assessment/cycle-0/baseline-assessment.md §8):
 * Requirements → Aluminum → ESPR → Export → Mapping → aluminium example → Validation → Graph.
 * It pins what the current app shows, so later cycles see regressions (AT-R).
 */
import { expect, test } from "./egress";

test("baseline walkthrough: export an aluminium ESPR specification and map the example data", async ({ page }) => {
  await page.goto("/#requirements");
  await expect(page.getByText("38 data requirements across all targets")).toBeVisible();

  await page.getByText("Aluminum", { exact: true }).click();
  await expect(page.getByText("8 of 43 apply to Aluminum")).toBeVisible();

  await page.getByText("ESPR", { exact: true }).click();
  await expect(page.getByText("19 of 29 data requirements required")).toBeVisible();

  await page.getByRole("button", { name: "Export" }).click();
  await expect(page.getByText("Saved for Mapping")).toBeVisible();

  await page.goto("/#mapping");
  await expect(page.getByText("Aluminum · ESPR", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use aluminium example" }).click();
  await expect(page.getByText("48 fields from 1 file")).toBeVisible();
  await expect(page.getByText("of 19 entries covered")).toBeVisible();
  await expect(page.getByText("article.gtin", { exact: true })).toBeVisible();

  await page.goto("/#validation");
  await expect(page.getByText("Compliance targets", { exact: true })).toBeVisible();

  await page.goto("/#graph");
  await expect(page.getByText("Legislation explorer")).toBeVisible();
});

test("the app works without a saved specification", async ({ page }) => {
  await page.goto("/#mapping");
  await expect(page.getByText("None saved yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Use aluminium example" })).toBeVisible();
});
