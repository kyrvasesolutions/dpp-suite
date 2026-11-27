// @vitest-environment node
/**
 * Cycle 3 (aligned in Cycle 9): route readiness (criteria C3-02, C3-03, C3-04, C3-06, C9-01..C9-06),
 * on the synthetic public stand-in pack.
 *
 * Each state and each rule ID on purpose-built records, the prohibited-disclosure route variant (the negative
 * test: a hold, never a value), AT-T (every hold resolves to a rule and a source), and determinism.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { byRole } from "../../src/model/ingress";
import type { ProfilePack, Route } from "../../src/model/profile";
import { assess, ruleText, selectFootprint, structuralChecks, type RouteReadiness } from "../../src/model/readiness";
import { fixtureBytes } from "../support/fixtures";
import { ACCEPTED_ERP, CLEAN, COMBINATIONS, loadPack, propertyBySlug, recordFor, type Combination } from "../support/records";

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});

const of = (rs: RouteReadiness[], route: Route) => rs.find((r) => r.route === route)!;
const rules = (r: RouteReadiness) => r.holds.map((h) => h.ruleId);
const stateOf = (r: RouteReadiness, property: string) => r.required.find((p) => p.property === property)?.state;

describe("the clean pair", () => {
  it("releases customer and internal routes and keeps registry on its standing hold", async () => {
    const rs = assess(pack, await recordFor(pack, CLEAN));
    expect(of(rs, "customer").status).toBe("RELEASED");
    expect(of(rs, "internal").status).toBe("RELEASED");
    expect(of(rs, "registry").status).toBe("HOLD");
    expect(rules(of(rs, "registry"))).toEqual(["RR-STANDING-HOLD"]);
    for (const r of rs) for (const p of r.required) expect(p, `${r.route} ${p.property}`).toMatchObject({ state: "present", assured: true });
  });

  it("lists exactly the properties each route requires", async () => {
    const rs = assess(pack, await recordFor(pack, CLEAN));
    for (const r of rs) {
      expect(r.required.map((p) => p.property).sort()).toEqual(pack.properties.filter((p) => p.requiredBy[r.route]).map((p) => p.id).sort());
    }
  });

  it("states the recipient of each route", async () => {
    const rs = assess(pack, await recordFor(pack, CLEAN));
    for (const r of rs) expect(r.recipient).toBe(pack.routes[r.route].recipient);
  });
});

describe("required and missing (C3-02, C3-03)", () => {
  it("holds the routes that require the missing nominal thickness, and only those", async () => {
    const rs = assess(pack, await recordFor(pack, { ...CLEAN, erp: "erp-missing-thickness.csv" }));
    const thickness = propertyBySlug(pack, "nominal-thickness");
    for (const route of ["customer", "internal"] as const) {
      expect(stateOf(of(rs, route), thickness)).toBe("missing");
      expect(of(rs, route).status).toBe("HOLD");
      expect(of(rs, route).holds).toEqual([{ ruleId: "RR-MISSING", property: thickness, sources: [] }]);
    }
    expect(rules(of(rs, "registry"))).toEqual(["RR-STANDING-HOLD"]);
  });

  it("holds only the routes that require an optional ERP property that is absent", async () => {
    // internal_conversion_cost is required by internal, not customer
    const cost = propertyBySlug(pack, "conversion-cost");
    expect(pack.properties.find((p) => p.id === cost)!.requiredBy).toEqual({ customer: false, internal: true, registry: false });
    const record = await recordFor(pack, { ...CLEAN, editErp: (csv) => csv.replace(/,1\.95\r?\n/, ",\n") });
    expect(record.values.some((v) => v.property === cost)).toBe(false);
    const rs = assess(pack, record);
    expect(of(rs, "customer").status).toBe("RELEASED");
    expect(of(rs, "internal").holds).toEqual([{ ruleId: "RR-MISSING", property: cost, sources: [] }]);
  });
});

describe("challenged (C3-03)", () => {
  it("holds customer on conflicting pre-consumer recycled share while keeping internal RELEASED", async () => {
    const rs = assess(pack, await recordFor(pack, { ...CLEAN, lab: "lab-conflicting-pre-consumer.json" }));
    const pre = byRole(pack, "recycledPre");
    const customer = of(rs, "customer");
    expect(stateOf(customer, pre)).toBe("challenged");
    const hold = customer.holds.find((h) => h.ruleId === "RR-CHALLENGED")!;
    expect(hold.property).toBe(pre);
    expect(hold.sources.map((s) => s.file).sort()).toEqual(["erp-extract.csv", "lab-conflicting-pre-consumer.json"]);
    expect(hold.sources.every((s) => s.location.length > 0)).toBe(true);
    expect(customer.status).toBe("HOLD");
    expect(of(rs, "internal").status).toBe("RELEASED");
    expect(rules(of(rs, "registry"))).toEqual(["RR-STANDING-HOLD"]);
  });
});

describe("unknown code (C3-03)", () => {
  it("holds customer route on unknown temper code while preserving raw assertions", async () => {
    const record = await recordFor(pack, { ...CLEAN, editErp: (csv) => csv.replace(",5754,O,", ",5754,H99,") });
    const temper = byRole(pack, "temper");
    const rs = assess(pack, record);
    const hold = of(rs, "customer").holds.find((h) => h.ruleId === "RR-UNKNOWN-CODE")!;
    expect(hold.property).toBe(temper);
    expect(hold.sources).toHaveLength(1);
    expect(of(rs, "customer").required.find((p) => p.property === temper)).toMatchObject({ state: "present", assured: false });
    expect(of(rs, "customer").status).toBe("HOLD");
  });
});

describe("carbon footprint selection & compatibility (C3-04)", () => {
  it("selects the single result of a clean record", async () => {
    const f = selectFootprint(pack, await recordFor(pack, CLEAN));
    expect(f.state).toBe("selected");
    expect(f.selected).toBeDefined();
    expect(f.candidates).toHaveLength(1);
  });

  it("holds customer route when footprint context is incompatible while keeping internal RELEASED", async () => {
    const record = await recordFor(pack, { ...CLEAN, lab: "lab-incompatible-footprint.json" });
    const footprint = byRole(pack, "footprint");
    const rs = assess(pack, record);
    expect(of(rs, "customer").status).toBe("HOLD");
    expect(of(rs, "customer").holds.some((h) => h.property === footprint)).toBe(true);
    expect(of(rs, "internal").status).toBe("RELEASED");
    expect(rules(of(rs, "registry"))).toEqual(["RR-STANDING-HOLD"]);
  });

  it("reports no footprint when the laboratory file is missing, and holds on the missing value", async () => {
    const record = await recordFor(pack, { erp: ACCEPTED_ERP[0] });
    expect(selectFootprint(pack, record).state).toBe("none");
    expect(rules(of(assess(pack, record), "customer"))).toContain("RR-MISSING");
  });
});

describe("insufficient assurance and drafts (C3-03)", () => {
  it("holds affected routes when source_assurance is unknown", async () => {
    const rs = assess(pack, await recordFor(pack, { ...CLEAN, lab: "lab-assurance-unknown.json" }));
    const lead = byRole(pack, "lead");
    expect(of(rs, "customer").holds.some((h) => h.ruleId === "RR-EVIDENCE-DIGEST" && h.property === lead)).toBe(true);
    expect(of(rs, "internal").holds.some((h) => h.ruleId === "RR-EVIDENCE-DIGEST" && h.property === lead)).toBe(true);
    expect(of(rs, "customer").status).toBe("HOLD");
    expect(of(rs, "internal").status).toBe("HOLD");
  });

  it("holds customer route on a text that is not authorised, and not internal, which does not require it", async () => {
    const record = await recordFor(pack, { ...CLEAN, editLab: (doc) => (doc.authorised_texts[0].approval_state = "draft") });
    const rs = assess(pack, record);
    const hold = of(rs, "customer").holds.find((h) => h.ruleId === "RR-DRAFT-TEXT")!;
    expect(hold.property).toBe(byRole(pack, "narrative"));
    expect(hold.sources).toHaveLength(1);
    expect(of(rs, "internal").status).toBe("RELEASED");
  });
});

describe("inaccessible: the prohibited-disclosure route variant (C3-02 negative test)", () => {
  const variant = parse(new TextDecoder().decode(fixtureBytes("n", "routes/customer-requires-denied.yaml"))) as { requires: string[] };

  it("requires properties the matrix denies to the customer recipient", () => {
    expect(variant.requires.length).toBeGreaterThanOrEqual(2);
    for (const id of variant.requires) expect(pack.matrix[id].customer).toBe("deny");
  });

  it("holds the route with the state inaccessible and never shows a value", async () => {
    const record = await recordFor(pack, CLEAN);
    const rs = assess(pack, record, { requires: { customer: variant.requires } });
    const r = of(rs, "customer");
    expect(r.status).toBe("HOLD");
    for (const id of variant.requires) {
      expect(stateOf(r, id)).toBe("inaccessible");
      const hold = r.holds.find((h) => h.ruleId === "RR-INACCESSIBLE" && h.property === id)!;
      expect(hold.sources.length).toBeGreaterThan(0);
      expect(r.required.find((p) => p.property === id)).toMatchObject({ assured: false, flags: [] });
    }
    // No raw value of a denied property is anywhere in the result
    const json = JSON.stringify(r);
    for (const v of record.values.filter((x) => variant.requires.includes(x.property))) {
      for (const a of v.assertions) expect(json).not.toContain(a.raw);
    }
    // The other routes are unaffected by the variant
    expect(of(rs, "internal").status).toBe("RELEASED");
  });

  it("holds as both inaccessible and missing when the denied property has no assertion to point to", async () => {
    const record = await recordFor(pack, { erp: CLEAN.erp });
    const evidence = byRole(pack, "evidence");
    const r = of(assess(pack, record, { requires: { customer: [evidence] } }), "customer");
    expect(stateOf(r, evidence)).toBe("inaccessible");
    expect(r.holds.filter((h) => h.property === evidence)).toEqual([
      { ruleId: "RR-INACCESSIBLE", property: evidence, detail: "required_raw_output_disclosure_denied", sources: [] },
      { ruleId: "RR-MISSING", property: evidence, sources: [] },
    ]);
  });

  it("changes nothing for the real routes", async () => {
    const record = await recordFor(pack, CLEAN);
    expect(assess(pack, record, {})).toEqual(assess(pack, record));
  });
});

describe("AT-T: every hold resolves to a rule and a source assertion", () => {
  const ruleIds = () => new Set(pack.policy.readiness.rules.map((r) => r.id));

  it.each(COMBINATIONS.map((c) => [`${c.erp} + ${c.lab ?? "no lab file"}`, c] as const))("holds of %s", async (_, c: Combination) => {
    const record = await recordFor(pack, c);
    for (const r of assess(pack, record)) {
      for (const h of r.holds) {
        expect(ruleIds().has(h.ruleId), h.ruleId).toBe(true);
        expect(ruleText(pack, h.ruleId).length).toBeGreaterThan(10);
        const alsoMissing = h.ruleId === "RR-INACCESSIBLE" && r.holds.some((x) => x.ruleId === "RR-MISSING" && x.property === h.property);
        if (
          h.ruleId !== "RR-MISSING" &&
          h.ruleId !== "RR-STANDING-HOLD" &&
          h.ruleId !== "RR-DERIVED-UNDETERMINABLE" &&
          h.ruleId !== "RR-SHAPE-ERROR" &&
          h.ruleId !== "RR-CONTEXT-UNRESOLVED" &&
          !alsoMissing
        ) {
          expect(h.sources.length, `${r.route} ${h.ruleId} has a source`).toBeGreaterThan(0);
          expect(h.property).not.toBeNull();
        }
        const files = new Set(record.sources.map((s) => s.name));
        for (const s of h.sources) expect(files.has(s.file), s.file).toBe(true);
        if (h.property !== null) expect(pack.properties.some((p) => p.id === h.property)).toBe(true);
      }
      expect(r.status).toBe(r.holds.length ? "HOLD" : "RELEASED");
    }
  });

  it("names a rule of the pack in every place the code writes a rule ID", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? files(p) : [p];
      });
    const known = new Set([...pack.policy.readiness.rules, ...pack.policy.readiness.checks, ...pack.policy.derived.rules].map((r) => r.id));
    const used = new Set<string>();
    for (const f of files("src").filter((x) => /\.(ts|tsx)$/.test(x))) {
      for (const m of readFileSync(f, "utf8").matchAll(/\b(?:RR|CK|DR)-[A-Z]+(?:-[A-Z]+)*\b/g)) used.add(m[0]);
    }
    expect([...used].filter((id) => !known.has(id))).toEqual([]);
    for (const r of pack.policy.readiness.rules) expect(used.has(r.id), r.id).toBe(true);
  });
});

describe("structural checks (C3-06)", () => {
  it("pass on every accepted combination and state no conformity", async () => {
    for (const c of COMBINATIONS) {
      const checks = structuralChecks(pack, await recordFor(pack, c));
      expect(checks.map((k) => k.id)).toEqual(["CK-IDENTIFIERS", "CK-PROFILE", "CK-RECORD-SCHEMA"]);
      expect(checks.every((k) => k.passed)).toBe(true);
      for (const k of checks) expect(`${k.text} ${k.detail ?? ""}`).not.toMatch(/\bconform\b|\bcomplian/i);
    }
  });

  it("fail when an identifier is missing or a value is outside the profile", async () => {
    const record = await recordFor(pack, CLEAN);
    const noBatch = { ...record, values: record.values.filter((v) => v.property !== byRole(pack, "batch")) };
    expect(structuralChecks(pack, noBatch).find((k) => k.id === "CK-IDENTIFIERS")).toMatchObject({ passed: false, detail: "missing: batch" });
    const stray = { ...record, values: [...record.values, { ...record.values[0], property: "NOT-A-PROPERTY" }] };
    expect(structuralChecks(pack, stray).find((k) => k.id === "CK-PROFILE")).toMatchObject({ passed: false });
  });
});

describe("determinism", () => {
  it("gives the same result for the same record, on a fresh import too, and does not change its input", async () => {
    const a = await recordFor(pack, { ...CLEAN, lab: "lab-incompatible-footprint.json" });
    const b = await recordFor(pack, { ...CLEAN, lab: "lab-incompatible-footprint.json" });
    const before = JSON.stringify(a);
    expect(JSON.stringify(assess(pack, a))).toBe(JSON.stringify(assess(pack, b)));
    expect(JSON.stringify(assess(pack, a))).toBe(JSON.stringify(assess(pack, a)));
    expect(JSON.stringify(a)).toBe(before);
  });
});
