// @vitest-environment node
/**
 * The pack-only acceptance change: one optional ERP column, mapped to an existing property that no ERP column fills yet and
 * that existing output items already read, is added to a temporary copy of the stand-in pack through the contract checker
 * alone. Import, readiness and the outputs then carry the new value, and no file under src/ changes.
 *
 * No property identifier is named here: the property is found by its definition slug, and the test checks that no ERP column
 * fills it and that the ERP staging item and the customer PDF item both read it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { readPack } from "../../config/contractPack";
import { buildRecords, importErpCsv, importLabJson } from "../../src/model/ingress";
import { generateRelease } from "../../src/model/outputs/release";
import { assess } from "../../src/model/readiness";
import { loadProfilePack, type ProfilePack } from "../../src/model/profile";
import { MemoryRepository, storeRecord } from "../../src/model/recordRepository";
import { fixtureBytes } from "../support/fixtures";
import { pdfText } from "../support/pdfText";
import { propertyBySlug, text as fixtureText } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

/** A hash of every file under src/, and git's own view of it, so a change anywhere shows. */
function sourceState() {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
  const hash = createHash("sha256");
  for (const f of files("src").sort()) hash.update(f).update(readFileSync(f));
  const git = (...a: string[]) => spawnSync("git", a, { encoding: "utf8" });
  return { hash: hash.digest("hex"), status: git("status", "--porcelain", "--", "src").stdout, diff: git("diff", "HEAD", "--", "src").stdout };
}

const NEW_VALUE = "2.37";
const NEW_COLUMN = "thickness_measured_mm";

let dir: string;
let base: ProfilePack;
let variant: ProfilePack;
let target: { property: string; unit: string };
let before: ReturnType<typeof sourceState>;
let checker: { write: ReturnType<typeof spawnSync>; verify: ReturnType<typeof spawnSync> };

const csvWithColumn = (value: string) => {
  const [head, row] = new TextDecoder().decode(fixtureBytes("n", "d03a-erp-extract.csv")).trimEnd().split("\n");
  return new TextEncoder().encode(`${head};${NEW_COLUMN}\n${row};${value}\n`);
};

beforeAll(async () => {
  before = sourceState();
  base = await loadProfilePack(readPack("contracts/n"));

  // a property no ERP column fills yet, read by an item of the ERP staging route and by an item of the customer PDF route
  const property = propertyBySlug(base, "measured-thickness");
  const info = base.properties.find((p) => p.id === property)!;
  expect(base.inputs.erp.columns.some((c) => c.maps_to.split("/")[0] === property)).toBe(false);
  for (const route of ["erp-staging-csv", "customer-pdf"] as const) {
    expect(base.routes[route].output.some((i) => i.property === property && i.reads.kind === "value"), route).toBe(true);
  }
  target = { property, unit: info.unit! };

  // a temporary copy of the stand-in pack, changed in its ERP contract only
  dir = mkdtempSync(join(tmpdir(), "dpp-variant-"));
  cpSync("contracts/n", join(dir, "contracts/n"), { recursive: true });
  const file = join(dir, "contracts/n/inputs/erp-extract.csv.contract.yaml");
  const doc = parseDocument(readFileSync(file, "utf8"));
  doc.addIn(["columns"], doc.createNode({ name: NEW_COLUMN, maps_to: target.property, unit: target.unit, required: false }));
  writeFileSync(file, doc.toString({ lineWidth: 0 }));

  // the contract checker, and only it, brings the manifest up to date and checks the changed pack
  const check = (...extra: string[]) => spawnSync("node", ["scripts/check-contracts.mjs", "--pack", join(dir, "contracts/n"), ...extra], { encoding: "utf8" });
  checker = { write: check("--write"), verify: check("--require-frozen") };
  variant = await loadProfilePack(readPack(join(dir, "contracts/n")));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("pack-only acceptance change: one optional column, no source change", () => {
  it("is built with the contract checker and passes it, as a different pack", () => {
    expect(checker.write.status, String(checker.write.stderr)).toBe(0);
    expect(checker.verify.status, String(checker.verify.stderr)).toBe(0);
    expect(existsSync(join(dir, "contracts/n/MANIFEST.json"))).toBe(true);
    expect(variant.manifestDigest).not.toBe(base.manifestDigest);
    expect(variant.inputs.erp.columns.map((c) => c.name)).toEqual([...base.inputs.erp.columns.map((c) => c.name), NEW_COLUMN]);
    const added = variant.inputs.erp.columns.at(-1)!;
    expect(added).toMatchObject({ maps_to: target.property, unit: target.unit, required: false });
    // everything else in the pack is the stand-in's own: only the ERP contract and the manifest differ
    const changed = Object.keys(variant.pins).length === Object.keys(base.pins).length && variant.pins.filter((p, i) => p.digest !== base.pins[i].digest).map((p) => p.path);
    expect(changed).toEqual(["inputs/erp-extract.csv.contract.yaml"]);
  });

  it("imports the new column as an assertion of the mapped property, verbatim, with the contract's unit", async () => {
    const r = await importErpCsv(variant, { bytes: csvWithColumn(NEW_VALUE), name: "erp.csv", type: "text/csv" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.assertions.find((x) => x.property === target.property)!;
    expect(a).toMatchObject({ raw: NEW_VALUE, value: 2.37, unit: target.unit, flags: ["declared", "unit-from-contract"] });
    expect(a.source.location).toMatch(new RegExp(`column ${NEW_COLUMN}$`));
  });

  it("treats the column as optional: an empty cell is accepted and gives no value", async () => {
    const r = await importErpCsv(variant, { bytes: csvWithColumn(""), name: "erp.csv", type: "text/csv" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.assertions.some((x) => x.property === target.property)).toBe(false);
    // the stand-in itself still takes its own extract, which has no such column
    expect((await importErpCsv(base, { bytes: fixtureBytes("n", "d03a-erp-extract.csv"), name: "erp.csv", type: "text/csv" })).ok).toBe(true);
  });

  /** The clean laboratory file without its own measurement of the property, so the ERP column is the only source of it. */
  const labWithout = (p: ProfilePack) => {
    const doc = JSON.parse(fixtureText("d03a-lab-assessment.json"));
    doc.observations = doc.observations.filter((o: { property: string }) => o.property !== target.property);
    return importLabJson(p, { bytes: new TextEncoder().encode(JSON.stringify(doc)), name: "lab.json", type: "application/json" });
  };
  const verdict = (p: ProfilePack, r: Awaited<ReturnType<typeof buildRecords>>["records"][number]) =>
    assess(p, r).map((x) => ({ route: x.route, status: x.status, holds: x.holds.map((h) => h.ruleId) }));

  it("gives the same readiness as the stand-in, and all three outputs, with the new value in the two that read it", async () => {
    const erp = await importErpCsv(variant, { bytes: csvWithColumn(NEW_VALUE), name: "erp.csv", type: "text/csv" });
    const { records } = await buildRecords([erp, await labWithout(variant)]);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.values.find((v) => v.property === target.property)?.status).toBe("single");

    // the stand-in's own record, from the unchanged pack and the unchanged files
    const baseRecord = (
      await buildRecords([
        await importErpCsv(base, { bytes: fixtureBytes("n", "d03a-erp-extract.csv"), name: "erp.csv", type: "text/csv" }),
        await importLabJson(base, { bytes: fixtureBytes("n", "d03a-lab-assessment.json"), name: "lab.json", type: "application/json" }),
      ])
    ).records[0];
    // readiness: ERP staging and the customer PDF are ready, the registry route is on its standing hold, exactly as for the stand-in
    expect(verdict(variant, record)).toEqual(verdict(base, baseRecord));
    expect(verdict(variant, record).map((v) => v.status)).toEqual(["ready", "ready", "on-hold"]);

    // outputs
    const release = await generateRelease(variant, (await storeRecord(new MemoryRepository(), record)).snapshot, { software: TEST_SOFTWARE });
    const baseRelease = await generateRelease(base, (await storeRecord(new MemoryRepository(), baseRecord)).snapshot, { software: TEST_SOFTWARE });
    expect(release.files.map((f) => f.route).sort()).toEqual(["customer-pdf", "erp-staging-csv", "registry-prep-json"]);
    const text = (r: typeof release, route: string) => new TextDecoder().decode(r.files.find((f) => f.route === route)!.bytes);

    // the ERP staging CSV and the customer PDF carry the new value, where the stand-in carried the lab's
    const header = text(release, "erp-staging-csv").split("\n")[0].split(";");
    const cell = (t: string, name: string) => t.split("\n")[1].split(";")[header.indexOf(name)];
    const measured = base.routes["erp-staging-csv"].output.find((i) => i.property === target.property)!.csv!.header;
    expect(cell(text(release, "erp-staging-csv"), measured)).toBe(NEW_VALUE);
    expect(cell(text(baseRelease, "erp-staging-csv"), measured)).not.toBe(NEW_VALUE);
    expect(await pdfText(release.files.find((f) => f.route === "customer-pdf")!.bytes)).toContain(NEW_VALUE);
    expect(await pdfText(baseRelease.files.find((f) => f.route === "customer-pdf")!.bytes)).not.toContain(NEW_VALUE);

    // the registry route has no item that reads this property: its draft is still the hold draft, and the value is not in it
    expect(release.files.find((f) => f.route === "registry-prep-json")!.status).toBe("hold");
    expect(text(release, "registry-prep-json")).not.toContain(NEW_VALUE);

    // the value traces to its column in the extract, and the manifest holds places and digests, not values
    const lineage = release.manifest.lineage.filter((e) => e.property === target.property);
    expect(lineage.length).toBeGreaterThanOrEqual(2); // one in each of the two outputs
    expect(lineage.every((e) => e.assertion.role === "erp" && e.assertion.location.endsWith(`column ${NEW_COLUMN}`))).toBe(true);
    expect(JSON.stringify(release.manifest)).not.toContain(NEW_VALUE);
  });

  it("keeps the engine's rules for the new column: a value that disagrees with the laboratory is challenged and holds the route", async () => {
    // the clean laboratory file measures 2.01 mm; the ERP column says 2.37 mm
    const erp = await importErpCsv(variant, { bytes: csvWithColumn(NEW_VALUE), name: "erp.csv", type: "text/csv" });
    const lab = await importLabJson(variant, { bytes: fixtureBytes("n", "d03a-lab-assessment.json"), name: "lab.json", type: "application/json" });
    const record = (await buildRecords([erp, lab])).records[0];
    expect(record.values.find((v) => v.property === target.property)?.status).toBe("challenged");
    expect(verdict(variant, record).find((v) => v.route === "erp-staging-csv")).toMatchObject({ status: "on-hold", holds: ["RR-CHALLENGED"] });
    // a wrong unit or a decimal comma in the new column is refused like any other measured column
    const bad = await importErpCsv(variant, { bytes: csvWithColumn("2,37"), name: "erp.csv", type: "text/csv" });
    expect(bad.ok ? null : bad.errors.map((e) => e.code)).toEqual(["decimal-comma"]);
  });

  it("changed no file under src/", () => {
    const after = sourceState();
    expect(after.hash).toBe(before.hash);
    expect(after.status).toBe(before.status);
    expect(after.diff).toBe(before.diff);
  });
});
