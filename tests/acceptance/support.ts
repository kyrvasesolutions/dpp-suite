/** Helpers of the acceptance suite: everything is done through the UI, from files the operator picks. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { loadProfilePack, type ProfilePack } from "../../src/model/profile";
import { readPack } from "../../config/contractPack";
import type { ProductRecord } from "../../src/model/ingress";
import { assertNoLeakText } from "../support/leak";
import { recordFor } from "../support/records";
import { pdfText } from "../support/pdfText";
import { expect } from "../e2e/egress";
import { ROUTES, type Pair, type RouteId } from "./cases";

export const FIXTURES = "fixtures/n";
export const fixturePath = (name: string) => `${FIXTURES}/${name}`;
export const golden = JSON.parse(readFileSync("tests/golden/digests.json", "utf8")) as Record<string, string>;
export const sha = (b: Uint8Array | Buffer) => createHash("sha256").update(b).digest("hex");

let packPromise: Promise<ProfilePack> | undefined;
export const pack = () => (packPromise ??= loadProfilePack(readPack("contracts/n")));
export const recordOf = async (pair: Pair): Promise<ProductRecord> => recordFor(await pack(), pair);

/** The properties the matrix denies to each route's recipient, read from the pack the app embeds. */
export function deniedCount(route: RouteId): number {
  const rows = readFileSync("contracts/n/policy/actor-field-matrix.csv", "utf8").split("\n").filter((l) => /^[A-Z]+-/.test(l)).map((l) => l.split(","));
  return rows.filter((r) => r[1 + ROUTES.indexOf(route)] === "deny").length;
}

export type PickedFile = { name: string; mimeType: string; buffer: Buffer };

/** A fixture as the browser would send it. */
export const fixtureFile = (name: string): PickedFile => ({
  name,
  mimeType: name.endsWith(".csv") ? "text/csv" : "application/json",
  buffer: readFileSync(fixturePath(name)),
});

export const pick = (page: Page, role: "erp" | "lab", file: PickedFile) => page.getByTestId(`pick-${role}`).setInputFiles(file);

export async function openImport(page: Page) {
  await page.goto("/#import");
  await expect(page.getByRole("heading", { name: "Import source files" })).toBeVisible();
}

/**
 * Picks the laboratory file, then the ERP extract, on the Import screen, and waits for both results. Each pick imports what is
 * loaded so far, and an ERP extract alone already makes a record, so the laboratory file goes first: nothing is stored until
 * the pair is complete, and the pair is stored as version 1.
 */
export async function importPair(page: Page, pair: Pair) {
  await openImport(page);
  await pick(page, "lab", fixtureFile(pair.lab));
  await expect(page.getByTestId("import-lab")).toBeVisible();
  await pick(page, "erp", fixtureFile(pair.erp));
  await expect(page.getByTestId("import-erp")).toBeVisible();
  await expect(page.getByTestId("snapshot-status").first()).toBeVisible();
}

export const route = (page: Page, name: RouteId): Locator => page.locator(`[data-testid="output-route"][data-route="${name}"]`);

export async function openOutputs(page: Page) {
  await page.goto("/#outputs");
  await expect(page.getByRole("heading", { name: "Outputs", exact: true })).toBeVisible();
}

export async function download(page: Page, name: RouteId): Promise<{ name: string; bytes: Buffer }> {
  const [d] = await Promise.all([page.waitForEvent("download"), page.locator(`[data-testid="download"][data-route="${name}"]`).click()]);
  const { readFileSync: read } = await import("node:fs");
  return { name: d.suggestedFilename(), bytes: read((await d.path())!) };
}

/** The text of a downloaded output: the extracted text of the PDF, the file's text otherwise. */
export const textOf = async (route: RouteId, bytes: Buffer) => (route === "customer" ? pdfText(new Uint8Array(bytes)) : bytes.toString("utf8"));

/** Throws if text made for `route` holds a value of a property that route's recipient may not see. */
export async function expectNoDenied(text: string, route: RouteId, pair: Pair) {
  assertNoLeakText(text, route, await recordOf(pair), await pack());
}

export async function holdRules(card: Locator): Promise<string[]> {
  return [...new Set(await card.locator('[data-testid="hold-reason"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-rule") ?? "")))].sort();
}

/** Opens the execution log on the current screen and returns what its table shows. */
export async function logEntries(page: Page) {
  const log = page.getByTestId("execution-log");
  if (!(await log.evaluate((el) => (el as HTMLDetailsElement).open))) await log.locator("summary").click();
  return log.locator('[data-testid="log-entry"]');
}

/** Every file downloaded from the log button, parsed. */
export async function downloadLog(page: Page) {
  const [d] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-log").click()]);
  const text = readFileSync((await d.path())!, "utf8");
  return { text, doc: JSON.parse(text) as { fields: string[]; entries: Array<Record<string, unknown>> } };
}
