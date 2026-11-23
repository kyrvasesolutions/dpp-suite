/** The capability registry covers every screen with one valid label (criterion Cn-G3). */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, CAPABILITY_LABELS, capabilityOf, labelOfFunction } from "../../src/model/capabilities";

describe("capability registry", () => {
  it("has one entry per screen", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(["graph", "identity-releases", "import", "mapping", "outputs", "prepare", "profile", "readiness", "record", "requirements", "server", "validation"]);
  });

  it("uses only the four labels", () => {
    for (const c of CAPABILITIES) expect(CAPABILITY_LABELS).toContain(c.label);
  });

  it("cites plan functions as FUNC-nnn", () => {
    for (const c of CAPABILITIES) for (const f of [...c.functions, ...(c.extends ?? [])]) expect(f).toMatch(/^FUNC-\d{3}$/);
  });

  it("gives each plan function one label: one screen delivers it, others may only extend it", () => {
    // one label per function per increment: N (the screens) and P (the durable server) label their own slices
    for (const increment of ["N", "P"] as const) {
      const delivered = CAPABILITIES.filter((c) => (c.increment ?? "N") === increment).flatMap((c) => c.functions);
      expect(new Set(delivered).size, increment).toBe(delivered.length);
    }
    for (const c of CAPABILITIES) for (const f of c.extends ?? []) expect(c.functions).not.toContain(f);
  });

  // The assessment register is kept locally, outside version control (decision D0-06), so CI has no copy.
  const REGISTER = "docs/assessment/cycle-0/register.json";
  it.runIf(existsSync(REGISTER))("cites only FUNC IDs that are in the local plan register", () => {
    const register = JSON.parse(readFileSync(REGISTER, "utf8")) as { all_func_ids: string[] };
    for (const c of CAPABILITIES) for (const f of [...c.functions, ...(c.extends ?? [])]) expect(register.all_func_ids).toContain(f);
  });

  // A label becomes "supported" only at a cycle exit, with evidence in that cycle's evidence log.
  const SUPPORTED_AT_EXIT: Record<string, string> = {
    profile: "Cycle 1, 21 November 2026",
    import: "Cycle 2, 21 November 2026",
    readiness: "Cycle 3, 21 November 2026",
    outputs: "Cycle 4, 22 November 2026",
    record: "Cycle 5, 22 November 2026",
    server: "Cycle 6, 22 November 2026",
    "identity-releases": "Cycle 7, 23 November 2026",
  };
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
  const SCORED = ["docs/assessment/cycle-5/register.csv", "docs/assessment/cycle-4/register.csv", "docs/assessment/cycle-3/register.csv", "docs/assessment/cycle-2/register.csv", "docs/assessment/cycle-1/register.csv"].find((p) => existsSync(p));
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

  // The P levels are kept locally like the N register: every P function labelled supported must be at F2 there.
  const P_LEVELS = ["docs/assessment/cycle-7/p-levels.csv", "docs/assessment/cycle-6/p-levels.csv"].find((p) => existsSync(p));
  it.runIf(P_LEVELS)("labels supported only the P functions the local P levels put at F2", () => {
    const levels = new Map(
      readFileSync(P_LEVELS!, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("FUNC-"))
        .map((l) => [l.split(",")[0], l.split(",")[1]]),
    );
    for (const c of CAPABILITIES.filter((x) => x.increment === "P")) {
      for (const f of c.functions) if (labelOfFunction(f, "P") === "supported") expect(levels.get(f), f).toBe("F2");
    }
  });

  // The server increment (P) is labelled on its own entry. It never changes the N label of the same function, so static
  // mode, where no server code runs, shows the N labels as they were.
  it("labels the Cycle 6 server functions supported on their own P entry since the Cycle 6 exit, and leaves the N labels as they were", () => {
    const server = capabilityOf("server");
    expect(server.label).toBe("supported");
    expect(server.increment).toBe("P");
    expect(server.screen).toBe(false);
    for (const f of ["FUNC-022", "FUNC-023", "FUNC-039", "FUNC-063", "FUNC-064", "FUNC-087", "FUNC-125"]) {
      expect(labelOfFunction(f, "P"), f).toBe("supported");
    }
    for (const f of ["FUNC-022", "FUNC-023", "FUNC-039", "FUNC-063", "FUNC-064", "FUNC-125"]) {
      expect(labelOfFunction(f), f).toBe("supported");
    }
    expect(labelOfFunction("FUNC-087")).toBeUndefined(); // N has no slice of it
  });

  it("labels Cycle 7 identity, access & config release P functions supported since Cycle 7 exit without altering N labels", () => {
    const c7 = capabilityOf("identity-releases");
    expect(c7.label).toBe("supported");
    expect(c7.increment).toBe("P");
    expect(c7.screen).toBe(false);
    for (const f of ["FUNC-001", "FUNC-018", "FUNC-019", "FUNC-027", "FUNC-046", "FUNC-085", "FUNC-134"]) {
      expect(labelOfFunction(f, "P"), f).toBe("supported");
    }
    expect(labelOfFunction("FUNC-001")).toBe("supported");
    expect(labelOfFunction("FUNC-019")).toBe("supported");
    expect(labelOfFunction("FUNC-046")).toBe("supported");
    expect(labelOfFunction("FUNC-018")).toBeUndefined();
  });

  it("fails loudly for an unknown screen", () => {
    expect(() => capabilityOf("unknown" as never)).toThrow('No capability recorded for screen "unknown"');
  });
});
