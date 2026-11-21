/** The capability registry covers every screen with one valid label (criterion Cn-G3). */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, CAPABILITY_LABELS, capabilityOf, labelOfFunction } from "../../src/model/capabilities";

describe("capability registry", () => {
  it("has one entry per screen", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(["graph", "import", "mapping", "prepare", "profile", "readiness", "requirements", "validation"]);
  });

  it("uses only the four labels", () => {
    for (const c of CAPABILITIES) expect(CAPABILITY_LABELS).toContain(c.label);
  });

  it("cites plan functions as FUNC-nnn", () => {
    for (const c of CAPABILITIES) for (const f of [...c.functions, ...(c.extends ?? [])]) expect(f).toMatch(/^FUNC-\d{3}$/);
  });

  it("gives each plan function one label: one screen delivers it, others may only extend it", () => {
    const delivered = CAPABILITIES.flatMap((c) => c.functions);
    expect(new Set(delivered).size).toBe(delivered.length);
    for (const c of CAPABILITIES) for (const f of c.extends ?? []) expect(c.functions).not.toContain(f);
  });

  // The assessment register is kept locally, outside version control (decision D0-06), so CI has no copy.
  const REGISTER = "docs/assessment/cycle-0/register.json";
  it.runIf(existsSync(REGISTER))("cites only FUNC IDs that are in the local plan register", () => {
    const register = JSON.parse(readFileSync(REGISTER, "utf8")) as { all_func_ids: string[] };
    for (const c of CAPABILITIES) for (const f of [...c.functions, ...(c.extends ?? [])]) expect(register.all_func_ids).toContain(f);
  });

  // A label becomes "supported" only at a cycle exit, with evidence in that cycle's evidence log.
  const SUPPORTED_AT_EXIT: Record<string, string> = { profile: "Cycle 1, 21 November 2026", import: "Cycle 2, 21 November 2026" };
  it("labels a screen supported only after a recorded cycle exit", () => {
    const supported = CAPABILITIES.filter((c) => c.label === "supported").map((c) => c.id);
    expect(supported.sort()).toEqual(Object.keys(SUPPORTED_AT_EXIT).sort());
  });

  it("gives a function its own label only among the functions its screen delivers", () => {
    for (const c of CAPABILITIES) {
      for (const [f, label] of Object.entries(c.functionLabels ?? {})) {
        expect(c.functions).toContain(f);
        expect(CAPABILITY_LABELS).toContain(label);
      }
    }
  });

  // The scored register is kept locally (D0-06): every function shown as supported must be at F2 there.
  const SCORED = ["docs/assessment/cycle-2/register.csv", "docs/assessment/cycle-1/register.csv"].find((p) => existsSync(p));
  it.runIf(SCORED)("labels supported only the functions the latest scored register puts at F2", () => {
    const levels = new Map(
      readFileSync(SCORED!, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("FUNC,"))
        .map((l) => [l.split(",")[1], (l.match(/,(F[0-3]|OOS),/) ?? [])[1]]),
    );
    for (const c of CAPABILITIES) {
      for (const f of c.functions) if (labelOfFunction(f) === "supported") expect(levels.get(f), f).toBe("F2");
    }
  });

  it("fails loudly for an unknown screen", () => {
    expect(() => capabilityOf("unknown" as never)).toThrow('No capability recorded for screen "unknown"');
  });
});
