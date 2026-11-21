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

test("the clean pair shows the customer PDF and ERP routes ready and the registry route on hold", async ({ page }) => {
  await load(page, "clean");
  await expect(route(page, "customer-pdf")).toHaveAttribute("data-state", "ready");
  await expect(route(page, "erp-staging-csv")).toHaveAttribute("data-state", "ready");
  await expect(route(page, "registry-prep-json")).toHaveAttribute("data-state", "on-hold");
  await expect(route(page, "registry-prep-json").getByTestId("hold-reason")).toHaveAttribute("data-rule", "RR-STANDING-HOLD");
  await expect(route(page, "customer-pdf").getByTestId("hold-reason")).toHaveCount(0);
  await expect(route(page, "customer-pdf").locator('[data-testid="required-property"]:not([data-state="present"])')).toHaveCount(0);
});

test("conflicting alloys show a challenged hold with its rule ID and source locations", async ({ page }) => {
  await load(page, "conflict");
  const hold = route(page, "customer-pdf").locator('[data-testid="hold-reason"][data-rule="RR-CHALLENGED"]');
  await expect(hold).toHaveCount(1);
  await expect(hold).toContainText("RR-CHALLENGED");
  await expect(hold).toContainText("d03a-erp-extract.csv, row 2, column alloy");
  await expect(hold).toContainText("lab-conflicting-alloy.json, /product/alloy");
  await expect(route(page, "customer-pdf").locator('[data-testid="required-property"][data-state="challenged"]')).toHaveCount(1);
  await expect(route(page, "customer-pdf")).toHaveAttribute("data-state", "on-hold");
});

test("two footprint results hold the routes that need the footprint and keep both sources", async ({ page }) => {
  await load(page, "two-footprints");
  const hold = route(page, "customer-pdf").locator('[data-testid="hold-reason"][data-rule="RR-SEVERAL-RESULTS"]');
  await expect(hold).toHaveCount(1);
  await expect(hold).toContainText("/footprints/0/value");
  await expect(hold).toContainText("/footprints/1/value");
  await expect(route(page, "erp-staging-csv").locator('[data-rule="RR-SEVERAL-RESULTS"]')).toHaveCount(1);
});

test("a missing required value holds the route and says no source value exists", async ({ page }) => {
  await load(page, "blocked");
  const hold = route(page, "customer-pdf").locator('[data-testid="hold-reason"][data-rule="RR-MISSING"]');
  await expect(hold).toHaveCount(1);
  await expect(hold).toContainText("missing");
  await expect(route(page, "customer-pdf").locator('[data-testid="required-property"][data-state="missing"]')).toHaveCount(1);
});

test("the recipient view of the customer PDF shows no denied property and only derived statements", async ({ page }) => {
  await load(page, "clean");
  await page.getByRole("button", { name: "Customer PDF" }).last().click();
  const view = page.getByTestId("recipient-view");
  await expect(view).toHaveAttribute("data-route", "customer-pdf");
  const text = await view.innerText();
  expect(deniedLabels.length).toBeGreaterThan(0);
  for (const label of deniedLabels) expect(text).not.toContain(label);
  for (const value of ["SS01", "EV-TR-0417", "EV-CR-0099"]) expect(text).not.toContain(value);
  // derived statements only, never the strength or composition values
  await expect(view.getByTestId("recipient-derived")).toHaveCount(2);
  await expect(view).toContainText("Within the limits (illustrative limits after EN 485-2, EN AW-5754 H111)");
  for (const value of ["228", "3.05", "0.31"]) expect(text).not.toContain(value);
  // every permitted value shows where it came from; so do the derived statements
  await expect(view.getByTestId("recipient-source").first()).toContainText("ERP extract, row 2, column");
  expect(text).not.toContain("d03a-erp-extract.csv");
  expect(text).not.toContain("d03a-lab-assessment.json");
  await expect(view.getByTestId("recipient-derived").first()).toContainText("/observations/1/value");
  // what is withheld is listed for the operator, outside the recipient view
  await expect(page.getByTestId("withheld")).toHaveCount(deniedLabels.length);
  expect(await view.getByTestId("withheld").count()).toBe(0);
});

test("the recipient view follows the recipient: the ERP staging view carries what the matrix permits for it", async ({ page }) => {
  await load(page, "clean");
  await page.getByRole("button", { name: "ERP staging CSV" }).last().click();
  const view = page.getByTestId("recipient-view");
  await expect(view).toHaveAttribute("data-route", "erp-staging-csv");
  await expect(view).toContainText("SS01");
  await expect(view.getByTestId("recipient-derived")).toHaveCount(0);
  await page.getByRole("button", { name: "Registry preparation JSON" }).last().click();
  await expect(page.getByTestId("recipient-view")).toHaveAttribute("data-on-hold", "true");
  await expect(page.getByTestId("recipient-view").getByTestId("recipient-value").first()).toBeVisible();
  await expect(page.getByTestId("withheld")).toHaveCount(21);
});

test("a record imported on the Import screen is the one the Readiness screen shows", async ({ page }) => {
  await page.goto("/#import");
  await page.getByLabel("Sample files").selectOption({ label: "Two footprint results" });
  await page.getByRole("button", { name: "Import sample" }).click();
  await expect(page.getByTestId("record-digest")).toHaveCount(1);
  await page.getByRole("radio", { name: "Readiness" }).click();
  await expect(page.getByTestId("route-status")).toHaveCount(3);
  await expect(route(page, "customer-pdf").locator('[data-rule="RR-SEVERAL-RESULTS"]')).toHaveCount(1);
});
