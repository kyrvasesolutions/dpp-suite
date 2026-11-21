// @vitest-environment node
/**
 * Cycle 2: strict import of the two N source files (criteria C2-01 to C2-07), on the public stand-in pack.
 *
 * AT-U: one case per failure class, a fixture matrix over every N fixture, seeded fuzzing of both parsers,
 * and the AT-X charter "get a wrong value accepted silently" as concrete attempts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readPack } from "../../config/contractPack";
import { buildRecords, importErpCsv, importLabJson, type ImportResult } from "../../src/model/ingress";
import { loadProfilePack, type ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "../support/fixtures";

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadProfilePack(readPack("contracts/n"));
});

const enc = (s: string) => new TextEncoder().encode(s);
const erp = (bytes: Uint8Array, name = "erp.csv", type = "text/csv") => importErpCsv(pack, { bytes, name, type });
const lab = (bytes: Uint8Array, name = "lab.json", type = "application/json") => importLabJson(pack, { bytes, name, type });
const fixture = (name: string) => fixtureBytes("n", name);
const VALID_ERP = () => new TextDecoder().decode(fixture("d03a-erp-extract.csv"));
const VALID_LAB = () => new TextDecoder().decode(fixture("d03a-lab-assessment.json"));

/** The ERP extract with one cell replaced. */
function withCell(column: string, value: string) {
  const [head, row] = VALID_ERP().trimEnd().split("\n");
  const cols = head.split(";");
  const cells = row.split(";");
  cells[cols.indexOf(column)] = value;
  return enc(`${head}\n${cells.join(";")}\n`);
}

const rejected = (r: ImportResult) => (r.ok ? null : { stage: r.stage, codes: r.errors.map((e) => e.code) });

describe("C2-01 the two contracts, and nothing else", () => {
  it("accepts the clean pair", async () => {
    const e = await erp(fixture("d03a-erp-extract.csv"));
    const l = await lab(fixture("d03a-lab-assessment.json"));
    expect(e.ok && l.ok).toBe(true);
  });

  it.each([
    ["erp.txt", "text/plain"],
    ["erp.csv", "application/json"],
    ["erp.json", ""],
  ])("rejects an ERP file named %s with type %s", async (name, type) => {
    expect(rejected(await erp(fixture("d03a-erp-extract.csv"), name, type))).toEqual({ stage: "bytes", codes: ["media-type"] });
  });

  it("rejects a lab file of another media type", async () => {
    expect(rejected(await lab(fixture("d03a-lab-assessment.json"), "lab.xml", "application/xml"))).toEqual({ stage: "bytes", codes: ["media-type"] });
  });

  it("accepts a .csv with no declared type, as browsers often send", async () => {
    expect((await erp(fixture("d03a-erp-extract.csv"), "erp.csv", "")).ok).toBe(true);
  });
});

describe("C2-02 strict ingress: a typed error at a named stage", () => {
  // Every failure fixture in the pinned pack, with the stage and code its class expects.
  const EXPECTED: Record<string, { stage: string; code: string } | "accepted"> = {
    "erp-latin1.csv": { stage: "bytes", code: "wrong-encoding" },
    "erp-missing-alloy-column.csv": { stage: "structure", code: "missing-column" },
    "erp-decimal-comma.csv": { stage: "semantics", code: "decimal-comma" },
    "lab-duplicate-key.json": { stage: "parse", code: "duplicate-key" },
    "lab-non-finite.json": { stage: "parse", code: "non-finite-number" },
    "lab-missing-unit.json": { stage: "semantics", code: "missing-unit" },
    "lab-wrong-unit.json": { stage: "semantics", code: "wrong-unit" },
    "lab-unit-alias.json": { stage: "semantics", code: "wrong-unit" },
    "erp-unknown-company-code.csv": "accepted",
    "erp-missing-recycled-content.csv": "accepted",
    "lab-two-footprints.json": "accepted",
    "lab-conflicting-alloy.json": "accepted",
    "lab-evidence-digest-missing.json": "accepted",
    "d03a-erp-extract.csv": "accepted",
    "d03a-lab-assessment.json": "accepted",
  };

  it("covers every CSV and JSON fixture of the N fixture pack", () => {
    const files = readdirSync("fixtures/n").filter((f) => /\.(csv|json)$/.test(f) && f !== "MANIFEST.json");
    expect(files.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))("%s", async (name, expected) => {
    const r = name.endsWith(".csv") ? await erp(fixture(name), name) : await lab(fixture(name), name);
    if (expected === "accepted") expect(rejected(r)).toBeNull();
    else {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.stage).toBe(expected.stage);
        expect(r.errors.map((e) => e.code)).toContain(expected.code);
        for (const e of r.errors) expect(e.location).toContain(name);
      }
    }
  });

  it("every failure case in the pack points at a fixture this matrix covers", () => {
    const cases = readdirSync("contracts/n/failure-cases").map((f) => parse(readFileSync(`contracts/n/failure-cases/${f}`, "utf8")) as { fixture: string });
    for (const c of cases) if (/\.(csv|json)$/.test(c.fixture)) expect(Object.keys(EXPECTED)).toContain(c.fixture.replace("fixtures/n/", ""));
  });

  it.each([
    ["byte order mark", () => erp(new Uint8Array([0xef, 0xbb, 0xbf, ...fixture("d03a-erp-extract.csv")])), "bytes", "byte-order-mark"],
    ["empty file", () => erp(new Uint8Array()), "bytes", "empty-file"],
    ["extra column", () => erp(enc(VALID_ERP().replace("supplier_code", "supplier_code;note").replace(/\n(?=.)/, "\n").replace(/;SS01$/m, ";SS01;x"))), "structure", "unexpected-column"],
    ["duplicate column", () => erp(enc(VALID_ERP().replace("company_code;", "alloy;"))), "structure", "duplicate-column"],
    ["missing delimiter in a row", () => erp(enc(VALID_ERP().replace(";MILL;", ";MILL"))), "parse", "ragged-row"],
    ["unclosed quote", () => erp(enc(VALID_ERP().replace(";MILL;", ';"MILL;'))), "parse", "csv-syntax"],
    ["header only", () => erp(enc(`${VALID_ERP().split("\n")[0]}\n`)), "structure", "no-rows"],
    ["lab JSON syntax error", () => lab(enc(VALID_LAB().replace("{", "{,"))), "parse", "json-syntax"],
    ["lab value as a string", () => lab(enc(VALID_LAB().replace('"value": 2.01', '"value": "2.01"'))), "structure", "schema"],
    ["lab unknown key", () => lab(enc(VALID_LAB().replace('"schema_id"', '"note": "x",\n  "schema_id"'))), "structure", "schema"],
    ["lab unknown evidence", () => lab(enc(VALID_LAB().replace('"evidence_id": "EV-TR-0417"', '"evidence_id": "EV-NOPE"'))), "semantics", "unknown-evidence"],
  ])("rejects %s", async (_, run, stage, code) => {
    const r = await run();
    expect(rejected(r)?.stage).toBe(stage);
    expect(rejected(r)?.codes).toContain(code);
  });

  it("refuses an importer role that may not import (authorisation stage)", async () => {
    const r = await importErpCsv(pack, { bytes: fixture("d03a-erp-extract.csv"), name: "erp.csv", type: "text/csv" }, "ACT-06");
    expect(rejected(r)).toEqual({ stage: "authorisation", codes: ["not-authorised"] });
  });
});

describe("C2-03 verbatim source assertions with their location", () => {
  it("keeps the source text and names the file, row and column or JSON pointer", async () => {
    const e = await erp(fixture("d03a-erp-extract.csv"), "d03a-erp-extract.csv");
    const l = await lab(fixture("d03a-lab-assessment.json"), "d03a-lab-assessment.json");
    if (!e.ok || !l.ok) throw new Error("clean pair rejected");
    const text = VALID_ERP();
    for (const a of e.assertions) {
      expect(text).toContain(a.raw);
      expect(a.source.location).toMatch(/^d03a-erp-extract\.csv, row 2, column [a-z_]+$/);
    }
    const thickness = l.assertions.find((a) => a.details?.observation_id === "OBS-1")!;
    expect(thickness.raw).toBe("2.01");
    expect(thickness.source.location).toBe("d03a-lab-assessment.json, /observations/0/value");
  });

  it("keeps an unknown code, flags it, and guesses nothing", async () => {
    const e = await erp(fixture("erp-unknown-company-code.csv"));
    if (!e.ok) throw new Error("rejected");
    const company = e.assertions.find((a) => a.source.location.endsWith("company_code"))!;
    expect(company.raw).toBe("SI99");
    expect(company.flags).toContain("unknown-code");
    expect(company.value).toBeNull();
  });

  it("maps a known company code through the code list, keeping the raw code", async () => {
    const e = await erp(fixture("d03a-erp-extract.csv"));
    if (!e.ok) throw new Error("rejected");
    const company = e.assertions.find((a) => a.source.location.endsWith("company_code"))!;
    expect(company).toMatchObject({ raw: "SI01", value: "STANDIN-MFR-01" });
    expect(company.flags).toContain("code-mapped");
  });
});

describe("C2-04 units are checked and never converted", () => {
  it("takes the unit of an ERP value from the contract column and keeps the number as given", async () => {
    const e = await erp(fixture("d03a-erp-extract.csv"));
    if (!e.ok) throw new Error("rejected");
    const thickness = e.assertions.find((a) => a.source.location.endsWith("thickness_nominal_mm"))!;
    expect(thickness).toMatchObject({ raw: "2.0", value: 2, unit: "mm" });
    expect(thickness.flags).toContain("unit-from-contract");
  });

  it("refuses a lab unit outside the contract, even an equivalent one", async () => {
    for (const unit of ["N/mm²", "MPa ", "mpa", "kN/mm²"]) {
      const r = await lab(enc(VALID_LAB().replace('"unit": "MPa"', `"unit": ${JSON.stringify(unit)}`)));
      expect(rejected(r)?.codes, unit).toContain("wrong-unit");
    }
  });
});

describe("C2-05 disagreeing sources", () => {
  it("marks the value challenged and keeps both assertions", async () => {
    const state = await buildRecords([await erp(fixture("d03a-erp-extract.csv")), await lab(fixture("lab-conflicting-alloy.json"))]);
    const challenged = state.records[0].values.filter((v) => v.status === "challenged");
    expect(challenged).toHaveLength(1);
    expect(challenged[0].assertions.map((a) => [a.source.role, a.raw])).toEqual([
      ["erp", "EN AW-5754"],
      ["lab", "EN AW-5083"],
    ]);
    for (const a of challenged[0].assertions) expect(a.flags).toContain("challenged");
  });

  it("shows agreement when both sources state the same model and batch", async () => {
    const state = await buildRecords([await erp(fixture("d03a-erp-extract.csv")), await lab(fixture("d03a-lab-assessment.json"))]);
    const agreeing = state.records[0].values.filter((v) => v.status === "agreeing");
    expect(agreeing.length).toBe(3);
    expect(state.records[0].values.some((v) => v.status === "challenged")).toBe(false);
  });

  it("keeps a lab file about another batch, unattached", async () => {
    const other = await lab(enc(VALID_LAB().replace('"batch_id": "B-2026-0417"', '"batch_id": "B-2026-9999"')));
    const state = await buildRecords([await erp(fixture("d03a-erp-extract.csv")), other]);
    expect(state.unattached.length).toBeGreaterThan(0);
    expect(state.records[0].sources).toHaveLength(1);
  });
});

describe("C2-06 explicit flags, no overall score", () => {
  it("flags provenance and quality on each assertion, and the record has no score", async () => {
    const state = await buildRecords([await erp(fixture("d03a-erp-extract.csv")), await lab(fixture("lab-evidence-digest-missing.json"))]);
    const record = state.records[0];
    expect(Object.keys(record).sort()).toEqual(["batch", "digest", "model", "sources", "values"]);
    const flags = new Set(record.values.flatMap((v) => v.assertions.flatMap((a) => a.flags)));
    for (const f of ["declared", "measured", "calculated-externally", "unit-from-contract", "uncertainty-stated", "evidence-linked", "evidence-digest-missing"]) {
      expect(flags, f).toContain(f);
    }
  });

  it("flags several footprint results instead of choosing one", async () => {
    const l = await lab(fixture("lab-two-footprints.json"));
    if (!l.ok) throw new Error("rejected");
    const results = l.assertions.filter((a) => a.flags.includes("calculated-externally"));
    expect(results).toHaveLength(2);
    for (const a of results) expect(a.flags).toContain("several-results");
  });
});

describe("C2-07 importing again gives the identical record state", () => {
  it("has the same digest, whatever the order of the files", async () => {
    const run = async (reverse: boolean) => {
      const files = [await erp(fixture("d03a-erp-extract.csv")), await lab(fixture("d03a-lab-assessment.json"))];
      return buildRecords(reverse ? files.reverse() : files);
    };
    const [a, b, c] = [await run(false), await run(false), await run(true)];
    expect(b).toEqual(a);
    expect(c.records[0].digest).toBe(a.records[0].digest);
  });

  it("changes the digest when one source byte changes", async () => {
    const a = await buildRecords([await erp(fixture("d03a-erp-extract.csv"))]);
    const b = await buildRecords([await erp(withCell("net_mass_kg", "2412.6"))]);
    expect(b.records[0].digest).not.toBe(a.records[0].digest);
  });
});

describe("AT-X charter: get a wrong value accepted silently", () => {
  it.each([
    ["leading space", " 2.0"],
    ["plus sign", "+2.0"],
    ["exponent", "2.0e0"],
    ["trailing point", "2."],
    ["leading point", ".5"],
    ["hexadecimal", "0x10"],
    ["Infinity", "Infinity"],
    ["NaN", "NaN"],
    ["overflow", "1e999"],
    ["thousands separator", "1,500.0"],
    ["unit in the cell", "2.0 mm"],
    ["leading zero", "02.0"],
  ])("ERP numeric cell with %s is refused", async (_, cell) => {
    const r = await erp(withCell("thickness_nominal_mm", cell));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("semantics");
  });

  it.each([
    ["negative length", "length_nominal_mm", "-3000"],
    ["share over 100 %", "recycled_content_pct", "100.5"],
    ["impossible date", "production_date", "2026-02-30"],
    ["date in another format", "production_date", "14.10.2026"],
    ["empty required value", "alloy", ""],
  ])("ERP %s is refused", async (_, column, cell) => {
    const r = await erp(withCell(column, cell));
    expect(r.ok).toBe(false);
  });

  it.each([
    ["negative measured thickness", '"value": 2.01', '"value": -2.01'],
    ["composition over 100 %", '"value": 3.05', '"value": 103.05'],
    ["duplicate key written with an escape", '"value": 2.01,', '"value": 2.01,\n      "\\u0076alue": 2.10,'],
    ["number overflowing to Infinity", '"value": 228', '"value": 1e400'],
    ["unit null", '"unit": "mm"', '"unit": null'],
    ["several JSON documents", '"schema_id"', '"schema_id"'],
  ])("lab %s is refused", async (name, from, to) => {
    const text = name === "several JSON documents" ? `${VALID_LAB()}{}` : VALID_LAB().replace(from, to);
    expect((await lab(enc(text))).ok).toBe(false);
  });

  it("an unknown code is never accepted silently: it is flagged", async () => {
    const e = await erp(withCell("alloy", "EN AW-7075"));
    if (!e.ok) throw new Error("rejected");
    expect(e.assertions.find((a) => a.raw === "EN AW-7075")!.flags).toContain("unknown-code");
  });
});

describe("AT-U seeded fuzzing of both parsers", () => {
  /** A small deterministic generator, so a failure always reproduces. */
  function rng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
  }
  const ALPHABET = ['"', ";", ",", "\n", "\r", "{", "}", "[", "]", ":", "\\", "e", "-", ".", "0", "9", "x", " ", "é", "\u0000"];

  function mutate(text: string, r: () => number) {
    const chars = [...text];
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const at = Math.floor(r() * chars.length);
      const op = r();
      if (op < 0.4) chars[at] = ALPHABET[Math.floor(r() * ALPHABET.length)];
      else if (op < 0.7) chars.splice(at, 1);
      else chars.splice(at, 0, ALPHABET[Math.floor(r() * ALPHABET.length)]);
    }
    return chars.join("");
  }

  const invariant = async (r: ImportResult, source: string) => {
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      for (const e of r.errors) expect(e.location).toBeTruthy();
      return;
    }
    for (const a of r.assertions) {
      expect(source).toContain(a.raw);
      if (typeof a.value === "number") expect(Number.isFinite(a.value)).toBe(true);
    }
  };

  it("never throws on 300 mutated ERP extracts, and anything accepted is verbatim and finite", async () => {
    const r = rng(42);
    for (let i = 0; i < 300; i++) {
      const text = mutate(VALID_ERP(), r);
      await invariant(await erp(enc(text)), text);
    }
  });

  it("never throws on 300 mutated lab files, and anything accepted is verbatim and finite", async () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const text = mutate(VALID_LAB(), r);
      await invariant(await lab(enc(text)), text);
    }
  });
});

describe("C2-08 the operator notes explain every error and flag the screen can show", () => {
  it("lists each error code with its stage, and each flag, in the same words", async () => {
    const { ERROR_TEXT, FLAG_TEXT } = await import("../../src/model/ingress");
    const notes = readFileSync("docs/operator/import-notes.md", "utf8");
    for (const [code, text] of Object.entries(ERROR_TEXT)) expect(notes, code).toMatch(new RegExp(`\\| \`${code}\` \\| \\w+ \\| ${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\|`));
    for (const [flag, text] of Object.entries(FLAG_TEXT)) expect(notes, flag).toContain(`| \`${flag}\` | ${text} |`);
  });
});

describe("Cycle 2 re-assessment findings", () => {
  const twoRows = () => {
    const [head, row] = VALID_ERP().trimEnd().split("\n");
    return enc(`${head}\n${row}\n${row.replace("B-2026-0417", "B-2026-0999").replace(";2412.5;", ";1999.0;")}\n`);
  };

  it("R2-1 attaches every ERP value to its own row's record, whatever the file is called", async () => {
    for (const name of ["export row 9.csv", "tomorrow 3.csv", "row 2.csv"]) {
      const one = await buildRecords([await erp(fixture("d03a-erp-extract.csv"), name)]);
      expect(one.records[0].values.length, name).toBe(23);
      const two = await buildRecords([await erp(twoRows(), name)]);
      const [a, b] = two.records;
      expect([a.batch, b.batch]).toEqual(["B-2026-0417", "B-2026-0999"]);
      const mass = (r: (typeof two.records)[number]) => r.values.find((v) => v.assertions[0].source.location.endsWith("net_mass_kg"))!.assertions;
      expect(mass(a).map((x) => x.raw)).toEqual(["2412.5"]);
      expect(mass(b).map((x) => x.raw)).toEqual(["1999.0"]);
    }
  });

  it("R2-2 refuses two rows for the same model and batch", async () => {
    const [head, row] = VALID_ERP().trimEnd().split("\n");
    const r = await erp(enc(`${head}\n${row}\n${row.replace(";2.0;", ";3.0;")}\n`));
    expect(rejected(r)).toEqual({ stage: "semantics", codes: ["duplicate-record"] });
  });

  it.each([
    ["evidence", '"evidence_id": "EV-CR-0099",\n      "issuer"', '"evidence_id": "EV-TR-0417",\n      "issuer"'],
    ["observation", '"observation_id": "OBS-2"', '"observation_id": "OBS-1"'],
  ])("R2-2 refuses two %s entries with the same identifier", async (_, from, to) => {
    const text = VALID_LAB().replace(from, to);
    expect(text).not.toBe(VALID_LAB());
    expect(rejected(await lab(enc(text)))?.codes).toContain("duplicate-id");
  });

  it.each([
    ["a required cell of only spaces", "product_model_id", "   ", "missing-value"],
    ["zero thickness", "thickness_nominal_mm", "0", "out-of-range"],
    ["negative zero thickness", "thickness_nominal_mm", "-0", "out-of-range"],
    ["zero mass", "net_mass_kg", "0.0", "out-of-range"],
    ["more digits than a double keeps", "net_mass_kg", "9007199254740993", "precision-loss"],
    ["a long fraction", "thickness_nominal_mm", "2.00000000000000000001", "precision-loss"],
  ])("R2-4/5 refuses %s", async (_, column, cell, code) => {
    expect(rejected(await erp(withCell(column, cell)))?.codes).toContain(code);
  });

  it("R2-4 still accepts 0 % recycled content, a real value", async () => {
    expect((await erp(withCell("post_consumer_pct", "0"))).ok).toBe(true);
  });

  it.each([
    ["more digits than a double keeps", '"value": 228', '"value": 228.000000000000000001'],
    ["an underflow to zero", '"value": 2.01', '"value": 1e-400'],
  ])("R2-5 refuses a lab value with %s", async (_, from, to) => {
    expect(rejected(await lab(enc(VALID_LAB().replace(from, to))))?.codes).toContain("precision-loss");
  });

  it("R2-7 accepts a .csv sent as an Excel type, and blank lines at the end", async () => {
    expect((await erp(fixture("d03a-erp-extract.csv"), "erp.csv", "application/vnd.ms-excel")).ok).toBe(true);
    expect((await erp(enc(`${VALID_ERP()}\n\n`))).ok).toBe(true);
    const [head, row] = VALID_ERP().trimEnd().split("\n");
    expect(rejected(await erp(enc(`${head}\n\n${row}\n`)))?.codes).toContain("ragged-row");
  });

  it("R2-6 keeps the values of a lab file about another model, unattached", async () => {
    const other = await lab(enc(VALID_LAB().replace(/"model_id": "[^"]+"/, '"model_id": "PM-OTHER"')));
    const state = await buildRecords([await erp(fixture("d03a-erp-extract.csv")), other]);
    expect(state.unattached.map((a) => a.source.location)).toContain("lab.json, /observations/0/value");
  });
});
