// @vitest-environment node
/** The dependency gate's policy logic (D8-06, threat T19), tested with canned `npm audit --json` documents. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module script without types
import { collectAdvisories, evaluateAudit, validateRisks } from "../../scripts/check-audit.mjs";

type Result = { ok: boolean; errors: string[]; unaccepted: unknown[]; accepted: { risk: string }[]; notes: string[] };
const evaluate = evaluateAudit as (a: unknown, r: unknown, today: string) => Result;
const validate = validateRisks as (f: unknown) => string[];

const TODAY = "2026-11-23";
const audit = (vulns: Record<string, unknown> = {}) => ({ auditReportVersion: 2, vulnerabilities: vulns, metadata: {} });
const advisory = (pkg: string, ghsa: string, severity = "moderate") => ({
  [pkg]: { name: pkg, severity, via: [{ source: 1, name: pkg, title: `${pkg} issue`, url: `https://github.com/advisories/${ghsa}`, severity }], fixAvailable: false },
});
const risk = (over: Record<string, unknown> = {}) => ({
  id: "AR-1", advisory: "GHSA-aaaa-bbbb-cccc", package: "left-pad", severity: "moderate", rationale: "dev only", accepted_by: "someone", date: "2026-11-01", review_by: "2027-02-01", ...over,
});
const file = (...risks: unknown[]) => ({ version: 1, risks });

describe("check-audit policy", () => {
  it("passes a clean audit with a valid non-npm record", () => {
    const r = evaluate(audit(), file(risk({ id: "AR-CI-01", advisory: null, package: "github-actions" })), TODAY);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("fails on an unaccepted advisory and names it", () => {
    const r = evaluate(audit(advisory("left-pad", "GHSA-aaaa-bbbb-cccc", "high")), file(), TODAY);
    expect(r.ok).toBe(false);
    expect(r.unaccepted).toHaveLength(1);
    expect(r.errors.join("\n")).toMatch(/GHSA-aaaa-bbbb-cccc in left-pad \(high\)/);
  });

  it("passes an accepted advisory, matching id case-insensitively and the package", () => {
    const r = evaluate(audit(advisory("left-pad", "GHSA-aaaa-bbbb-cccc")), file(risk({ advisory: "ghsa-AAAA-bbbb-cccc" })), TODAY);
    expect(r.ok).toBe(true);
    expect(r.accepted.map((a) => a.risk)).toEqual(["AR-1"]);
  });

  it("does not accept the same advisory id for a different package", () => {
    const r = evaluate(audit(advisory("right-pad", "GHSA-aaaa-bbbb-cccc")), file(risk()), TODAY);
    expect(r.ok).toBe(false);
  });

  it("a transitive chain (string `via`) is covered by the advisory at its root, and unaccepted ones still fail", () => {
    const vulns = { ...advisory("glob", "GHSA-gl00-0000-0000"), "workbox-build": { name: "workbox-build", severity: "moderate", via: ["glob"], fixAvailable: true } };
    expect(collectAdvisories(audit(vulns))).toHaveLength(1);
    expect(evaluate(audit(vulns), file(risk({ advisory: "GHSA-gl00-0000-0000", package: "glob" })), TODAY).ok).toBe(true);
    expect(evaluate(audit(vulns), file(), TODAY).ok).toBe(false);
  });

  it("fails on an expired review_by, and passes on the review day itself", () => {
    const a = audit(advisory("left-pad", "GHSA-aaaa-bbbb-cccc"));
    expect(evaluate(a, file(risk({ review_by: "2026-11-22" })), TODAY).errors.join()).toMatch(/AR-1: acceptance expired on 2026-11-22/);
    expect(evaluate(a, file(risk({ review_by: "2026-11-23" })), TODAY).ok).toBe(true);
  });

  it("expiry applies to non-npm records too", () => {
    const r = evaluate(audit(), file(risk({ id: "AR-CI-01", advisory: null, package: "github-actions", review_by: "2026-01-01", date: "2025-08-01" })), TODAY);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/AR-CI-01: acceptance expired/);
  });

  it("an accepted advisory that no longer appears is a note, not a failure", () => {
    const r = evaluate(audit(), file(risk()), TODAY);
    expect(r.ok).toBe(true);
    expect(r.notes.join()).toMatch(/no longer appears/);
  });

  it.each([
    ["not an object", [] as unknown],
    ["wrong version", { version: 2, risks: [] }],
    ["risks not an array", { version: 1, risks: {} }],
    ["missing field", file({ ...risk(), rationale: undefined })],
    ["blank rationale", file(risk({ rationale: "  " }))],
    ["bad severity", file(risk({ severity: "catastrophic" }))],
    ["bad date", file(risk({ date: "2026-13-45" }))],
    ["date not zero padded", file(risk({ review_by: "2027-2-1" }))],
    ["review before date", file(risk({ date: "2027-03-01" }))],
    ["advisory of the wrong type", file(risk({ advisory: 42 }))],
    ["duplicate ids", file(risk(), risk())],
    ["record not an object", file("AR-1")],
  ])("fails on a malformed accepted-risks file: %s", (_n, f) => {
    expect(validate(f).length).toBeGreaterThan(0);
    expect(evaluate(audit(), f, TODAY).ok).toBe(false);
  });

  it.each([
    ["an npm error document", { error: { code: "ENOTFOUND", summary: "request to registry failed" } }],
    ["an unexpected format", { foo: 1 }],
    ["null", null],
    ["version 1 format", { advisories: {}, metadata: {} }],
  ])("fails closed on %s", (_n, a) => {
    const r = evaluate(a, file(), TODAY);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("fails on an invalid --today", () => {
    expect(evaluate(audit(), file(), "yesterday").ok).toBe(false);
  });

  it("fails when the advisory is now more severe than the accepted severity, and passes at or below it (V4-04)", () => {
    const worse = audit(advisory("left-pad", "GHSA-aaaa-bbbb-cccc", "high"));
    const r = evaluate(worse, file(risk({ severity: "moderate" })), TODAY);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/now high, above the accepted moderate/);
    expect(evaluate(audit(advisory("left-pad", "GHSA-aaaa-bbbb-cccc", "high")), file(risk({ severity: "high" })), TODAY).ok).toBe(true);
    expect(evaluate(audit(advisory("left-pad", "GHSA-aaaa-bbbb-cccc", "low")), file(risk({ severity: "high" })), TODAY).ok).toBe(true);
    expect(evaluate(audit(advisory("left-pad", "GHSA-aaaa-bbbb-cccc", "critical")), file(risk({ severity: "high" })), TODAY).ok).toBe(false);
  });

  it("fails when review_by is more than 180 days after date, and passes at exactly 180", () => {
    expect(validate(file(risk({ date: "2026-11-23", review_by: "2027-05-22" })))).toEqual([]); // 180 days
    expect(validate(file(risk({ date: "2026-11-23", review_by: "2027-05-23" }))).join()).toMatch(/181 days after date; the maximum window is 180/);
    expect(validate(file(risk({ date: "2026-01-01", review_by: "2030-01-01" }))).join()).toMatch(/maximum window/);
  });

  it("accepts only real UTC calendar dates", () => {
    for (const bad of ["2027-02-30", "2027-02-29", "2026-04-31", "2027-13-01", "2027-00-10", "2027-02-00", "2027-2-3", "2027-02-03T00:00:00Z", "27-02-03", " 2027-02-03", "2027-02-03 "]) {
      expect(validate(file(risk({ review_by: bad }))).length, bad).toBeGreaterThan(0);
      expect(validate(file(risk({ date: bad }))).length, bad).toBeGreaterThan(0);
    }
    expect(validate(file(risk({ date: "2028-02-29", review_by: "2028-03-29" })))).toEqual([]); // a leap day
    expect(evaluate(audit(), file(risk()), "2027-02-30").ok).toBe(false);
  });

  it("the tracked accepted-risks file is valid and carries AR-CI-01", () => {
    const real = JSON.parse(readFileSync("security/accepted-risks.json", "utf8")) as { risks: Record<string, unknown>[] };
    expect(validate(real)).toEqual([]);
    const ci = real.risks.find((r) => r.id === "AR-CI-01");
    expect(ci).toMatchObject({ accepted_by: "kyrvasesolutions", date: "2026-11-23", review_by: "2027-02-23" });
    expect(ci!.advisory ?? null).toBeNull();
  });
});

describe("check-audit command line (canned audit file, no network)", () => {
  const run = (auditDoc: unknown, extra: string[] = [], risks?: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "dpp-audit-"));
    try {
      writeFileSync(join(dir, "audit.json"), JSON.stringify(auditDoc));
      writeFileSync(join(dir, "risks.json"), JSON.stringify(risks ?? file()));
      const r = spawnSync("node", ["scripts/check-audit.mjs", "--audit-json", join(dir, "audit.json"), "--risks", join(dir, "risks.json"), ...extra], { encoding: "utf8" });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("exit 0 on a clean audit, exit 1 on an advisory, exit 1 on an expired acceptance via --today", () => {
    expect(run(audit()).code).toBe(0);
    expect(run(audit(advisory("left-pad", "GHSA-aaaa-bbbb-cccc"))).code).toBe(1);
    const accepted = file(risk());
    expect(run(audit(advisory("left-pad", "GHSA-aaaa-bbbb-cccc")), [], accepted).code).toBe(0);
    const late = run(audit(advisory("left-pad", "GHSA-aaaa-bbbb-cccc")), ["--today", "2027-02-02"], accepted);
    expect(late.code).toBe(1);
    expect(late.out).toMatch(/expired/);
  });

  it("exit 1 with a clear message for an npm error document", () => {
    const r = run({ error: { code: "ENOTFOUND", summary: "no network" } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/npm audit failed: ENOTFOUND/);
  });
});
