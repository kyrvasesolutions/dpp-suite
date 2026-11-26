// @vitest-environment node
/**
 * The pack-only acceptance change (aligned in Cycle 9): one optional ERP column, mapped to an existing property
 * (`measuredSheetThickness`) that no ERP column fills yet and that the internal staging CSV reads, is added to a
 * temporary copy of the stand-in pack through the contract checker alone. Import, readiness, and internal CSV then
 * carry the new value, and no file under src/ changes.
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
import { loadProfilePack, type ProfilePack } from "../../src/model/profile";
import { assess } from "../../src/model/readiness";
import { MemoryRepository, storeRecord } from "../../src/model/recordRepository";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, propertyBySlug } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

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
  const [head, row] = new TextDecoder().decode(fixtureBytes("n", CLEAN.erp)).trimEnd().split("\n");
  return new TextEncoder().encode(`${head},${NEW_COLUMN}\n${row},${value}\n`);
};

beforeAll(async () => {
  before = sourceState();
  base = await loadProfilePack(readPack("contracts/n"));

  const property = propertyBySlug(base, "measured-thickness");
  const info = base.properties.find((p) => p.id === property)!;
  expect(base.inputs.erp.columns.some((c) => c.maps_to.split("/")[0] === property)).toBe(false);
  expect(base.routes.internal.output.some((i) => i.property === property && i.reads.kind === "value")).toBe(true);
  target = { property, unit: info.unit! };

  dir = mkdtempSync(join(tmpdir(), "dpp-variant-"));
  cpSync("contracts/n", join(dir, "contracts/n"), { recursive: true });
  const file = join(dir, "contracts/n/inputs/erp-extract.csv.contract.yaml");
  const doc = parseDocument(readFileSync(file, "utf8"));
  doc.addIn(["columns"], doc.createNode({ name: NEW_COLUMN, maps_to: target.property, unit: target.unit, required: false }));
  writeFileSync(file, doc.toString({ lineWidth: 0 }));

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
    const changed = variant.pins.filter((p, i) => p.digest !== base.pins[i]!.digest).map((p) => p.path);
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
    expect((await importErpCsv(base, { bytes: fixtureBytes("n", CLEAN.erp), name: "erp.csv", type: "text/csv" })).ok).toBe(true);
  });

  it("keeps the engine's rules for the new column: disagreement with lab challenges and holds internal route, while customer stays RELEASED", async () => {
    const erp = await importErpCsv(variant, { bytes: csvWithColumn(NEW_VALUE), name: "erp.csv", type: "text/csv" });
    const lab = await importLabJson(variant, { bytes: fixtureBytes("n", CLEAN.lab), name: "lab.json", type: "application/json" });
    const record = (await buildRecords([erp, lab], variant)).records[0]!;
    expect(record.values.find((v) => v.property === target.property)?.status).toBe("challenged");
    const verdicts = assess(variant, record).map((x) => ({ route: x.route, status: x.status, holds: x.holds.map((h) => h.ruleId) }));
    expect(verdicts.find((v) => v.route === "internal")).toMatchObject({ status: "HOLD", holds: ["RR-CHALLENGED"] });
    expect(verdicts.find((v) => v.route === "customer")?.status).toBe("RELEASED");

    // Agreeing value (1.49 mm matching lab) releases both customer and internal and traces lineage to both sources
    const erpAgree = await importErpCsv(variant, { bytes: csvWithColumn("1.49"), name: "erp.csv", type: "text/csv" });
    const agreeing = (await buildRecords([erpAgree, lab], variant)).records[0]!;
    expect(agreeing.values.find((v) => v.property === target.property)?.status).toBe("agreeing");
    const rel = await generateRelease(variant, (await storeRecord(new MemoryRepository(), agreeing)).snapshot, { software: TEST_SOFTWARE });
    expect(rel.files.map((f) => f.route).sort()).toEqual(["customer", "internal", "registry"]);
    const lineage = rel.manifest.lineage.filter((e) => e.property === target.property);
    expect(lineage.some((e) => e.assertion.role === "erp" && e.assertion.location.endsWith(`column ${NEW_COLUMN}`))).toBe(true);

    // Decimal comma in the new column is refused like any numeric column
    const bad = await importErpCsv(variant, { bytes: csvWithColumn('"2,37"'), name: "erp.csv", type: "text/csv" });
    expect(bad.ok ? null : bad.errors.map((e) => e.code)).toEqual(["decimal-comma"]);
  });

  it("changed no file under src/", () => {
    const after = sourceState();
    expect(after.hash).toBe(before.hash);
    expect(after.status).toBe(before.status);
    expect(after.diff).toBe(before.diff);
  });
});
