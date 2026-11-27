// @vitest-environment node
/**
 * The frozen N contract pack and its fixture pack agree (criteria C0-01 and C0-05).
 *
 * contracts/n is the public stand-in for the private pack (decision D1-01, option b). These tests check
 * that it is frozen, that a one-byte change is caught, and that every fixture follows the contracts:
 * the valid inputs conform, and each failure fixture carries exactly the defect its class names.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { fixtureBytes } from "../support/fixtures";

const ROOT = resolve(__dirname, "../..");
const PACK = join(ROOT, "contracts/n");
const yaml = (path: string) => parse(readFileSync(join(PACK, path), "utf8"));
const text = (name: string) => new TextDecoder("utf-8", { fatal: true }).decode(fixtureBytes("n", name));

type Property = { id: string; unit: string | null; required_by: Record<string, boolean> };
type Column = { name: string; maps_to: string; code_list?: string; required: boolean };
const profile = yaml("profile/PROFILE-ALU-24-01@1.0.0.yaml") as { status: string; properties: Property[] };
const erp = yaml("inputs/erp-extract.csv.contract.yaml") as { delimiter: string; columns: Column[] };
const lab = yaml("inputs/lab-assessment.contract.yaml") as { allowed_units: Record<string, string[]> };
const ids = new Set(profile.properties.map((p) => p.id));
const baseId = (mapsTo: string) => mapsTo.split("/")[0];

const checker = (...args: string[]) =>
  execFileSync("node", ["scripts/check-contracts.mjs", ...args], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });

function rows(csv: string) {
  const [head, ...body] = csv.trimEnd().split("\n");
  const cols = head.split(erp.delimiter);
  return { cols, rows: body.map((l) => Object.fromEntries(l.split(erp.delimiter).map((v, i) => [cols[i], v]))) };
}

/** Codes of a pinned code-list file, by name or exact id@version. */
const codeValues = (list: string) =>
  readFileSync(join(PACK, `code-lists/${list.includes("@") ? list : `${list}@1.0.0`}.csv`), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .slice(1)
    .map((l) => l.split(",")[0]);

describe("C0-01 frozen contract pack", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pack-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("is frozen with 24 properties and passes the checker", () => {
    expect(profile.status).toBe("FROZEN");
    expect(profile.properties).toHaveLength(24);
    expect(checker("--require-frozen")).toContain("Pack frozen; all checks passed");
  });

  it("fails the checker after a one-byte change to a frozen file", () => {
    cpSync(PACK, tmp, { recursive: true });
    const file = join(tmp, "profile/PROFILE-ALU-24-01@1.0.0.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("unit: mm", "unit: cm"));
    expect(() => checker("--pack", tmp)).toThrow(/does not match its digest/);
  });
});

describe("R1-3 the pack must carry the owner's digest approval", () => {
  const scratch = mkdtempSync(join(tmpdir(), "signed-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("passes --require-signed as committed", () => {
    expect(checker("--require-frozen", "--require-signed")).toContain("Owner digest approval by");
  });

  it("refuses an edited pack whose manifest was rewritten without updated owner digest approval", () => {
    cpSync(join(ROOT, "contracts"), scratch, { recursive: true });
    const pack = join(scratch, "n");
    const list = join(pack, "code-lists/TEMPER@1.0.0.csv");
    writeFileSync(list, `${readFileSync(list, "utf8")}H14\n`);
    try {
      checker("--pack", pack, "--write");
    } catch {
      // the manifest is written before the rules run
    }
    expect(checker("--pack", pack, "--require-frozen")).toContain("Pack frozen");
    expect(() => checker("--pack", pack, "--require-signed")).toThrow(/is not the approved digest/);
  });
});

describe("R1-4 nested members carry no unit in a mapping", () => {
  const scratch = mkdtempSync(join(tmpdir(), "member-unit-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("refuses an ERP column that states a unit for a nested member", () => {
    cpSync(PACK, scratch, { recursive: true });
    const file = join(scratch, "inputs/erp-extract.csv.contract.yaml");
    const text = readFileSync(file, "utf8");
    const changed = text.replace(/(maps_to: ALU-D\d{3}\/FLD-Identifier-value\n\s+unit:) null/, "$1 mm");
    expect(changed).not.toBe(text);
    writeFileSync(file, changed);
    try {
      checker("--pack", scratch, "--write");
    } catch {
      // the manifest is written before the rules run
    }
    expect(() => checker("--pack", scratch)).toThrow(/nested member .* carries no unit/);
  });
});

describe("C0-05 N fixtures follow the frozen contracts", () => {
  it("valid ERP extract has every contract column, known codes and values for required columns", () => {
    const { cols, rows: data } = rows(text("erp-extract.csv"));
    expect(cols).toEqual(erp.columns.map((c) => c.name));
    for (const c of erp.columns) {
      expect(ids.has(baseId(c.maps_to)), c.name).toBe(true);
      for (const r of data) {
        if (c.required) expect(r[c.name], c.name).not.toBe("");
        if (c.code_list) expect(codeValues(c.code_list), c.name).toContain(r[c.name]);
      }
    }
  });

  it("valid laboratory file uses profile properties and allowed units, with one footprint", () => {
    const doc = JSON.parse(text("lab-assessment.json"));
    for (const o of [doc.lab_tests.thickness, doc.lab_tests.magnesium, doc.lab_tests.lead]) {
      expect(ids.has(o.property_ref)).toBe(true);
      expect(lab.allowed_units[o.property_ref]).toContain(o.unit_id);
      expect(Number.isFinite(o.value)).toBe(true);
    }
    expect(Number.isFinite(doc.assessment.result.result)).toBe(true);
    const erpRow = rows(text("erp-extract.csv")).rows[0];
    expect(doc.batch_id).toBe(erpRow.batch_id);
  });

  it("each failure fixture carries the defect of its class", () => {
    expect(() => text("erp-latin1.csv")).toThrow();
    expect(rows(text("erp-missing-alloy-column.csv")).cols).not.toContain("alloy_code");
    expect(rows(text("erp-unknown-company-code.csv")).rows[0].material_code).toBe("UNKNOWN");
    const blocked = rows(text("erp-missing-thickness.csv")).rows[0];
    expect(blocked.nominal_thickness_mm).toBe("");
    const thick = erp.columns.find((c) => c.name === "nominal_thickness_mm")!;
    expect(thick.required).toBe(false);
    expect(profile.properties.find((p) => p.id === thick.maps_to)!.required_by["customer"]).toBe(true);

    const labFile = (name: string) => JSON.parse(text(name));
    expect(labFile("lab-incompatible-footprint.json").assessment.result.method_ref).not.toBe(
      labFile("lab-incompatible-footprint.json").assessment.context.method.id,
    );
    expect(labFile("lab-conflicting-pre-consumer.json").recycled_content.conflicting_pre_percent).not.toBeNull();
    expect(labFile("lab-missing-unit.json").lab_tests.thickness.unit_id).toBeNull();
    const wrong = labFile("lab-wrong-unit.json").lab_tests.thickness;
    expect(lab.allowed_units[wrong.property_ref]).not.toContain(wrong.unit_id);
    expect(text("lab-duplicate-key.json")).toMatch(/"value":\s*1\.49,\s*\n\s*"value":\s*2\.05/);
    expect(labFile("lab-non-finite.json").lab_tests.lead.value).toBe(Infinity);
  });

  it("the prohibited-disclosure route variant requires only properties the matrix denies", () => {
    const route = parse(text("routes/customer-requires-denied.yaml")) as { requires: string[] };
    const matrix = readFileSync(join(PACK, "policy/actor-field-matrix.csv"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("ALU-"))
      .map((l) => l.split(","));
    const denied = matrix.filter((r) => r[1] === "deny").map((r) => r[0]);
    expect(route.requires.length).toBeGreaterThan(0);
    expect(denied).toEqual(expect.arrayContaining(route.requires));
  });

  it("every failure case names a fixture in the pinned pack", () => {
    for (const name of readFileSync(join(PACK, "MANIFEST.json"), "utf8").match(/failure-cases\/[\w-]+\.yaml/g)!) {
      const fixture = (yaml(name) as { fixture: string }).fixture;
      expect(fixture.startsWith("fixtures/n/"), name).toBe(true);
      expect(() => fixtureBytes("n", fixture.slice("fixtures/n/".length))).not.toThrow();
    }
  });
});
