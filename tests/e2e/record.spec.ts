/**
 * AT-E for Cycle 5: the Record screen. The chain from sources to outputs, a correction of one value as a new version with a
 * reason, the earlier value kept, the lineage that names the correction, the field-level difference between versions, and the
 * exported record carrying that difference.
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./egress";

const load = async (page: Page, sample = "clean") => {
  await page.goto("/#outputs");
  await page.getByLabel("Prepared record states").selectOption(sample);
  await page.getByRole("button", { name: "Load record state" }).click();
  await expect(page.getByTestId("output-route")).toHaveCount(3);
  await page.goto("/#record");
  await expect(page.getByTestId("record-head")).toBeVisible();
};
const row = (page: Page, label: string) => page.locator('[data-testid="record-value"]').filter({ hasText: label }).first();
const correct = async (page: Page, label: string, value: string, reason: string) => {
  await row(page, label).getByTestId("correct-button").click();
  await page.getByTestId("correct-value").fill(value);
  await page.getByTestId("correct-reason").fill(reason);
  await page.getByTestId("correct-save").click();
};

test("the chain: sources, values with status, flags and kind, each route with access, readiness and output", async ({ page }) => {
  await load(page);
  const sources = page.getByTestId("record-source");
  await expect(sources).toHaveCount(2);
  await expect(sources.first()).toHaveAttribute("data-status", "accepted");
  await expect(sources.first()).toContainText(/[0-9a-f]{12}…/);
  await expect(page.getByTestId("record-value").first()).toBeVisible();
  await expect(row(page, "Tensile strength Rm (measured)").getByTestId("value-kind")).toHaveText("measured");
  await expect(row(page, "Product carbon footprint").getByTestId("value-kind")).toHaveText("calculated externally");
  await expect(row(page, "Nominal thickness").getByTestId("value-kind")).toHaveText("declared");
  const routes = page.getByTestId("record-route");
  await expect(routes).toHaveCount(3);
  await expect(page.locator('[data-testid="record-route"][data-route="customer-pdf"]')).toHaveAttribute("data-status", "ready");
  await expect(page.locator('[data-testid="record-route"][data-route="registry-prep-json"]')).toHaveAttribute("data-status", "on-hold");
  await expect(page.locator('[data-testid="record-route"][data-route="registry-prep-json"] [data-testid="record-hold"]').first()).toHaveAttribute("data-rule", "RR-STANDING-HOLD");
  await expect(page.locator('[data-testid="record-route"][data-route="customer-pdf"] [data-testid="record-output"]')).toHaveAttribute("data-state", "made");
  await expect(page.locator('[data-testid="record-route"][data-route="registry-prep-json"] [data-testid="record-output"]')).toHaveAttribute("data-state", "hold-draft");
  // access per property: the customer gets derived statements only for the derived properties, and nothing for the denied ones
  const access = page.locator('[data-testid="record-route"][data-route="customer-pdf"] [data-testid="record-access"]');
  await access.first().evaluate((el) => el.closest("details")!.setAttribute("open", ""));
  await expect(access.filter({ hasText: "Derived only" })).toHaveCount(2);
  await expect(access.filter({ hasText: "Withheld" }).first()).toBeVisible();
  // links into the other screens
  await page.getByRole("button", { name: "Open Outputs" }).click();
  await expect(page.getByRole("heading", { name: "Outputs", exact: true })).toBeVisible();
  await page.goto("/#record");
  await page.getByRole("button", { name: "Open Readiness" }).click();
  await expect(page.getByRole("heading", { name: "Route readiness" })).toBeVisible();
});

test("a rejected file is shown as rejected among the sources, and is part of no record", async ({ page }) => {
  await load(page);
  await page.goto("/#import");
  await page.getByLabel("Sample files").selectOption({ label: "ERP value with a decimal comma" });
  await page.getByRole("button", { name: "Import sample" }).click();
  await expect(page.getByTestId("import-error")).toHaveAttribute("data-code", "decimal-comma");
  await page.goto("/#record");
  const rejected = page.locator('[data-testid="record-source"][data-status="rejected"]');
  await expect(rejected).toHaveCount(1);
  await expect(rejected).toContainText("decimal-comma");
  await expect(page.locator('[data-testid="record-source"][data-status="accepted"]')).toHaveCount(2);
});

test("a correction makes a new version, keeps the earlier value, and is never silent", async ({ page }) => {
  await load(page);
  await correct(page, "Nominal thickness", "2.37", "Mill certificate shows 2.37 mm");
  await expect(page.getByTestId("record-message")).toContainText("version 2");
  await expect(page.getByTestId("record-head")).toContainText("version 2 of 2");
  const value = row(page, "Nominal thickness");
  await expect(value).toHaveAttribute("data-status", "corrected");
  await expect(value.getByTestId("current-value")).toHaveText("2.37");
  await expect(value.getByTestId("earlier-value")).toContainText("2.0");
  await expect(value.getByTestId("value-kind")).toHaveText("corrected by the operator");
  await expect(value.getByTestId("correction-note")).toContainText("version 2 by ACT-01: Mill certificate shows 2.37 mm");
  await expect(value.locator('[data-flag="corrected"]')).toBeVisible();
  await expect(page.locator('[data-testid="record-source"][data-role="correction"]')).toHaveCount(1);
  // readiness still counts it as present: the customer route stays ready
  await expect(page.locator('[data-testid="record-route"][data-route="customer-pdf"]')).toHaveAttribute("data-status", "ready");
  // version 1 is still readable and unchanged
  await page.getByRole("button", { name: "View version 1" }).click();
  await expect(row(page, "Nominal thickness").getByTestId("current-value")).toHaveText("2.0");
  await expect(row(page, "Nominal thickness")).toHaveAttribute("data-status", "single");
  await expect(row(page, "Nominal thickness").getByTestId("correct-button")).toHaveCount(0); // only the latest version is corrected
});

test("a correction needs a reason and a valid value, and an identifier cannot be corrected", async ({ page }) => {
  await load(page);
  await correct(page, "Nominal thickness", "2.37", "   ");
  await expect(page.getByTestId("record-message")).toContainText("needs a reason");
  await expect(page.getByTestId("record-version")).toHaveCount(1);
  await page.getByTestId("correct-value").fill("2,37");
  await page.getByTestId("correct-reason").fill("typo");
  await page.getByTestId("correct-save").click();
  await expect(page.getByTestId("record-message")).toContainText("decimal comma");
  await expect(page.getByTestId("record-version")).toHaveCount(1);
  await correct(page, "Alloy designation", "EN AW-9999", "not a real alloy");
  await expect(page.getByTestId("record-message")).toContainText("code list");
  // an identifier has no Correct button (the unit tests prove the refusal itself)
  await expect(row(page, "Batch identifier").getByTestId("correct-button")).toHaveCount(0);
  await expect(page.getByTestId("record-version")).toHaveCount(1);
});

test("the lineage of the corrected value names the correction version, actor and reason, and the diff shows what changed", async ({ page }) => {
  await load(page);
  await correct(page, "Nominal thickness", "2.37", "Mill certificate shows 2.37 mm");
  await expect(page.getByTestId("record-head")).toContainText("version 2 of 2");

  // the field-level difference between version 1 and version 2
  const diff = page.getByTestId("record-diff");
  await expect(diff).toHaveAttribute("data-from", "1");
  await expect(diff).toHaveAttribute("data-to", "2");
  const fields = diff.getByTestId("diff-row");
  await expect(fields.locator("xpath=self::*[@data-field='value']")).toContainText("2.0");
  await expect(fields.locator("xpath=self::*[@data-field='value']")).toContainText("2.37");
  await expect(fields.locator("xpath=self::*[@data-field='status']")).toContainText("corrected");
  await expect(fields.locator("xpath=self::*[@data-field='correction']")).toContainText("Mill certificate shows 2.37 mm");
  await page.getByTestId("diff-from").selectOption("2");
  await expect(page.getByTestId("diff-empty")).toBeVisible();

  // Outputs: the manifest's lineage for that value names the correction
  await page.goto("/#outputs");
  await expect(page.getByTestId("outputs-record")).toContainText("version 2 of 2");
  const [m] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download manifest" }).click()]);
  const manifest = JSON.parse(readFileSync((await m.path())!, "utf8")) as { lineage: Array<{ assertion: { role: string }; correction?: { version: number; actor: string; reason: string } }>; inputs: Array<{ role: string }> };
  const corrected = manifest.lineage.filter((e) => e.correction);
  expect(corrected.length).toBeGreaterThanOrEqual(2);
  for (const e of corrected) {
    expect(e.assertion.role).toBe("correction");
    expect(e.correction).toEqual({ version: 2, actor: "ACT-01", reason: "Mill certificate shows 2.37 mm" });
  }
  expect(manifest.inputs.map((i) => i.role)).toContain("correction");

  // the exported central record carries the same difference
  const [c] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export central record" }).click()]);
  const exported = JSON.parse(readFileSync((await c.path())!, "utf8")) as { diffs: Array<{ from: number; to: number; changes: Array<{ fields: Array<{ field: string; after: string | null }> }> }> };
  expect(exported.diffs).toHaveLength(1);
  expect(exported.diffs[0]).toMatchObject({ from: 1, to: 2 });
  expect(exported.diffs[0].changes[0].fields.find((f) => f.field === "value")!.after).toBe("2.37");
});

test("a correction is logged as an event with no value and no reason", async ({ page }) => {
  await load(page);
  await correct(page, "Nominal thickness", "2.37", "SECRET-REASON-TEXT");
  await expect(page.getByTestId("record-message")).toContainText("version 2");
  await page.goto("/#outputs");
  const [d] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-log").click()]);
  const text = readFileSync((await d.path())!, "utf8");
  expect(JSON.parse(text).entries.some((e: { event: string }) => e.event === "correction")).toBe(true);
  expect(text).not.toContain("SECRET-REASON-TEXT");
  expect(text).not.toContain("2.37");
});

const erpWith = (value: string) => ({ name: "d03a-erp-extract.csv", mimeType: "text/csv", buffer: Buffer.from(readFileSync("fixtures/n/d03a-erp-extract.csv", "utf8").replace(";62.0;", `;${value};`)) });
const lab = () => ({ name: "d03a-lab-assessment.json", mimeType: "application/json", buffer: readFileSync("fixtures/n/d03a-lab-assessment.json") });

test("a re-import never silently undoes a correction: it is carried forward, or the value is challenged", async ({ page }) => {
  await page.goto("/#import");
  await page.getByTestId("pick-lab").setInputFiles(lab());
  await page.getByTestId("pick-erp").setInputFiles(erpWith("62.0"));
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-version", "1");
  await page.goto("/#record");
  await correct(page, "Recycled content", "63.5", "Certificate says 63.5");
  await expect(page.getByTestId("record-head")).toContainText("version 2 of 2");

  // the same files again: the correction is carried, nothing new is stored, and nothing says "Corrected import"
  await page.goto("/#import");
  await page.getByRole("button", { name: "Import the same files again" }).click();
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-stored", "false");
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-version", "2");
  await page.goto("/#record");
  await expect(row(page, "Recycled content")).toHaveAttribute("data-status", "corrected");
  await expect(row(page, "Recycled content").getByTestId("current-value")).toHaveText("63.5");

  // a source that now says something else: both kept, challenged, the routes hold, and every screen says so
  await page.goto("/#import");
  await page.getByTestId("pick-erp").setInputFiles(erpWith("60.0"));
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-version", "3");
  await expect(page.getByTestId("snapshot-status")).toContainText("challenged");
  await page.goto("/#record");
  await expect(page.getByTestId("record-version").last().getByText("Re-import: the source changed after a correction")).toBeVisible();
  await expect(row(page, "Recycled content")).toHaveAttribute("data-status", "challenged");
  await expect(row(page, "Recycled content").getByTestId("current-value")).toHaveCount(3 - 1); // the correction and the new source value
  await expect(page.locator('[data-testid="record-route"][data-route="erp-staging-csv"] [data-rule="RR-CHALLENGED"]')).toHaveCount(1);
  await page.goto("/#readiness");
  await expect(page.getByTestId("readiness-version")).toContainText("version 3");
  await expect(page.locator('[data-testid="route-status"][data-route="erp-staging-csv"] [data-rule="RR-CHALLENGED"]')).toHaveCount(1);
});

test("Readiness reads the latest version: after a correction it agrees with Record and Outputs", async ({ page }) => {
  await load(page, "conflict");
  await page.goto("/#readiness");
  await expect(page.locator('[data-testid="route-status"][data-route="customer-pdf"] [data-rule="RR-CHALLENGED"]')).toHaveCount(1);
  await page.goto("/#record");
  await correct(page, "Alloy designation", "EN AW-5754", "Mill certificate confirms 5754");
  await expect(page.getByTestId("record-head")).toContainText("version 2 of 2");
  await page.goto("/#readiness");
  await expect(page.getByTestId("readiness-version")).toContainText("version 2");
  await expect(page.locator('[data-rule="RR-CHALLENGED"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="route-status"][data-route="customer-pdf"]')).toContainText("Ready");
  await page.goto("/#outputs");
  await expect(page.getByTestId("outputs-record")).toContainText("version 2 of 2");
  await expect(page.locator('[data-testid="output-route"][data-route="customer-pdf"]')).toHaveAttribute("data-state", "ready");
});

test("a version is stored only when the pair is complete; the pick survives leaving the screen; versions are labelled honestly", async ({ page }) => {
  await page.goto("/#import");
  await page.getByTestId("pick-erp").setInputFiles(erpWith("62.0"));
  await expect(page.getByTestId("pair-pending")).toContainText("Waiting for the laboratory file");
  await expect(page.getByTestId("snapshot-status")).toHaveCount(0);
  await page.goto("/#outputs");
  await expect(page.getByTestId("outputs-empty")).toBeVisible();
  await page.goto("/#import");
  await expect(page.getByTestId("import-erp")).toHaveAttribute("data-ok", "true"); // the pick is still there
  await page.getByTestId("pick-lab").setInputFiles(lab());
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-version", "1");
  await expect(page.getByTestId("pair-pending")).toHaveCount(0);
  await page.goto("/#record");
  await expect(page.getByTestId("record-version")).toHaveCount(1);
  await expect(page.getByTestId("record-version").first()).toContainText("First import");
  await expect(page.locator('[data-testid="record-source"][data-status="accepted"]')).toHaveCount(2);

  // the operator can still store an ERP-only record on purpose, and it says so
  await page.reload();
  await page.goto("/#import");
  await page.getByTestId("pick-erp").setInputFiles(erpWith("61.0"));
  await expect(page.getByTestId("snapshot-status")).toHaveCount(0);
  await page.getByTestId("store-erp-only").click();
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-version", "2");
  await page.goto("/#record");
  await expect(page.getByTestId("record-version").last()).toContainText("ERP-only record, stored by the operator");
});

test("a correction to the value the record already has is refused with a clear message", async ({ page }) => {
  await load(page);
  await correct(page, "Recycled content", "62.0", "no change");
  await expect(page.getByTestId("record-message")).toContainText("same as the current value");
  await expect(page.getByTestId("record-version")).toHaveCount(1);
});

test("the Record screen names things once and shows only what is true", async ({ page }) => {
  await load(page);
  // the two digests have two names
  await expect(page.getByTestId("record-head")).toContainText("Record digest (the one on the customer sheet)");
  await expect(page.getByTestId("record-head")).toContainText("Version digest");
  // no Correct button on an identifier or an evidence reference
  for (const label of ["Product model identifier", "Batch identifier", "Evidence references"]) {
    await expect(page.locator('[data-testid="record-value"]').filter({ hasText: label }).first().getByTestId("correct-button")).toHaveCount(0);
  }
  await expect(row(page, "Recycled content").getByTestId("correct-button")).toHaveCount(1);
  // a text that came from the laboratory file is not said to come from the ERP extract
  const narrative = row(page, "Product narrative");
  await expect(narrative.locator('[data-flag="declared"]')).toContainText("Declared in the laboratory file");
  await expect(narrative.locator('[data-flag="declared"]')).not.toContainText("ERP extract");
  await expect(row(page, "Nominal thickness").locator('[data-flag="declared"]')).toContainText("Declared in the ERP extract");
  // values the two files agree on are not struck through as "earlier"
  const agreeing = page.locator('[data-testid="record-value"][data-status="agreeing"]').first();
  await expect(agreeing.getByTestId("earlier-value")).toHaveCount(0);
  await expect(agreeing.getByTestId("also-stated")).toHaveCount(1);
  // the rail has the four screens of the chain among its others, and the Record screen is between Import and Readiness
  const lanes = await page.locator(".lane-label").allInnerTexts();
  expect(lanes.indexOf("Import") + 1).toBe(lanes.indexOf("Record"));
  expect(lanes.indexOf("Record") + 1).toBe(lanes.indexOf("Readiness"));
  expect(lanes.indexOf("Readiness") + 1).toBe(lanes.indexOf("Outputs"));
});

test("an unattached laboratory file for another batch does not complete the pair and stores nothing", async ({ page }) => {
  await page.goto("/#import");
  const otherLab = {
    name: "other-batch-lab.json",
    mimeType: "application/json",
    buffer: Buffer.from(readFileSync("fixtures/n/d03a-lab-assessment.json", "utf8").replace("B-2026-0417", "B-2026-9999")),
  };
  await page.getByTestId("pick-erp").setInputFiles(erpWith("62.0"));
  await page.getByTestId("pick-lab").setInputFiles(otherLab);
  await expect(page.getByTestId("pair-pending")).toContainText("another product model or batch");
  await expect(page.getByTestId("snapshot-status")).toHaveCount(0);
  await expect(page.getByTestId("unattached")).toBeVisible();
});

test("a re-import confirming a correction shows it as also stated; dropping it challenges the value and marks the superseded source", async ({ page }) => {
  await page.goto("/#import");
  await page.getByTestId("pick-lab").setInputFiles(lab());
  await page.getByTestId("pick-erp").setInputFiles(erpWith("62.0"));
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-version", "1");
  await page.goto("/#record");
  await correct(page, "Recycled content", "63.5", "Certificate says 63.5");
  await expect(page.getByTestId("record-head")).toContainText("version 2 of 2");

  // re-import where the ERP source now agrees with the operator correction (63.5): confirmed, not struck through
  await page.goto("/#import");
  await page.getByTestId("pick-erp").setInputFiles(erpWith("63.5"));
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-version", "3");
  await page.goto("/#record");
  const confirmed = row(page, "Recycled content");
  await expect(confirmed).toHaveAttribute("data-status", "corrected");
  await expect(confirmed.getByTestId("also-stated")).toContainText("63.5");
  await expect(confirmed.getByTestId("earlier-value")).toHaveCount(0);

  // re-import dropping the value: challenged with source-changed, and the earlier ERP file (not the incoming one) is marked superseded
  await page.goto("/#import");
  await page.getByTestId("pick-erp").setInputFiles({
    name: "erp-missing-recycled-content.csv",
    mimeType: "text/csv",
    buffer: readFileSync("fixtures/n/erp-missing-recycled-content.csv"),
  });
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-version", "4");
  await page.goto("/#record");
  await expect(row(page, "Recycled content")).toHaveAttribute("data-status", "challenged");
  await expect(page.locator('[data-testid="record-route"][data-route="customer-pdf"] [data-rule="RR-CHALLENGED"]')).toHaveCount(1);
  const erpSources = page.locator('[data-testid="record-source"][data-role="erp"][data-status="accepted"]');
  await expect(erpSources).toHaveCount(2);
  await expect(erpSources.first().getByTestId("superseded-source")).toHaveCount(0);
  await expect(erpSources.nth(1).getByTestId("superseded-source")).toHaveCount(1);
});
