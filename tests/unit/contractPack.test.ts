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

describe("C0-05 N fixtures follow the frozen contracts", () => {
  it("valid ERP extract has every contract column, known codes and values for required columns", () => {
    const { cols, rows: data } = rows(text("d03a-erp-extract.csv"));
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
    const doc = JSON.parse(text("d03a-lab-assessment.json"));
    for (const o of [...doc.observations, ...doc.footprints]) {
      expect(ids.has(o.property)).toBe(true);
      expect(lab.allowed_units[o.property]).toContain(o.unit);
      expect(Number.isFinite(o.value)).toBe(true);
    }
    expect(doc.footprints).toHaveLength(1);
    const erpRow = rows(text("d03a-erp-extract.csv")).rows[0];
    expect(doc.product).toEqual({ model_id: erpRow.product_model_id, batch_id: erpRow.batch_id, alloy: erpRow.alloy });
  });

  it("each failure fixture carries the defect of its class", () => {
    const valid = rows(text("d03a-erp-extract.csv")).rows[0];
    expect(() => text("erp-latin1.csv")).toThrow();
    expect(rows(text("erp-missing-alloy-column.csv")).cols).not.toContain("alloy");
    expect(codeValues("COMPANY")).not.toContain(rows(text("erp-unknown-company-code.csv")).rows[0].company_code);
    const blocked = rows(text("erp-missing-recycled-content.csv")).rows[0];
    expect(blocked.recycled_content_pct).toBe("");
    const recycled = erp.columns.find((c) => c.name === "recycled_content_pct")!;
    expect(recycled.required).toBe(false);
    expect(profile.properties.find((p) => p.id === recycled.maps_to)!.required_by["customer-pdf"]).toBe(true);

    const labFile = (name: string) => JSON.parse(text(name));
    expect(labFile("lab-two-footprints.json").footprints).toHaveLength(2);
    expect(labFile("lab-conflicting-alloy.json").product.alloy).not.toBe(valid.alloy);
    expect(labFile("lab-missing-unit.json").observations[0].unit).toBeNull();
    const wrong = labFile("lab-wrong-unit.json").observations[0];
    expect(lab.allowed_units[wrong.property]).not.toContain(wrong.unit);
    expect(text("lab-duplicate-key.json").match(/"value": 2\.\d+,/g)).toHaveLength(2);
    expect(labFile("lab-non-finite.json").observations[1].value).toBe(Infinity);
  });

  it("the prohibited-disclosure route variant requires only properties the matrix denies", () => {
    const route = parse(text("routes/customer-pdf-requires-denied.yaml")) as { requires: string[] };
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
