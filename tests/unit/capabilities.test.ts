/** The capability registry covers every screen with one valid label (criterion Cn-G3). */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, CAPABILITY_LABELS, capabilityOf } from "../../src/model/capabilities";

describe("capability registry", () => {
  it("has one entry per screen", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(["graph", "mapping", "prepare", "profile", "requirements", "validation"]);
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
  const SUPPORTED_AT_EXIT: Record<string, string> = { profile: "Cycle 1, 21 November 2026" };
  it("labels a screen supported only after a recorded cycle exit", () => {
    const supported = CAPABILITIES.filter((c) => c.label === "supported").map((c) => c.id);
    expect(supported.sort()).toEqual(Object.keys(SUPPORTED_AT_EXIT).sort());
  });

  it("fails loudly for an unknown screen", () => {
    expect(() => capabilityOf("unknown" as never)).toThrow('No capability recorded for screen "unknown"');
  });
});
