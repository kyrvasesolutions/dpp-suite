// @vitest-environment node
/**
 * Cycle 3: route readiness (criteria C3-02, C3-03, C3-04, C3-06), on the public stand-in pack.
 *
 * Each state and each rule ID on purpose-built records, the prohibited-disclosure route variant (the negative
 * test: a hold, never a value), AT-T (every hold resolves to a rule and a source), and determinism.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
  it("makes the customer PDF and the ERP route ready and keeps the registry route on its standing hold", async () => {
    const rs = assess(pack, await recordFor(pack, CLEAN));
    expect(of(rs, "customer-pdf").status).toBe("ready");
    expect(of(rs, "erp-staging-csv").status).toBe("ready");
    expect(of(rs, "registry-prep-json").status).toBe("on-hold");
    expect(rules(of(rs, "registry-prep-json"))).toEqual(["RR-STANDING-HOLD"]);
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
  it("holds the routes that require the property, and only those", async () => {
    const rs = assess(pack, await recordFor(pack, { ...CLEAN, erp: "erp-missing-recycled-content.csv" }));
    const recycled = propertyBySlug(pack, "recycled-content");
    for (const route of ["customer-pdf", "erp-staging-csv"] as const) {
      expect(stateOf(of(rs, route), recycled)).toBe("missing");
      expect(of(rs, route).status).toBe("on-hold");
      expect(of(rs, route).holds).toEqual([{ ruleId: "RR-MISSING", property: recycled, sources: [] }]);
    }
    expect(rules(of(rs, "registry-prep-json"))).toEqual(["RR-STANDING-HOLD"]);
  });

  it("holds only the routes that require a property that is absent", async () => {
    // post-consumer share is optional in the ERP contract; the ERP route requires it, the customer PDF does not
    const post = propertyBySlug(pack, "post-consumer-share");
    expect(pack.properties.find((p) => p.id === post)!.requiredBy).toEqual({ "customer-pdf": false, "erp-staging-csv": true, "registry-prep-json": false });
    const record = await recordFor(pack, { ...CLEAN, editErp: (csv) => csv.replace(/;38\.5;/, ";;") });
    expect(record.values.some((v) => v.property === post)).toBe(false);
    const rs = assess(pack, record);
    expect(of(rs, "customer-pdf").status).toBe("ready");
    expect(of(rs, "erp-staging-csv").holds).toEqual([{ ruleId: "RR-MISSING", property: post, sources: [] }]);
  });
});

describe("challenged (C3-03)", () => {
  it("holds on a challenged required value and names both source locations", async () => {
    const rs = assess(pack, await recordFor(pack, { ...CLEAN, lab: "lab-conflicting-alloy.json" }));
    const alloy = byRole(pack, "alloy");
    for (const route of ["customer-pdf", "erp-staging-csv"] as const) {
      const r = of(rs, route);
      expect(stateOf(r, alloy)).toBe("challenged");
      const hold = r.holds.find((h) => h.ruleId === "RR-CHALLENGED")!;
      expect(hold.property).toBe(alloy);
      expect(hold.sources.map((s) => s.file).sort()).toEqual(["d03a-erp-extract.csv", "lab-conflicting-alloy.json"]);
      expect(hold.sources.every((s) => s.location.length > 0)).toBe(true);
      expect(r.status).toBe("on-hold");
    }
  });

  it("does not hold a route that does not require the challenged property", async () => {
    const rs = assess(pack, await recordFor(pack, { ...CLEAN, lab: "lab-conflicting-alloy.json" }));
    expect(rules(of(rs, "registry-prep-json"))).toEqual(["RR-STANDING-HOLD"]);
  });

  it("leaves the tensile statement undeterminable, not guessed, while the alloy is challenged", async () => {
    const rs = assess(pack, await recordFor(pack, { ...CLEAN, lab: "lab-conflicting-alloy.json" }));
    expect(rules(of(rs, "customer-pdf"))).toContain("RR-DERIVED-UNDETERMINABLE");
  });
});

describe("unknown code (C3-03)", () => {
  it("holds every route that requires the value with the unknown code", async () => {
    const rs = assess(pack, await recordFor(pack, { ...CLEAN, erp: "erp-unknown-company-code.csv" }));
    const manufacturer = propertyBySlug(pack, "manufacturer-id");
    for (const r of rs) {
      const hold = r.holds.find((h) => h.ruleId === "RR-UNKNOWN-CODE")!;
      expect(hold.property).toBe(manufacturer);
      expect(hold.sources).toHaveLength(1);
      expect(r.required.find((p) => p.property === manufacturer)).toMatchObject({ state: "present", assured: false });
      expect(r.status).toBe("on-hold");
    }
  });
});

describe("several footprint results (C3-04)", () => {
  it("selects the single result of a clean record", async () => {
    const f = selectFootprint(pack, await recordFor(pack, CLEAN));
    expect(f.state).toBe("selected");
    expect(f.selected).toBeDefined();
    expect(f.candidates).toHaveLength(1);
  });

  it("selects none of two results and holds every route that requires the footprint, keeping both listed", async () => {
    const record = await recordFor(pack, { ...CLEAN, lab: "lab-two-footprints.json" });
    const f = selectFootprint(pack, record);
    expect(f.state).toBe("several");
    expect(f.selected).toBeUndefined();
    expect(f.candidates.map((c) => c.qualifier)).toEqual(["PCF-1", "PCF-2"]);
    const footprint = byRole(pack, "footprint");
    const rs = assess(pack, record);
    for (const route of ["customer-pdf", "erp-staging-csv"] as const) {
      const hold = of(rs, route).holds.find((h) => h.ruleId === "RR-SEVERAL-RESULTS")!;
      expect(hold.property).toBe(footprint);
      expect(hold.sources).toHaveLength(2);
      expect(of(rs, route).required.find((p) => p.property === footprint)).toMatchObject({ state: "present", assured: false });
    }
    expect(rules(of(rs, "registry-prep-json"))).toEqual(["RR-STANDING-HOLD"]);
  });

  it("reports no footprint when the laboratory file is missing, and holds on the missing value", async () => {
    const record = await recordFor(pack, { erp: ACCEPTED_ERP[0] });
    expect(selectFootprint(pack, record).state).toBe("none");
    expect(rules(of(assess(pack, record), "customer-pdf"))).toContain("RR-MISSING");
  });
});

describe("insufficient assurance and drafts (C3-03)", () => {
  it("holds on evidence without a digest, for the value it supports and for the record itself", async () => {
    const rs = assess(pack, await recordFor(pack, { ...CLEAN, lab: "lab-evidence-digest-missing.json" }));
    const footprint = byRole(pack, "footprint");
    const evidence = byRole(pack, "evidence");
    const customer = of(rs, "customer-pdf").holds.filter((h) => h.ruleId === "RR-EVIDENCE-DIGEST");
    expect(customer.map((h) => h.property)).toEqual([footprint]);
    expect(customer[0].sources.length).toBe(2);
    const erp = of(rs, "erp-staging-csv").holds.filter((h) => h.ruleId === "RR-EVIDENCE-DIGEST");
    expect(erp.map((h) => h.property).sort()).toEqual([evidence, footprint].sort());
    expect(of(rs, "customer-pdf").status).toBe("on-hold");
  });

  it("holds the customer PDF on a text that is not approved, and not the ERP route, which does not require it", async () => {
    const record = await recordFor(pack, { ...CLEAN, editLab: (doc) => (doc.texts[0].approval_state = "draft") });
    const rs = assess(pack, record);
    const hold = of(rs, "customer-pdf").holds.find((h) => h.ruleId === "RR-DRAFT-TEXT")!;
    expect(hold.property).toBe(byRole(pack, "narrative"));
    expect(hold.sources).toHaveLength(1);
    expect(of(rs, "erp-staging-csv").status).toBe("ready");
  });
});

describe("inaccessible: the prohibited-disclosure route variant (C3-02 negative test)", () => {
  const variant = parse(new TextDecoder().decode(fixtureBytes("n", "routes/customer-pdf-requires-denied.yaml"))) as { requires: string[] };

  it("requires exactly the properties the matrix denies to its recipient", () => {
    expect(variant.requires).toHaveLength(2);
    for (const id of variant.requires) expect(pack.matrix[id]["customer-pdf"]).toBe("deny");
  });

  it("holds the route with the state inaccessible and never shows a value", async () => {
    const record = await recordFor(pack, CLEAN);
    const rs = assess(pack, record, { requires: { "customer-pdf": variant.requires } });
    const r = of(rs, "customer-pdf");
    expect(r.status).toBe("on-hold");
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
    expect(of(rs, "erp-staging-csv").status).toBe("ready");
  });

  it("holds as both inaccessible and missing when the denied property has no assertion to point to", async () => {
    const record = await recordFor(pack, { erp: CLEAN.erp });
    const evidence = byRole(pack, "evidence");
    const r = of(assess(pack, record, { requires: { "customer-pdf": [evidence] } }), "customer-pdf");
    expect(stateOf(r, evidence)).toBe("inaccessible");
    expect(r.holds.filter((h) => h.property === evidence)).toEqual([
      { ruleId: "RR-INACCESSIBLE", property: evidence, sources: [] },
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
        // empty sources: missing, the standing hold, and inaccessible only when the property is missing as well
        const alsoMissing = h.ruleId === "RR-INACCESSIBLE" && r.holds.some((x) => x.ruleId === "RR-MISSING" && x.property === h.property);
        if (h.ruleId !== "RR-MISSING" && h.ruleId !== "RR-STANDING-HOLD" && !alsoMissing) {
          expect(h.sources.length, `${r.route} ${h.ruleId} has a source`).toBeGreaterThan(0);
          expect(h.property).not.toBeNull();
        }
        // a source is an assertion of this record: its file is one of the record's source files
        const files = new Set(record.sources.map((s) => s.name));
        for (const s of h.sources) expect(files.has(s.file), s.file).toBe(true);
        if (h.property !== null) expect(pack.properties.some((p) => p.id === h.property)).toBe(true);
      }
      expect(r.status).toBe(r.holds.length ? "on-hold" : "ready");
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
    // and no readiness rule is dead: each is applied somewhere
    for (const r of pack.policy.readiness.rules) expect(used.has(r.id), r.id).toBe(true);
  });
});

describe("structural checks (C3-06)", () => {
  it("pass on every accepted combination and state no conformity", async () => {
    for (const c of COMBINATIONS) {
      const checks = structuralChecks(pack, await recordFor(pack, c));
      expect(checks.map((k) => k.id)).toEqual(["CK-MODEL-IDENTIFIER", "CK-BATCH-IDENTIFIER", "CK-KNOWN-PROPERTIES"]);
      expect(checks.every((k) => k.passed)).toBe(true);
      for (const k of checks) expect(`${k.text} ${k.detail ?? ""}`).not.toMatch(/conform|complian/i);
    }
  });

  it("fail when an identifier member or a whole identifier is missing, or a value is outside the profile", async () => {
    const record = await recordFor(pack, CLEAN);
    const model = byRole(pack, "model");
    const noMember = { ...record, values: record.values.filter((v) => !(v.property === model && v.member === "FLD-Identifier-scheme")) };
    expect(structuralChecks(pack, noMember).find((k) => k.id === "CK-MODEL-IDENTIFIER")).toMatchObject({ passed: false, detail: "missing: FLD-Identifier-scheme" });
    const noBatch = { ...record, values: record.values.filter((v) => v.property !== byRole(pack, "batch")) };
    expect(structuralChecks(pack, noBatch).find((k) => k.id === "CK-BATCH-IDENTIFIER")).toMatchObject({ passed: false, detail: "no value" });
    const stray = { ...record, values: [...record.values, { ...record.values[0], property: "NOT-A-PROPERTY" }] };
    expect(structuralChecks(pack, stray).find((k) => k.id === "CK-KNOWN-PROPERTIES")).toMatchObject({ passed: false });
  });
});

describe("determinism", () => {
  it("gives the same result for the same record, on a fresh import too, and does not change its input", async () => {
    const a = await recordFor(pack, { ...CLEAN, lab: "lab-two-footprints.json" });
    const b = await recordFor(pack, { ...CLEAN, lab: "lab-two-footprints.json" });
    const before = JSON.stringify(a);
    expect(JSON.stringify(assess(pack, a))).toBe(JSON.stringify(assess(pack, b)));
    expect(JSON.stringify(assess(pack, a))).toBe(JSON.stringify(assess(pack, a)));
    expect(JSON.stringify(a)).toBe(before);
  });
});

describe("the operator notes explain every rule and check the screen can show", () => {
  // The operator notes are kept locally, outside version control, so CI has no copy.
  it.runIf(existsSync("docs/operator/readiness-notes.md"))("lists each readiness rule and structural check in the same words, and the four states", () => {
    const notes = readFileSync("docs/operator/readiness-notes.md", "utf8");
    for (const r of [...pack.policy.readiness.rules, ...pack.policy.readiness.checks]) expect(notes, r.id).toContain(`| \`${r.id}\` | ${r.text} |`);
    for (const state of ["Present", "Missing", "Not accessible to this recipient", "Challenged"]) expect(notes, state).toContain(`| ${state} |`);
    expect(notes).toContain("not a conformity assessment");
  });
});
