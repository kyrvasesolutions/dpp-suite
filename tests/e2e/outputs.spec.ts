/**
 * AT-E for Cycle 4: the Outputs screen. Downloads all three outputs through the UI, extracts the PDF text and checks no
 * forbidden field, refusal on a route on hold, the registry draft, lineage of a PDF value, verification of a release, the
 * snapshot history after a correction, and the central record in a real browser's IndexedDB (survives a reload, version 1 -> 2
 * upgrade). Also the Import screen's snapshot status.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";
import initSqlJs from "sql.js";
import type { Page } from "@playwright/test";
import { pdfText } from "../support/pdfText";
import { expect, test } from "./egress";

const clean = { erp: "fixtures/n/d03a-erp-extract.csv", lab: "fixtures/n/d03a-lab-assessment.json" };

const loadSample = async (page: Page, sample: "clean" | "conflict" | "two-footprints" | "blocked" = "clean") => {
  await page.goto("/#outputs");
  await page.getByLabel("Prepared record states").selectOption(sample);
  await page.getByRole("button", { name: "Load record state" }).click();
  await expect(page.getByTestId("output-route")).toHaveCount(3);
};
const route = (page: Page, name: string) => page.locator(`[data-testid="output-route"][data-route="${name}"]`);
const download = async (page: Page, name: string) => {
  const [d] = await Promise.all([page.waitForEvent("download"), page.locator(`[data-testid="download"][data-route="${name}"]`).click()]);
  return { name: d.suggestedFilename(), bytes: readFileSync((await d.path())!) };
};

// What the matrix denies the customer, read from the pack the app embeds (stand-in)
const pack = parse(readFileSync("contracts/n/profile/PROFILE-ALU-24-01@1.0.0.yaml", "utf8")) as { properties: Array<{ id: string; labels: { en: string } }> };
const matrix = readFileSync("contracts/n/policy/actor-field-matrix.csv", "utf8").split("\n").filter((l) => l.startsWith("ALU-")).map((l) => l.split(","));
const deniedLabels = matrix.filter((r) => r[1] === "deny").map((r) => pack.properties.find((p) => p.id === r[0])!.labels.en);

test("the clean pair: customer PDF and ERP CSV are downloadable, the registry file is a HOLD draft", async ({ page }) => {
  await loadSample(page);
  await expect(route(page, "customer-pdf")).toHaveAttribute("data-state", "ready");
  await expect(route(page, "erp-staging-csv")).toHaveAttribute("data-state", "ready");
  await expect(route(page, "registry-prep-json")).toHaveAttribute("data-state", "hold-draft");
  await expect(page.getByTestId("download")).toHaveCount(3);
  await expect(route(page, "registry-prep-json").getByTestId("download")).toHaveText("Download draft (HOLD)");
  await expect(route(page, "registry-prep-json").getByTestId("hold-reason")).toHaveAttribute("data-rule", "RR-STANDING-HOLD");
  await expect(route(page, "registry-prep-json").getByTestId("draft-notice")).toContainText("never submitted");

  const pdf = await download(page, "customer-pdf");
  const csv = await download(page, "erp-staging-csv");
  const json = await download(page, "registry-prep-json");
  expect(pdf.name).toMatch(/\.pdf$/);
  expect(Buffer.from(pdf.bytes.subarray(0, 5)).toString()).toBe("%PDF-");

  const text = await pdfText(new Uint8Array(pdf.bytes));
  for (const label of deniedLabels) expect(text, `the PDF has no "${label}"`).not.toContain(label);
  for (const secret of ["EV-TR-0417", "EV-CR-0099", "SS01", "Demo test laboratory"]) expect(text).not.toContain(secret);
  expect(text).toContain("within the limits");
  expect(text).toContain("Rule DR-");
  expect(text).not.toMatch(/(?<![\w.-])228(?![\w.])/);

  expect(csv.bytes.toString("utf8").split("\n")[0].split(";").length).toBeGreaterThan(20);
  const doc = JSON.parse(json.bytes.toString("utf8"));
  expect(doc).toMatchObject({ status: "HOLD", submission: "never" });
  expect(json.name).toContain("HOLD");
});

test("a route on hold has no download and shows its reasons", async ({ page }) => {
  await loadSample(page, "blocked");
  for (const r of ["customer-pdf", "erp-staging-csv"]) {
    await expect(route(page, r)).toHaveAttribute("data-state", "refused");
    await expect(route(page, r).getByTestId("refusal")).toContainText("No file is made");
    await expect(route(page, r).locator('[data-testid="hold-reason"][data-rule="RR-MISSING"]')).toHaveCount(1);
    await expect(route(page, r).getByTestId("download")).toHaveCount(0);
  }
  await expect(route(page, "registry-prep-json").getByTestId("download")).toHaveCount(1);
});

test("the lineage panel traces a PDF value to its source file and location", async ({ page }) => {
  await loadSample(page);
  await page.getByTestId("lineage-pick").selectOption({ label: "Alloy designation" });
  const lineage = page.getByTestId("lineage");
  await expect(lineage).toHaveAttribute("data-route", "customer-pdf");
  await expect(lineage).toContainText("Mapping step");
  await expect(lineage.getByTestId("lineage-source")).toHaveCount(2);
  await expect(lineage.getByTestId("lineage-source").first()).toContainText("d03a-erp-extract.csv, row 2, column alloy");
  await expect(lineage.getByTestId("lineage-source").last()).toContainText("/product/alloy");
  // a derived statement names its rule and every input
  await page.getByTestId("lineage-pick").selectOption({ label: "Tensile strength Rm (measured)" });
  await expect(lineage).toContainText("derived by rule");
  expect(await lineage.getByTestId("lineage-source").count()).toBeGreaterThanOrEqual(3);
});

test("the manifest verifies the downloaded files and notices a changed byte", async ({ page }) => {
  await loadSample(page);
  const files = [await download(page, "customer-pdf"), await download(page, "erp-staging-csv"), await download(page, "registry-prep-json")];
  const [m] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download manifest" }).click()]);
  const manifest = readFileSync((await m.path())!);
  expect(JSON.parse(manifest.toString("utf8")).software.commit).toBeTruthy();
  // the time and role the release was made by are declared metadata, shown and kept out of the substantive digest
  const declared = JSON.parse(manifest.toString("utf8")) as { generated: { at: string; by: string }; substantiveDigest: string };
  expect(declared.generated.by).toBe("ACT-01");
  expect(declared.generated.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  await expect(page.getByTestId("manifest")).toHaveAttribute("data-digest", declared.substantiveDigest);
  await expect(page.getByTestId("manifest-generated")).toContainText(declared.generated.at);
  const supply = (list: typeof files) => list.map((f) => ({ name: f.name, mimeType: "application/octet-stream", buffer: f.bytes }));

  await page.getByTestId("verify-manifest").setInputFiles({ name: "release-manifest.json", mimeType: "application/json", buffer: manifest });
  await page.getByTestId("verify-files").setInputFiles(supply(files));
  await page.getByRole("button", { name: "Verify files" }).click();
  await expect(page.getByTestId("verify-result")).toHaveAttribute("data-ok", "true");

  const changed = files.map((f, i) => (i === 1 ? { ...f, bytes: Buffer.concat([f.bytes.subarray(0, 5), Buffer.from("X"), f.bytes.subarray(6)]) } : f));
  await page.getByTestId("verify-files").setInputFiles(supply(changed));
  await page.getByRole("button", { name: "Verify files" }).click();
  await expect(page.getByTestId("verify-result")).toHaveAttribute("data-ok", "false");
  await expect(page.getByTestId("verify-result").locator('[data-status="mismatch"]')).toHaveCount(1);
});

const corrected = readFileSync(clean.erp, "utf8").replace(";H111;2.0;", ";H22;2.0;");
const importClean = async (page: Page) => {
  await page.goto("/#import");
  await page.getByLabel("Sample files").selectOption({ label: "Clean pair" });
  await page.getByRole("button", { name: "Import sample" }).click();
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-version", "1");
};

test("the Import screen reports the stored version, a correction, and nothing new for identical files", async ({ page }) => {
  await importClean(page);
  const status = page.getByTestId("snapshot-status");
  await expect(status).toHaveAttribute("data-stored", "true");
  await expect(status).toContainText("stored as version 1");

  await page.getByRole("button", { name: "Import the same files again" }).click();
  await expect(status).toHaveAttribute("data-version", "1");
  await expect(status).toHaveAttribute("data-stored", "false");
  await expect(status).toContainText("nothing new is stored");

  await page.getByTestId("pick-erp").setInputFiles({ name: "d03a-erp-extract.csv", mimeType: "text/csv", buffer: Buffer.from(corrected) });
  await expect(status).toHaveAttribute("data-version", "2");
  await expect(status).toHaveAttribute("data-stored", "true");
  await expect(status).toContainText("replacing version 1");

  await page.getByRole("button", { name: "Import the same files again" }).click();
  await expect(status).toHaveAttribute("data-version", "2");
  await expect(status).toHaveAttribute("data-stored", "false");
});

test("the central record survives a reload; a correction makes version 2 linked to 1 and version 1 stays unchanged", async ({ page }) => {
  await importClean(page);
  await page.goto("/#outputs");
  await expect(page.getByTestId("snapshot")).toHaveCount(1);
  const v1 = await page.locator('[data-testid="snapshot"][data-version="1"] code').getAttribute("title");
  expect(v1).toMatch(/^[0-9a-f]{64}$/);

  await page.reload();
  await expect(page.getByTestId("snapshot")).toHaveCount(1);
  await expect(page.locator('[data-testid="snapshot"][data-version="1"] code')).toHaveAttribute("title", v1!);

  await page.goto("/#import");
  // a corrected ERP extract on its own is a changed record for the same model and batch
  await page.getByTestId("pick-erp").setInputFiles({ name: "d03a-erp-extract.csv", mimeType: "text/csv", buffer: Buffer.from(corrected) });
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-version", "2");

  await page.reload();
  await page.goto("/#outputs");
  await expect(page.getByTestId("snapshot")).toHaveCount(2);
  const v2 = page.locator('[data-testid="snapshot"][data-version="2"]');
  await expect(v2).toContainText(`version 1 (${v1!.slice(0, 12)}`);
  await expect(v2).toContainText("Corrected import");
  await expect(page.locator('[data-testid="snapshot"][data-version="1"] code')).toHaveAttribute("title", v1!);

  // version 1 is still viewable, read only, with its own values
  await page.locator('[data-testid="snapshot"][data-version="1"]').getByRole("button", { name: "View version 1" }).click();
  await expect(page.getByTestId("outputs-record")).toContainText("an earlier version, read only");
  await page.getByTestId("snapshot-values").locator("summary").click();
  await expect(page.getByTestId("snapshot-values")).toContainText("H111");
  await expect(page.getByTestId("snapshot-values")).not.toContainText("H22");
  await page.locator('[data-testid="snapshot"][data-version="2"]').getByRole("button", { name: "View version 2" }).click();
  await page.getByTestId("snapshot-values").locator("summary").click();
  await expect(page.getByTestId("snapshot-values")).toContainText("H22");
});

test("the central record exports and imports again with every version", async ({ page }) => {
  await importClean(page);
  await page.getByTestId("pick-erp").setInputFiles({ name: "d03a-erp-extract.csv", mimeType: "text/csv", buffer: Buffer.from(corrected) });
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-version", "2");
  await page.goto("/#outputs");
  const [d] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export central record" }).click()]);
  const file = readFileSync((await d.path())!);
  expect(JSON.parse(file.toString("utf8")).snapshots).toHaveLength(2);

  // importing what is already here adds nothing; a changed file is refused
  await page.getByTestId("pick-central").setInputFiles({ name: "central.json", mimeType: "application/json", buffer: file });
  await expect(page.getByTestId("outputs-message")).toContainText("0 versions added, 2 already here");
  await page.getByTestId("pick-central").setInputFiles({ name: "central.json", mimeType: "application/json", buffer: Buffer.from(file.toString("utf8").replace("Corrected import", "Corrected  import")) });
  await expect(page.getByTestId("outputs-message")).toContainText("changed");
  await expect(page.getByTestId("snapshot")).toHaveCount(2);
});

test("the database upgrade from version 1 to 2 keeps the files store and the saved app database", async ({ page }) => {
  // A real saved app database, made like the app makes it: schema, then the seeds in name order
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec(readFileSync("db/schema.sql", "utf8"));
  for (const f of readdirSync("db/seed").filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(`db/seed/${f}`, "utf8"));
  db.exec("PRAGMA user_version = 9;");
  const saved = Buffer.from(db.export()).toString("base64");

  await page.goto("/logo.svg"); // same origin, no app, so the database is not opened yet
  await page.evaluate(async (b64) => {
    await new Promise((r) => {
      const d = indexedDB.deleteDatabase("dpp-trace");
      d.onsuccess = d.onerror = d.onblocked = () => r(null);
    });
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await new Promise((resolve, reject) => {
      const r = indexedDB.open("dpp-trace", 1); // the old layout: one store, `files`
      r.onupgradeneeded = () => r.result.createObjectStore("files");
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const tx = r.result.transaction("files", "readwrite");
        tx.objectStore("files").put(bytes, "dpp-trace.sqlite");
        tx.objectStore("files").put(new Uint8Array([7, 7, 7]), "marker");
        tx.oncomplete = () => (r.result.close(), resolve(null));
      };
    });
  }, saved);

  await page.goto("/#requirements");
  await expect(page.getByText("38 data requirements across all targets")).toBeVisible();
  await expect(page.getByText("Couldn't open the database")).toHaveCount(0);
  // use the new store too, which runs the upgrade path of the real app
  await importClean(page);

  const after = await page.evaluate(
    () =>
      new Promise<{ version: number; stores: string[]; marker: number[]; saved: number }>((resolve, reject) => {
        const r = indexedDB.open("dpp-trace");
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const files = db.transaction("files").objectStore("files");
          const m = files.get("marker");
          const s = files.get("dpp-trace.sqlite");
          s.onsuccess = () => {
            resolve({ version: db.version, stores: [...db.objectStoreNames].sort(), marker: [...(m.result as Uint8Array)], saved: (s.result as Uint8Array).length });
            db.close();
          };
        };
      }),
  );
  expect(after.version).toBe(3);
  expect(after.stores).toEqual(["files", "log", "snapshots"]);
  expect(after.marker).toEqual([7, 7, 7]);
  expect(after.saved).toBe(Buffer.from(saved, "base64").length);
});

test("the three downloads of the clean pair are the golden files, byte for byte", async ({ page }) => {
  const golden = JSON.parse(readFileSync("tests/golden/digests.json", "utf8")) as Record<string, string>;
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  await loadSample(page);
  for (const r of ["customer-pdf", "erp-staging-csv", "registry-prep-json"]) {
    const f = await download(page, r);
    expect(sha(f.bytes), `${r} equals the golden digest`).toBe(golden[r]);
  }
  const [m] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download manifest" }).click()]);
  const manifest = JSON.parse(readFileSync((await m.path())!, "utf8")) as { inputs: Array<{ name: string; sha256: string }>; outputs: Array<{ route: string; sha256: string | null }> };
  // the inputs are the committed fixtures, and the outputs listed are the golden ones
  for (const i of manifest.inputs) expect(i.sha256).toBe(sha(readFileSync(`fixtures/n/${i.name}`)));
  for (const o of manifest.outputs) expect(o.sha256).toBe(golden[o.route]);
});

test("after importing a two-version central record into a browser that holds version 1, Outputs shows the latest version", async ({ page, browser }) => {
  await importClean(page);
  await page.getByTestId("pick-erp").setInputFiles({ name: "d03a-erp-extract.csv", mimeType: "text/csv", buffer: Buffer.from(corrected) });
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-version", "2");
  await page.goto("/#outputs");
  const [d] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export central record" }).click()]);
  const file = readFileSync((await d.path())!);

  // another browser profile that holds only version 1
  const other = await browser.newContext({ baseURL: "http://localhost:4173", acceptDownloads: true });
  try {
    const p2 = await other.newPage();
    await p2.goto("/#import");
    await p2.getByLabel("Sample files").selectOption({ label: "Clean pair" });
    await p2.getByRole("button", { name: "Import sample" }).click();
    await expect(p2.getByTestId("snapshot-status")).toHaveAttribute("data-version", "1");
    await p2.goto("/#outputs");
    await expect(p2.getByTestId("outputs-record")).toContainText("version 1 of 1");
    await p2.getByTestId("pick-central").setInputFiles({ name: "central.json", mimeType: "application/json", buffer: file });
    await expect(p2.getByTestId("outputs-message")).toContainText("1 version added, 1 already here");
    await expect(p2.getByTestId("snapshot")).toHaveCount(2);
    await expect(p2.getByTestId("outputs-record")).toContainText("version 2 of 2");
    await expect(p2.getByTestId("outputs-record")).not.toContainText("earlier version");
    // the restored version says where it came from
    await expect(p2.locator('[data-testid="snapshot"][data-version="2"]')).toContainText("Imported from a central-record file");
    await expect(p2.locator('[data-testid="snapshot"][data-version="1"]')).not.toContainText("Imported from a central-record file");
  } finally {
    await other.close();
  }
});

test("the Import screen shows an error when the record could not be saved to the central record", async ({ page }) => {
  // only the central record adds rows with IDBObjectStore.add (the app's own database uses put), so only its save fails
  await page.addInitScript(() => {
    IDBObjectStore.prototype.add = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
  });
  await page.goto("/#import");
  await page.getByLabel("Sample files").selectOption({ label: "Clean pair" });
  await page.getByRole("button", { name: "Import sample" }).click();
  await expect(page.getByTestId("snapshot-error")).toBeVisible();
  await expect(page.getByTestId("snapshot-error")).toContainText("could not be saved");
  await expect(page.getByTestId("snapshot-status")).toHaveCount(0);
  // the import itself is still shown
  await expect(page.getByTestId("record-digest")).toHaveCount(1);
});

test("a PDF refused for a character the font lacks names the code point and the source on the card", async ({ page }) => {
  const lab = readFileSync(clean.lab, "utf8").replace("Demo LCA consultancy (synthetic)", "Лаборатория");
  await page.goto("/#import");
  await page.getByTestId("pick-erp").setInputFiles(clean.erp);
  await page.getByTestId("pick-lab").setInputFiles({ name: "d03a-lab-assessment.json", mimeType: "application/json", buffer: Buffer.from(lab) });
  await expect(page.getByTestId("snapshot-status").first()).toBeVisible();
  await page.goto("/#outputs");
  const card = route(page, "customer-pdf");
  await expect(card).toHaveAttribute("data-state", "refused");
  await expect(card.locator('[data-testid="hold-reason"][data-rule="RR-PDF-CHARACTER"]')).toHaveCount(1);
  await expect(card.getByTestId("hold-detail")).toContainText("U+041B in calculated_by");
  await expect(card.getByTestId("hold-source")).toHaveCount(1);
  await expect(card.getByTestId("hold-source").first()).toContainText("/footprints/0/calculated_by");
  await expect(card.getByTestId("download")).toHaveCount(0);
  await expect(route(page, "erp-staging-csv")).toHaveAttribute("data-state", "ready");
});
