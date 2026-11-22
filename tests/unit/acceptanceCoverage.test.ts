// @vitest-environment node
/**
 * The coverage matrix of the acceptance suite: it equals the case list the specs run, and it covers every failure class of the
 * contract pack on each of the three routes (each with an outcome, or NA with its reason), plus the two limit classes the
 * tests build themselves.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CASES, CLASSES, ROUTES, type Outcome } from "../acceptance/cases";

const matrix = JSON.parse(readFileSync("tests/acceptance/coverage.json", "utf8")) as { routes: string[]; cases: typeof CASES };
const OUTCOMES: Outcome[] = ["rejected-at-ingress", "route-hold-output-refused", "registry-draft-only", "field-withheld", "output-made", "reproducible", "scan-clean", "NA"];

describe("acceptance coverage matrix", () => {
  it("is the case list the specs run (npm run acceptance -- run `node scripts/acceptance.mjs --matrix` after a change)", () => {
    expect(matrix.routes).toEqual([...ROUTES]);
    expect(matrix.cases).toEqual(JSON.parse(JSON.stringify(CASES)));
  });

  it("has unique case IDs, each with FUNC, criterion and gate IDs and a known outcome", () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(60);
    for (const c of CASES) {
      expect(c.id, c.id).toMatch(/^AC-[A-Z0-9-]+$/);
      expect(c.funcs.length, c.id).toBeGreaterThan(0);
      expect(c.criteria.length, c.id).toBeGreaterThan(0);
      expect(c.gates.length, c.id).toBeGreaterThan(0);
      for (const f of c.funcs) expect(f).toMatch(/^FUNC-\d{3}$/);
      for (const f of c.criteria) expect(f).toMatch(/^C\d-\d{2}$/);
      for (const f of c.gates) expect(f).toMatch(/^G\d{2}$/);
      expect(OUTCOMES).toContain(c.outcome);
      expect(c.expected.length, c.id).toBeGreaterThan(10);
    }
  });

  it("covers every failure class of the pack on each of the three routes, and says why where a class cannot affect a route", () => {
    const packClasses = readdirSync("contracts/n/failure-cases").map((f) => f.replace(/\.yaml$/, ""));
    expect(packClasses.length).toBeGreaterThanOrEqual(18);
    for (const name of [...packClasses, "too-large", "deadline"]) {
      expect(CLASSES[name], `${name} has no acceptance class`).toBeDefined();
      const cases = CASES.filter((c) => c.class === name && c.route !== "all");
      expect(cases.map((c) => c.route).sort(), name).toEqual([...ROUTES].sort());
      for (const c of cases) if (c.outcome === "NA") expect(c.na, c.id).toMatch(/\w{10}/);
    }
    // the classes the matrix has that the pack lacks are exactly the two built in the tests, and they say so
    expect(Object.keys(CLASSES).filter((k) => !packClasses.includes(k)).sort()).toEqual(["deadline", "too-large"]);
    for (const k of ["deadline", "too-large"]) for (const c of CASES.filter((x) => x.class === k)) expect(c.note, c.id).toMatch(/No pack fixture/);
  });

  it("points each pack class at the fixture its failure case names", () => {
    for (const [name, k] of Object.entries(CLASSES)) {
      const file = `contracts/n/failure-cases/${name}.yaml`;
      if (!existsSync(file)) continue;
      const fixture = (parse(readFileSync(file, "utf8")) as { fixture: string }).fixture.replace("fixtures/n/", "");
      if (k.kind === "ingress") expect(k.file, name).toBe(fixture);
      else if (/\.(csv|json)$/.test(fixture)) expect([k.pair.erp, k.pair.lab], name).toContain(fixture);
      if (k.kind === "ingress" && k.file) expect(existsSync(`fixtures/n/${k.file}`), k.file).toBe(true);
    }
  });

  it("covers the positive case of each route, reproducibility across all three, and the scans of the log and of the messages", () => {
    for (const r of ROUTES) expect(CASES.some((c) => c.class === "positive" && c.route === r), r).toBe(true);
    for (const id of ["AC-REPRODUCIBLE-ALL", "AC-LOG-SCAN", "AC-MESSAGE-SCAN", "AC-G14-NO-PARTIAL"]) expect(CASES.some((c) => c.id === id), id).toBe(true);
  });

  it("has no test in the specs that is not one of these cases", () => {
    for (const file of readdirSync("tests/acceptance").filter((f) => f.endsWith(".spec.ts"))) {
      const text = readFileSync(`tests/acceptance/${file}`, "utf8");
      const titles = [...text.matchAll(/(?<![.\w])test\(\s*(`\[\$\{[^`]*`|"[^"]*"|'[^']*')/g)].map((m) => m[1]);
      expect(titles.length, file).toBeGreaterThan(0);
      for (const t of titles) expect(t, `${file}: a test outside the matrix`).toMatch(/^`\[\$\{(?:c\.id|byId\("AC-[A-Z0-9-]+"\)\.id)\}\]/);
    }
  });
});
