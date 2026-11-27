// @vitest-environment node
/**
 * Cycle 3 (aligned in Cycle 9): disclosure (criterion C3-05, C9-06). The leakage matrix (AT-U): every route x every
 * property and member, on the clean record and on every accepted fixture combination, asserted present, absent or
 * derived-only against `decide`. Derived rules produce only the permitted representations (`recycled_total_with_basis`
 * and `lead_screening`) with zero raw leakage.
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
          expect(p.values.some((v) => v.property === property.id), `${where} has no raw value`).toBe(false);
          if (own.length) expect(derived.has(property.id) !== withheld.has(property.id), `${where}: a statement or a reason`).toBe(true);
          else expect(derived.has(property.id) || withheld.has(property.id)).toBe(false);
        } else {
          for (const v of own) {
            // On customer route, authorisedProductDescriptions selects only the requested language (REF-17)
            if (route === "customer" && property.id === byRole(pack, "narrative") && v.assertions[0]?.details?.language && v.assertions[0].details.language !== p.language) {
              continue;
            }
            expect(projected.has(`${v.property}|${v.member ?? ""}|${v.qualifier ?? ""}`), `${where} ${v.member ?? ""} is present`).toBe(true);
          }
          expect(derived.has(property.id) || withheld.has(property.id), where).toBe(false);
        }
        for (const m of property.members) expect(decide(pack, route, `${property.id}/${m.id}`)).toBe(access);
      }
      const expectedPermitted = record.values.filter((v) => {
        if (decide(pack, route, v.property) !== "permit") return false;
        if (route === "customer" && v.property === byRole(pack, "narrative") && v.assertions[0]?.details?.language && v.assertions[0].details.language !== p.language) {
          return false;
        }
        return true;
      });
      expect(p.values.length).toBe(expectedPermitted.length);
      assertNoLeak(p, record, pack);
    }
  });

  it("checks the same facts for the registry route: only its three permitted properties can be present", async () => {
    const p = project(pack, await recordFor(pack, CLEAN), "registry");
    const permitted = pack.properties.filter((x) => decide(pack, "registry", x.id) === "permit").map((x) => x.id).sort();
    expect(permitted).toHaveLength(3);
    expect([...new Set(p.values.map((v) => v.property))].sort()).toEqual(permitted);
    expect(p.withheld).toHaveLength(pack.properties.length - 3);
  });

  it("withholds what the customer route may not see, with a reason and no value", async () => {
    const record = await recordFor(pack, CLEAN);
    const p = project(pack, record, "customer");
    const denied = pack.properties.filter((prop) => decide(pack, "customer", prop.id) === "deny").map((prop) => prop.id);
    expect(p.withheld.filter((w) => w.decision === "deny").map((w) => w.property).sort()).toEqual([...denied].sort());
    for (const w of p.withheld) {
      expect(Object.keys(w).sort()).toEqual(w.rule ? ["decision", "property", "reason", "rule"] : ["decision", "property", "reason"]);
    }
    // Mg, evidence, and conversion cost are all denied to customer
    expect(denied).toContain(propertyBySlug(pack, "magnesium-content"));
    expect(denied).toContain(propertyBySlug(pack, "evidence-references"));
    expect(denied).toContain(propertyBySlug(pack, "conversion-cost"));
  });

  it("copies each permitted value with its source reference, and nothing of the other source fields", async () => {
    const record = await recordFor(pack, CLEAN);
    const p = project(pack, record, "customer");
    const name = p.values.find((v) => v.property === propertyBySlug(pack, "product-name"))!;
    expect(name.assertions[0].source).toEqual({ role: "ERP extract", position: "row 2, column product_designation" });
    const internal = project(pack, record, "internal");
    const thickness = internal.values.find((v) => v.property === propertyBySlug(pack, "measured-thickness"))!;
    expect(thickness.assertions[0].details?.method_ref).toBeTruthy();
  });

  it("does not let a permitted value carry evidence identifiers to the customer recipient", async () => {
    const record = await recordFor(pack, CLEAN);
    const ids = ["EV-RC-DECL-001", "ST-EV-DIM-01", "ST-EV-CHEM-01", "ST-EV-PB-01", "ST-EV-PCF-01"];
    expect(decide(pack, "customer", byRole(pack, "evidence"))).toBe("deny");
    const customer = JSON.stringify(project(pack, record, "customer"));
    for (const id of ids) expect(customer).not.toContain(id);
    expect(customer).toContain("ST-METHOD-PCF-001");
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
    expect(project(pack, record, "customer").onHold).toBe(false);
    expect(project(pack, record, "registry").onHold).toBe(true);
    const blocked = await recordFor(pack, { ...CLEAN, erp: "erp-missing-thickness.csv" });
    const p = project(pack, blocked, "customer");
    expect(p.onHold).toBe(true);
    expect(p.values.length).toBeGreaterThan(0);
    for (const r of ROUTES) expect(project(pack, blocked, r).onHold).toBe(assess(pack, blocked).find((x) => x.route === r)!.status === "HOLD");
  });

  it("is deterministic and does not change the record", async () => {
    const record = await recordFor(pack, CLEAN);
    const before = JSON.stringify(record);
    for (const r of ROUTES) expect(JSON.stringify(project(pack, record, r))).toBe(JSON.stringify(project(pack, record, r)));
    expect(JSON.stringify(record)).toBe(before);
  });
});

describe("sources in a projection never carry the uploaded file's name", () => {
  const erpName = "SECRET-SUPPLIER-99.csv";
  const labName = "SECRET-PB-31.4.json";

  it("shows the kind of file and the position, for every route", async () => {
    const record = await recordFor(pack, { ...CLEAN, erpName, labName });
    for (const route of ROUTES) {
      const p = project(pack, record, route);
      const json = JSON.stringify(p);
      for (const name of [erpName, labName, ...(route === "customer" ? ["SECRET-SUPPLIER", "31.4"] : [])]) expect(json, `${route} ${name}`).not.toContain(name);
      assertNoLeak(p, record, pack);
      for (const s of [...p.values.flatMap((v) => v.assertions.map((a) => a.source)), ...p.derived.flatMap((d) => d.sources)]) {
        expect(["ERP extract", "Laboratory file"]).toContain(s.role);
        expect(s.position).toMatch(/^(row \d+, column \w+|\/[\w/]+)$/);
        expect(Object.keys(s).sort()).toEqual(["position", "role"]);
      }
    }
    // the operator-side readiness view keeps the full location, file name included
    const sourced = await recordFor(pack, { ...CLEAN, erpName, labName, lab: "lab-conflicting-pre-consumer.json" });
    const hold = assess(pack, sourced)[0].holds.find((h) => h.ruleId === "RR-CHALLENGED")!;
    expect(hold.sources.some((s) => s.location.includes(labName))).toBe(true);
  });
});

describe("assertNoLeak", () => {
  it("detects a raw denied value planted in a projection, and a derived one", async () => {
    const record = await recordFor(pack, CLEAN);
    const p = project(pack, record, "customer");
    expect(() => assertNoLeak(p, record, pack)).not.toThrow();
    const cost = record.values.find((v) => v.property === propertyBySlug(pack, "conversion-cost"))!;
    const planted = { ...p, values: [...p.values, { property: "X", status: "single" as const, assertions: [{ ...cost.assertions[0], source: { role: "ERP extract" as const, position: "p" } }] }] };
    expect(() => assertNoLeak(planted, record, pack)).toThrow(/leak/);
    const lead = record.values.find((v) => v.property === propertyBySlug(pack, "lead-content"))!;
    const raw = { ...p, derived: [...p.derived, { property: "X", rule: "R", sources: [], within: true, basis: `value ${lead.assertions[0].raw} mg/kg`, text: "x", qualification: "q", representation: "lead_screening" as const }] };
    expect(() => assertNoLeak(raw, record, pack)).toThrow(/leak/);
  });
});

describe("derived disclosure (C9-06: recycled_total_with_basis & lead_screening)", () => {
  const recycled = () => propertyBySlug(pack, "recycled-content");
  const lead = () => propertyBySlug(pack, "lead-content");
  const customer = async (c: Combination) => {
    const record = await recordFor(pack, c);
    return { record, p: project(pack, record, "customer") };
  };

  it("derives recycled_total_with_basis and lead_screening cleanly with zero raw Pb/pre/post/evidence leakage", async () => {
    const { record, p } = await customer(CLEAN);
    expect(p.derived.map((d) => d.rule)).toEqual(["DR-RECYCLED-TOTAL", "DR-LEAD-SCREENING"]);
    expect(p.derived[0]).toMatchObject({
      property: recycled(),
      rule: "DR-RECYCLED-TOTAL",
      within: true,
      representation: "recycled_total_with_basis",
    });
    expect(p.derived[0].text).toContain("65 %");
    expect(p.derived[0].text).toContain("RC-BASIS-001");
    expect(p.derived[1]).toMatchObject({
      property: lead(),
      rule: "DR-LEAD-SCREENING",
      within: true,
      representation: "lead_screening",
    });
    expect(p.derived[1].text).toContain("<80 mg/kg");

    const json = JSON.stringify(p);
    // Raw lead value (31.4), raw Mg (2.9), raw cost (1.95), and evidence ID must NEVER appear
    expect(json).not.toContain("31.4");
    expect(json).not.toContain("2.9");
    expect(json).not.toContain("1.95");
    expect(json).not.toContain("EV-RC-DECL-001");
    expect(p.values.some((v) => [recycled(), lead()].includes(v.property))).toBe(false);
    assertNoLeak(p, record, pack);
  });

  it("blocks lead_screening when estimate + expanded_uncertainty >= threshold (unrounded, REF-11/REF-12)", async () => {
    // 79.0 + 1.8 = 80.8 >= 80 -> HOLD
    const over = await customer({ ...CLEAN, editLab: (doc) => (doc.lab_tests.lead.value = 79.0) });
    expect(over.p.derived.find((d) => d.property === lead())).toBeUndefined();
    expect(over.p.withheld.find((w) => w.property === lead())).toMatchObject({ decision: "derived", rule: "DR-LEAD-SCREENING" });
    expect(JSON.stringify(over.p)).not.toContain("79");
    assertNoLeak(over.p, over.record, pack);

    // 78.2 + 1.8 = 80.0 (boundary equal, strictly < required) -> HOLD
    const boundary = await customer({ ...CLEAN, editLab: (doc) => (doc.lab_tests.lead.value = 78.2) });
    expect(boundary.p.derived.find((d) => d.property === lead())).toBeUndefined();
    expect(assess(pack, boundary.record).find((r) => r.route === "customer")!.status).toBe("HOLD");
  });

  it("blocks lead_screening for below_LOQ without coercing to a numeric bound (REF-13)", async () => {
    const loq = await customer({ ...CLEAN, lab: "lab-below-loq.json" });
    expect(loq.p.derived.find((d) => d.property === lead())).toBeUndefined();
    expect(loq.p.withheld.find((w) => w.property === lead())).toMatchObject({ decision: "derived", rule: "DR-LEAD-SCREENING" });
    expect(assess(pack, loq.record).find((r) => r.route === "customer")!.holds.some((h) => h.ruleId === "RR-DERIVED-UNDETERMINABLE")).toBe(true);
  });

  it("blocks recycled_total_with_basis when total != pre + post (REF-06)", async () => {
    const badSum = await customer({ ...CLEAN, editErp: (csv) => csv.replace(",65,15,50,", ",66,15,50,") });
    expect(badSum.p.derived.find((d) => d.property === recycled())).toBeUndefined();
    expect(badSum.p.withheld.find((w) => w.property === recycled())).toMatchObject({ decision: "derived", rule: "DR-RECYCLED-TOTAL" });
    expect(derive(pack, badSum.record, recycled())).toMatchObject({ ok: false });
  });

  it("refuses a property that has no derived rule", async () => {
    const record = await recordFor(pack, CLEAN);
    expect(() => derive(pack, record, byRole(pack, "alloy"))).toThrow(/derived rules, expected exactly one/);
  });

  it("derives only for the customer route: internal gets raw lead, registry gets nothing derived", async () => {
    const record = await recordFor(pack, CLEAN);
    expect(project(pack, record, "internal").derived).toEqual([]);
    expect(project(pack, record, "registry").derived).toEqual([]);
    expect(project(pack, record, "internal").values.some((v) => v.property === lead())).toBe(true);
  });
});
