/** AT-E for Cycle 3: the Readiness screen, its holds with rule IDs and source locations, and the recipient view. */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { expect, test } from "./egress";

test.beforeEach(async ({ page }) => {
  await page.goto("/#readiness");
});

const load = async (page: import("@playwright/test").Page, sample: "clean" | "conflict" | "two-footprints" | "blocked") => {
  await page.getByLabel("Prepared record states").selectOption(sample);
  await page.getByRole("button", { name: "Load record state" }).click();
  await expect(page.getByTestId("route-status")).toHaveCount(3);
};
const route = (page: import("@playwright/test").Page, name: string) => page.locator(`[data-testid="route-status"][data-route="${name}"]`);

// The properties the matrix denies to the customer PDF, read from the same pack the app embeds
const pack = parse(readFileSync("contracts/n/profile/PROFILE-ALU-24-01@1.0.0.yaml", "utf8")) as { properties: Array<{ id: string; labels: { en: string } }> };
const matrix = readFileSync("contracts/n/policy/actor-field-matrix.csv", "utf8").split("\n").filter((l) => l.startsWith("ALU-")).map((l) => l.split(","));
const deniedLabels = matrix.filter((r) => r[1] === "deny").map((r) => pack.properties.find((p) => p.id === r[0])!.labels.en);

test("the page states that these are not a conformity assessment", async ({ page }) => {
  await expect(page.getByTestId("readiness-notice")).toContainText("not a conformity assessment");
  await expect(page.getByTestId("readiness-empty")).toBeVisible();
});

test("the clean pair shows the customer PDF and ERP routes RELEASED and the registry route HOLD", async ({ page }) => {
  await load(page, "clean");
  await expect(route(page, "customer")).toHaveAttribute("data-state", "RELEASED");
  await expect(route(page, "internal")).toHaveAttribute("data-state", "RELEASED");
  await expect(route(page, "registry")).toHaveAttribute("data-state", "HOLD");
  await expect(route(page, "registry").getByTestId("hold-reason")).toHaveAttribute("data-rule", "RR-STANDING-HOLD");
  await expect(route(page, "customer").getByTestId("hold-reason")).toHaveCount(0);
  await expect(route(page, "customer").locator('[data-testid="required-property"]:not([data-state="present"])')).toHaveCount(0);
});

test("conflicting pre-consumer shares show a challenged hold with its rule ID and source locations", async ({ page }) => {
  await load(page, "conflict");
  const hold = route(page, "customer").locator('[data-testid="hold-reason"][data-rule="RR-CHALLENGED"]');
  await expect(hold).toHaveCount(1);
  await expect(hold).toContainText("RR-CHALLENGED");
  await expect(hold).toContainText("erp-extract.csv, row 2, column pre_consumer_percent");
  await expect(hold).toContainText("lab-conflicting-pre-consumer.json, /recycled_content/conflicting_pre_percent");
  await expect(route(page, "customer").locator('[data-testid="required-property"][data-state="challenged"]')).toHaveCount(1);
  await expect(route(page, "customer")).toHaveAttribute("data-state", "HOLD");
  await expect(route(page, "internal")).toHaveAttribute("data-state", "RELEASED");
});

test("an incompatible footprint method holds the customer route while internal remains RELEASED", async ({ page }) => {
  await load(page, "two-footprints");
  await expect(route(page, "customer")).toHaveAttribute("data-state", "HOLD");
  await expect(route(page, "customer").getByTestId("hold-reason").first()).toBeVisible();
  await expect(route(page, "internal")).toHaveAttribute("data-state", "RELEASED");
});

test("a missing required value holds the route and says no source value exists", async ({ page }) => {
  await load(page, "blocked");
  const hold = route(page, "customer").locator('[data-testid="hold-reason"][data-rule="RR-MISSING"]');
  await expect(hold).toHaveCount(1);
  await expect(hold).toContainText("missing");
  await expect(route(page, "customer").locator('[data-testid="required-property"][data-state="missing"]')).toHaveCount(1);
});

test("the recipient view of the customer PDF shows no denied property and only derived statements", async ({ page }) => {
  await load(page, "clean");
  await page.locator('button[data-route="customer"]').click();
  const view = page.getByTestId("recipient-view");
  await expect(view).toHaveAttribute("data-route", "customer");
  const text = await view.innerText();
  expect(deniedLabels.length).toBeGreaterThan(0);
  for (const label of deniedLabels) expect(text).not.toContain(label);
  for (const value of ["EV-RC-DECL-001", "1.95", "31.4", "2.9"]) expect(text).not.toContain(value);
  // derived statements only, never the raw lead concentration or recycled splits
  await expect(view.getByTestId("recipient-derived")).toHaveCount(2);
  await expect(view).toContainText("<80 mg/kg");
  // every permitted value shows where it came from; so do the derived statements
  await expect(view.getByTestId("recipient-source").first()).toContainText("ERP extract, row 2, column");
  expect(text).not.toContain("erp-extract.csv");
  expect(text).not.toContain("lab-assessment.json");
  // what is withheld is listed for the operator, outside the recipient view
  await expect(page.getByTestId("withheld")).toHaveCount(deniedLabels.length);
  expect(await view.getByTestId("withheld").count()).toBe(0);
});

test("the recipient view follows the recipient: the ERP staging view carries what the matrix permits for it", async ({ page }) => {
  await load(page, "clean");
  await page.locator('button[data-route="internal"]').click();
  const view = page.getByTestId("recipient-view");
  await expect(view).toHaveAttribute("data-route", "internal");
  await expect(view).toContainText("1.95");
  await expect(view.getByTestId("recipient-derived")).toHaveCount(0);
  await page.locator('button[data-route="registry"]').click();
  await expect(page.getByTestId("recipient-view")).toHaveAttribute("data-on-hold", "true");
  await expect(page.getByTestId("recipient-view").getByTestId("recipient-value").first()).toBeVisible();
  await expect(page.getByTestId("withheld")).toHaveCount(21);
});

test("a record imported on the Import screen is the one the Readiness screen shows", async ({ page }) => {
  await page.goto("/#import");
  await page.getByLabel("Sample files").selectOption({ label: "Conflicting pre-consumer recycled content (ERP vs laboratory)" });
  await page.getByRole("button", { name: "Import sample" }).click();
  await expect(page.getByTestId("record-digest")).toHaveCount(1);
  await page.getByRole("radio", { name: "Readiness" }).click();
  await expect(page.getByTestId("route-status")).toHaveCount(3);
  await expect(route(page, "customer").locator('[data-rule="RR-CHALLENGED"]')).toHaveCount(1);
});
