// @vitest-environment node
/**
 * Declared input limits (G14): file size, JSON nesting, job deadline and one ERP data row, all read from the
 * pinned LIMITS file. Every over-limit input gets a bounded, typed error and no assertions.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readPack } from "../../config/contractPack";
import { ERROR_TEXT, importErpCsv, importLabJson, type ImportResult } from "../../src/model/ingress";
import { loadProfilePack, type ProfilePack } from "../../src/model/profile";
import { JsonSyntaxError, parseStrictJson } from "../../src/model/strictJson";
import { fixtureBytes } from "../support/fixtures";

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadProfilePack(readPack("contracts/n"));
});

const enc = (s: string) => new TextEncoder().encode(s);
const rejected = (r: ImportResult) => (r.ok ? null : { stage: r.stage, codes: r.errors.map((e) => e.code) });
const erpFile = () => ({ bytes: fixtureBytes("n", "d03a-erp-extract.csv"), name: "erp.csv", type: "text/csv" });
const labFile = () => ({ bytes: fixtureBytes("n", "d03a-lab-assessment.json"), name: "lab.json", type: "application/json" });
const withLimit = (key: keyof ProfilePack["policy"]["limits"], value: number): ProfilePack => ({
  ...pack,
  policy: { ...pack.policy, limits: { ...pack.policy.limits, [key]: value } },
});
/** A clock that moves 40 s on every reading, so any job overruns the 30 s deadline at its first check. */
const slowClock = () => {
  let t = 0;
  return () => (t += 40_000);
};

describe("the limits are pinned in the pack", () => {
  it("declares 10 MiB, depth 12, 30 s and one data row, in the pinned file the manifest lists", () => {
    const file = readFileSync("contracts/n/policy/LIMITS@1.0.0.yaml", "utf8");
    const doc = parse(file) as { id: string; version: string; limits: Record<string, unknown> };
    expect(doc).toMatchObject({ id: "LIMITS", version: "1.0.0" });
    expect(pack.policy.limits).toMatchObject({ max_file_bytes: 10 * 1024 * 1024, max_json_depth: 12, job_deadline_ms: 30_000, max_erp_data_rows: 1 });
    expect(pack.pins.map((p) => p.ref)).toContain("LIMITS@1.0.0");
  });

  it("has an operator-facing text for every new error code", () => {
    for (const code of ["multiple-records", "too-large", "too-deep", "deadline"] as const) expect(ERROR_TEXT[code].length).toBeGreaterThan(20);
  });
});

describe("one record per file pair", () => {
  it("rejects an extract with a second data row at the structure stage and imports nothing", async () => {
    const [head, row] = new TextDecoder().decode(erpFile().bytes).trimEnd().split("\n");
    const r = await importErpCsv(pack, { ...erpFile(), bytes: enc(`${head}\n${row}\n${row}\n`) });
    expect(rejected(r)).toEqual({ stage: "structure", codes: ["multiple-records"] });
    expect(r.ok).toBe(false);
  });

  it("still accepts exactly one data row", async () => {
    expect((await importErpCsv(pack, erpFile())).ok).toBe(true);
  });
});

describe("file size", () => {
  it("rejects a file over the limit at the bytes stage, before it is decoded", async () => {
    const big = new Uint8Array(pack.policy.limits.max_file_bytes + 1).fill(0xff); // would also be invalid UTF-8
    for (const [r, name, type] of [
      [await importErpCsv(pack, { bytes: big, name: "erp.csv", type: "text/csv" }), "erp", ""],
      [await importLabJson(pack, { bytes: big, name: "lab.json", type: "application/json" }), "lab", ""],
    ] as const) {
      expect(rejected(r), `${name}${type}`).toEqual({ stage: "bytes", codes: ["too-large"] });
      if (!r.ok) expect(r.file.sha256).toBe(""); // never decoded or hashed
    }
  });

  it("accepts a file exactly at the limit, and reads the limit from the pack", async () => {
    const bytes = fixtureBytes("n", "d03a-erp-extract.csv");
    expect((await importErpCsv(withLimit("max_file_bytes", bytes.length), erpFile())).ok).toBe(true);
    expect(rejected(await importErpCsv(withLimit("max_file_bytes", bytes.length - 1), erpFile()))).toEqual({ stage: "bytes", codes: ["too-large"] });
  });
});

describe("JSON nesting", () => {
  const nested = (depth: number) => "[".repeat(depth) + "]".repeat(depth);

  it("allows depth 12 and refuses 13 inside the parser", () => {
    expect(() => parseStrictJson(nested(12), { maxDepth: 12 })).not.toThrow();
    try {
      parseStrictJson(nested(13), { maxDepth: 12 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(JsonSyntaxError);
      expect((e as JsonSyntaxError).code).toBe("too-deep");
    }
  });

  it("counts objects and arrays together, and lets siblings reuse the depth", () => {
    expect(() => parseStrictJson('{"a":[{"b":[{"c":[]}]}]}', { maxDepth: 6 })).not.toThrow();
    expect(() => parseStrictJson('{"a":[{"b":[{"c":[]}]}]}', { maxDepth: 5 })).toThrow(JsonSyntaxError);
    expect(() => parseStrictJson("[[[]],[[]],[[]]]", { maxDepth: 3 })).not.toThrow();
  });

  it("stops a million-level nesting without a stack overflow", () => {
    const hostile = "[".repeat(1_000_000);
    expect(() => parseStrictJson(hostile, { maxDepth: 12 })).toThrow(JsonSyntaxError);
    expect(() => parseStrictJson('{"a":'.repeat(500_000), { maxDepth: 12 })).toThrow(JsonSyntaxError);
  });

  it("rejects a laboratory file nested too deeply at the parse stage with no assertions", async () => {
    const lab = new TextDecoder().decode(labFile().bytes);
    const deep = lab.replace('"evidence"', `"deep": ${nested(40)},\n  "evidence"`);
    expect(deep).not.toBe(lab);
    const r = await importLabJson(pack, { ...labFile(), bytes: enc(deep) });
    expect(rejected(r)).toEqual({ stage: "parse", codes: ["too-deep"] });
    expect(r).not.toHaveProperty("assertions");
  });

  it("accepts the clean laboratory file under the limit", async () => {
    expect((await importLabJson(pack, labFile())).ok).toBe(true);
  });
});

describe("job deadline", () => {
  it("stops an ERP import past the deadline with a bounded error and no assertions", async () => {
    const r = await importErpCsv(pack, { ...erpFile(), now: slowClock() });
    expect(rejected(r)).toEqual({ stage: "bytes", codes: ["deadline"] });
    expect(r).not.toHaveProperty("assertions");
  });

  it("stops a laboratory import past the deadline", async () => {
    const r = await importLabJson(pack, { ...labFile(), now: slowClock() });
    expect(rejected(r)).toEqual({ stage: "bytes", codes: ["deadline"] });
  });

  it("stops a run that becomes slow part-way, inside the parser", async () => {
    let calls = 0;
    // The first readings are fast (start, bytes, parse boundary); the parser's own ticks then see a late clock.
    const now = () => (++calls <= 3 ? 0 : 40_000);
    const r = await importLabJson(pack, { ...labFile(), now });
    expect(rejected(r)).toEqual({ stage: "parse", codes: ["deadline"] });
  });

  it("reads the deadline from the pack", async () => {
    const clock = (() => {
      let t = 0;
      return () => (t += 10);
    })();
    expect(rejected(await importErpCsv(withLimit("job_deadline_ms", 5), { ...erpFile(), now: clock }))).toEqual({ stage: "bytes", codes: ["deadline"] });
    expect((await importErpCsv(pack, { ...erpFile(), now: () => 0 })).ok).toBe(true);
  });
});
