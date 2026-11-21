// @vitest-environment node
/**
 * Cycle 3: disclosure (criterion C3-05). The leakage matrix (AT-U): every route x every property and member, on the
 * clean record and on every accepted fixture combination, asserted present, absent or derived-only against `decide`.
 * Derived rules produce only the permitted statement, including the outside-limits case.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { derive } from "../../src/model/derived";
import { project } from "../../src/model/disclosure";
import { byRole } from "../../src/model/ingress";
import { decide } from "../../src/model/policy";
import { ROUTES, type ProfilePack } from "../../src/model/profile";
import { assess } from "../../src/model/readiness";
import { assertNoLeak } from "../support/leak";
import { CLEAN, COMBINATIONS, loadPack, propertyBySlug, recordFor, type Combination } from "../support/records";

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});

const label = (c: Combination) => `${c.erp} + ${c.lab ?? "no lab file"}`;

describe("AT-U: the leakage matrix", () => {
  it.each(COMBINATIONS.map((c) => [label(c), c] as const))("route x property x member on %s", async (_, c) => {
    const record = await recordFor(pack, c);
    for (const route of ROUTES) {
      const p = project(pack, record, route);
      const projected = new Set(p.values.map((v) => `${v.property}|${v.member ?? ""}|${v.qualifier ?? ""}`));
      const derived = new Set(p.derived.map((d) => d.property));
      const withheld = new Map(p.withheld.map((w) => [w.property, w]));

      for (const property of pack.properties) {
        const access = decide(pack, route, property.id);
        const own = record.values.filter((v) => v.property === property.id);
        const where = `${route} ${property.id}`;
        if (access === "deny") {
          expect(p.values.some((v) => v.property === property.id), `${where} is absent`).toBe(false);
          expect(derived.has(property.id), where).toBe(false);
          expect(withheld.get(property.id), `${where} is listed as withheld`).toMatchObject({ decision: "deny" });
        } else if (access === "derived") {
          // never as a value, any member included
          expect(p.values.some((v) => v.property === property.id), `${where} has no raw value`).toBe(false);
          if (own.length) expect(derived.has(property.id) !== withheld.has(property.id), `${where}: a statement or a reason`).toBe(true);
          else expect(derived.has(property.id) || withheld.has(property.id)).toBe(false);
        } else {
          // every value and member of a permitted property is present, and nothing is withheld for it
          for (const v of own) expect(projected.has(`${v.property}|${v.member ?? ""}|${v.qualifier ?? ""}`), `${where} ${v.member ?? ""} is present`).toBe(true);
          expect(derived.has(property.id) || withheld.has(property.id), where).toBe(false);
        }
        // members follow their property
        for (const m of property.members) expect(decide(pack, route, `${property.id}/${m.id}`)).toBe(access);
      }
      // nothing in the projection is a value the record does not hold
      expect(p.values.length).toBe(record.values.filter((v) => decide(pack, route, v.property) === "permit").length);
      assertNoLeak(p, record, pack);
    }
  });

  it("checks the same facts for the registry route: only its three permitted properties can be present", async () => {
    const p = project(pack, await recordFor(pack, CLEAN), "registry-prep-json");
    const permitted = pack.properties.filter((x) => decide(pack, "registry-prep-json", x.id) === "permit").map((x) => x.id).sort();
    expect(permitted).toHaveLength(3);
    expect([...new Set(p.values.map((v) => v.property))].sort()).toEqual(permitted);
    expect(p.withheld).toHaveLength(pack.properties.length - 3);
  });

  it("withholds what the customer PDF may not see, with a reason and no value", async () => {
    const record = await recordFor(pack, CLEAN);
    const p = project(pack, record, "customer-pdf");
    const denied = [propertyBySlug(pack, "evidence-references"), propertyBySlug(pack, "primary-supplier")];
    expect(p.withheld.filter((w) => w.decision === "deny").map((w) => w.property).sort()).toEqual([...denied].sort());
    for (const w of p.withheld) {
      expect(Object.keys(w).sort()).toEqual(w.rule ? ["decision", "property", "reason", "rule"] : ["decision", "property", "reason"]);
    }
    const erp = project(pack, record, "erp-staging-csv");
    expect(erp.withheld.map((w) => w.property)).toEqual([propertyBySlug(pack, "product-narrative")]);
  });

  it("copies each permitted value with its source reference, and nothing of the other source fields", async () => {
    const record = await recordFor(pack, CLEAN);
    const p = project(pack, record, "customer-pdf");
    const name = p.values.find((v) => v.property === propertyBySlug(pack, "product-name") && v.qualifier === "en")!;
    expect(name.assertions[0].source).toEqual({ file: "d03a-erp-extract.csv", location: expect.stringContaining("column product_name_en") });
    expect(Object.keys(name.assertions[0].source).sort()).toEqual(["file", "location"]);
    // permitted members keep the method and uncertainty of their own property
    const thickness = p.values.find((v) => v.property === propertyBySlug(pack, "measured-thickness"))!;
    expect(thickness.assertions[0].details?.method).toBeTruthy();
  });

  it("does not let a permitted value carry the evidence record it rests on to a recipient who may not see evidence", async () => {
    const record = await recordFor(pack, CLEAN);
    const ids = ["EV-TR-0417", "EV-CR-0099"];
    expect(decide(pack, "customer-pdf", byRole(pack, "evidence"))).toBe("deny");
    const customer = JSON.stringify(project(pack, record, "customer-pdf"));
    for (const id of ids) expect(customer).not.toContain(id);
    expect(customer).toContain("ISO 14067:2018");
    const erp = JSON.stringify(project(pack, record, "erp-staging-csv"));
    for (const id of ids) expect(erp).toContain(id);
  });

  it("fails closed for a value whose property the profile does not know", async () => {
    const record = await recordFor(pack, CLEAN);
    const stray = { ...record, values: [...record.values, { ...record.values[0], property: "NOT-A-PROPERTY" }] };
    for (const route of ROUTES) {
      const p = project(pack, stray, route);
      expect(p.values.some((v) => v.property === "NOT-A-PROPERTY")).toBe(false);
      expect(p.withheld.find((w) => w.property === "NOT-A-PROPERTY")).toMatchObject({ decision: "deny" });
    }
  });

  it("marks a route on hold as such and still builds its projection", async () => {
    const record = await recordFor(pack, CLEAN);
    expect(project(pack, record, "customer-pdf").onHold).toBe(false);
    expect(project(pack, record, "registry-prep-json").onHold).toBe(true);
    const blocked = await recordFor(pack, { ...CLEAN, erp: "erp-missing-recycled-content.csv" });
    const p = project(pack, blocked, "customer-pdf");
    expect(p.onHold).toBe(true);
    expect(p.values.length).toBeGreaterThan(0);
    for (const r of ROUTES) expect(project(pack, blocked, r).onHold).toBe(assess(pack, blocked).find((x) => x.route === r)!.status === "on-hold");
  });

  it("is deterministic and does not change the record", async () => {
    const record = await recordFor(pack, CLEAN);
    const before = JSON.stringify(record);
    for (const r of ROUTES) expect(JSON.stringify(project(pack, record, r))).toBe(JSON.stringify(project(pack, record, r)));
    expect(JSON.stringify(record)).toBe(before);
  });
});

describe("assertNoLeak", () => {
  it("detects a raw denied value planted in a projection, and a derived one", async () => {
    const record = await recordFor(pack, CLEAN);
    const p = project(pack, record, "customer-pdf");
    expect(() => assertNoLeak(p, record, pack)).not.toThrow();
    const supplier = record.values.find((v) => v.property === propertyBySlug(pack, "primary-supplier"))!;
    const planted = { ...p, values: [...p.values, { property: "X", status: "single" as const, assertions: [{ ...supplier.assertions[0], source: { file: "f", location: "l" } }] }] };
    expect(() => assertNoLeak(planted, record, pack)).toThrow(/leak/);
    const tensile = record.values.find((v) => v.property === propertyBySlug(pack, "tensile-strength"))!;
    const raw = { ...p, derived: [...p.derived, { property: "X", rule: "R", within: true, basis: `value ${tensile.assertions[0].raw} MPa` }] };
    expect(() => assertNoLeak(raw, record, pack)).toThrow(/leak/);
  });
});

describe("derived disclosure", () => {
  const tensile = () => propertyBySlug(pack, "tensile-strength");
  const composition = () => propertyBySlug(pack, "chemical-composition");
  const customer = async (c: Combination) => {
    const record = await recordFor(pack, c);
    return { record, p: project(pack, record, "customer-pdf") };
  };

  it("gives the clean record's strength and composition as within the limits, with the basis, and nothing else", async () => {
    const { record, p } = await customer(CLEAN);
    expect(p.derived).toEqual([
      { property: tensile(), rule: "DR-TENSILE-LIMITS", within: true, basis: "EN 485-2, EN AW-5754 H111" },
      { property: composition(), rule: "DR-COMPOSITION-LIMITS", within: true, basis: "EN 573-3, EN AW-5754" },
    ]);
    for (const d of p.derived) expect(Object.keys(d).sort()).toEqual(["basis", "property", "rule", "within"]);
    const json = JSON.stringify(p);
    for (const v of record.values.filter((x) => [tensile(), composition()].includes(x.property))) {
      for (const a of v.assertions) {
        expect(json).not.toContain(a.raw);
        expect(json).not.toContain(a.details?.method ?? "no method");
      }
    }
    expect(p.values.some((v) => [tensile(), composition()].includes(v.property))).toBe(false);
  });

  it("says outside for a strength above the limits, built with an edited laboratory value", async () => {
    const { p, record } = await customer({ ...CLEAN, editLab: (doc) => (doc.observations[1].value = 260) });
    expect(p.derived.find((d) => d.property === tensile())).toEqual({ property: tensile(), rule: "DR-TENSILE-LIMITS", within: false, basis: "EN 485-2, EN AW-5754 H111" });
    expect(JSON.stringify(p)).not.toContain("260");
    assertNoLeak(p, record, pack);
  });

  it("says outside for a strength below the limits", async () => {
    const { p } = await customer({ ...CLEAN, editLab: (doc) => (doc.observations[1].value = 150) });
    expect(p.derived.find((d) => d.property === tensile())!.within).toBe(false);
  });

  it("treats the limit values themselves as within", async () => {
    for (const edge of [190, 240]) {
      const { p } = await customer({ ...CLEAN, editLab: (doc) => (doc.observations[1].value = edge) });
      expect(p.derived.find((d) => d.property === tensile())!.within, String(edge)).toBe(true);
    }
  });

  it("says outside for one element over its limit, and within again when all are in", async () => {
    const out = await customer({ ...CLEAN, editLab: (doc) => (doc.observations[2].value = 4.37) });
    expect(out.p.derived.find((d) => d.property === composition())).toEqual({ property: composition(), rule: "DR-COMPOSITION-LIMITS", within: false, basis: "EN 573-3, EN AW-5754" });
    expect(JSON.stringify(out.p)).not.toContain("4.37");
    const upper = await customer({ ...CLEAN, editLab: (doc) => (doc.observations[3].value = 0.9) });
    expect(upper.p.derived.find((d) => d.property === composition())!.within).toBe(false);
  });

  it("makes no statement when the limits cannot decide, and withholds with the rule and a reason", async () => {
    // an alloy and temper the illustrative table does not cover
    const { record, p } = await customer({
      ...CLEAN,
      editErp: (csv) => csv.replace("EN AW-5754;H111", "EN AW-6082;H111"),
      editLab: (doc) => (doc.product.alloy = "EN AW-6082"),
    });
    expect(p.derived.find((d) => d.property === tensile())).toBeUndefined();
    expect(p.withheld.find((w) => w.property === tensile())).toMatchObject({ decision: "derived", rule: "DR-TENSILE-LIMITS" });
    expect(p.withheld.find((w) => w.property === tensile())!.reason).toMatch(/no limits for EN AW-6082 H111/);
    expect(derive(pack, record, tensile())).toMatchObject({ ok: false });
    // readiness agrees: the route holds on it
    expect(assess(pack, record).find((r) => r.route === "customer-pdf")!.holds.some((h) => h.ruleId === "RR-DERIVED-UNDETERMINABLE" && h.property === tensile())).toBe(true);
  });

  it("makes no statement for a challenged alloy, or when the composition reports an element with no limits", async () => {
    const challenged = await customer({ ...CLEAN, lab: "lab-conflicting-alloy.json" });
    expect(challenged.p.derived).toEqual([]);
    const unknownElement = await customer({ ...CLEAN, editLab: (doc) => (doc.observations[3].element = "Zn") });
    expect(unknownElement.p.derived.map((d) => d.property)).toEqual([tensile()]);
    expect(unknownElement.p.withheld.find((w) => w.property === composition())!.reason).toMatch(/no limits for Zn/);
  });

  it("refuses a property that has no derived rule", async () => {
    const record = await recordFor(pack, CLEAN);
    expect(() => derive(pack, record, byRole(pack, "alloy"))).toThrow(/derived rules, expected exactly one/);
  });

  it("derives only for the customer PDF: the ERP route gets the values, the registry nothing", async () => {
    const record = await recordFor(pack, CLEAN);
    expect(project(pack, record, "erp-staging-csv").derived).toEqual([]);
    expect(project(pack, record, "registry-prep-json").derived).toEqual([]);
    expect(project(pack, record, "erp-staging-csv").values.some((v) => v.property === tensile())).toBe(true);
  });
});
