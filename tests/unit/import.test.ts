// @vitest-environment node
/**
 * Cycle 2: strict import of the two N source files (criteria C2-01 to C2-07), on the public stand-in pack.
 *
 * AT-U: one case per failure class, a fixture matrix over every N fixture, seeded fuzzing of both parsers,
 * and the AT-X charter "get a wrong value accepted silently" as concrete attempts.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
const VALID_ERP = () => new TextDecoder().decode(fixture("erp-extract.csv"));
const VALID_LAB = () => new TextDecoder().decode(fixture("lab-assessment.json"));

/** The ERP extract with one cell replaced. */
function withCell(column: string, value: string) {
  const [head, row] = VALID_ERP().trimEnd().split("\n");
  const cols = head.split(",");
  const cells = row.split(",");
  cells[cols.indexOf(column)] = value.includes(",") ? `"${value}"` : value;
  return enc(`${head}\n${cells.join(",")}\n`);
}

const rejected = (r: ImportResult) => (r.ok ? null : { stage: r.stage, codes: r.errors.map((e) => e.code) });

describe("C2-01 the two contracts, and nothing else", () => {
  it("accepts the clean pair", async () => {
    const e = await erp(fixture("erp-extract.csv"));
    const l = await lab(fixture("lab-assessment.json"));
    expect(e.ok && l.ok).toBe(true);
  });

  it.each([
    ["erp.txt", "text/plain"],
    ["erp.csv", "application/json"],
    ["erp.json", ""],
  ])("rejects an ERP file named %s with type %s", async (name, type) => {
    expect(rejected(await erp(fixture("erp-extract.csv"), name, type))).toEqual({ stage: "bytes", codes: ["media-type"] });
  });

  it("rejects a lab file of another media type", async () => {
    expect(rejected(await lab(fixture("lab-assessment.json"), "lab.xml", "application/xml"))).toEqual({ stage: "bytes", codes: ["media-type"] });
  });

  it("accepts a .csv with no declared type, as browsers often send", async () => {
    expect((await erp(fixture("erp-extract.csv"), "erp.csv", "")).ok).toBe(true);
  });
});

describe("C2-02 strict ingress: a typed error at a named stage", () => {
  // Every failure fixture in the pinned pack, with the stage and code its class expects.
  const EXPECTED: Record<string, { stage: string; code: string } | "accepted"> = {
    "erp-latin1.csv": { stage: "bytes", code: "wrong-encoding" },
    "erp-missing-alloy-column.csv": { stage: "structure", code: "missing-column" },
    "erp-decimal-comma.csv": { stage: "semantics", code: "decimal-comma" },
    "erp-two-rows.csv": { stage: "structure", code: "multiple-records" },
    "erp-unknown-company-code.csv": { stage: "semantics", code: "unknown-code" },
    "erp-missing-thickness.csv": "accepted",
    "erp-extract.csv": "accepted",
    "lab-duplicate-key.json": { stage: "parse", code: "duplicate-key" },
    "lab-non-finite.json": { stage: "parse", code: "non-finite-number" },
    "lab-too-deep.json": { stage: "parse", code: "too-deep" },
    "lab-missing-unit.json": { stage: "semantics", code: "missing-unit" },
    "lab-wrong-unit.json": "accepted",
    "lab-below-loq.json": "accepted",
    "lab-conflicting-pre-consumer.json": "accepted",
    "lab-incompatible-footprint.json": "accepted",
    "lab-assurance-unknown.json": "accepted",
    "lab-assessment.json": "accepted",
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
    ["byte order mark", () => erp(new Uint8Array([0xef, 0xbb, 0xbf, ...fixture("erp-extract.csv")])), "bytes", "byte-order-mark"],
    ["empty file", () => erp(new Uint8Array()), "bytes", "empty-file"],
    ["extra column", () => erp(enc(VALID_ERP().replace("internal_conversion_cost_eur_per_kg", "internal_conversion_cost_eur_per_kg,note").replace(/,1\.95$/m, ",1.95,x"))), "structure", "unexpected-column"],
    ["duplicate column", () => erp(enc(VALID_ERP().replace("source_company,", "alloy_code,"))), "structure", "duplicate-column"],
    ["missing delimiter in a row", () => erp(enc(VALID_ERP().replace(",DE,", ",DE"))), "parse", "ragged-row"],
    ["unclosed quote", () => erp(enc(VALID_ERP().replace(",DE,", ',"DE,'))), "parse", "csv-syntax"],
    ["header only", () => erp(enc(`${VALID_ERP().split("\n")[0]}\n`)), "structure", "no-rows"],
    ["lab JSON syntax error", () => lab(enc(VALID_LAB().replace("{", "{,"))), "parse", "json-syntax"],
    ["lab missing required section", () => lab(enc(VALID_LAB().replace('"synthetic": true,', '"note": "x",'))), "structure", "schema"],
    ["lab invalid synthetic flag", () => lab(enc(VALID_LAB().replace('"synthetic": true', '"synthetic": false'))), "structure", "schema"],
  ])("rejects %s", async (_, run, stage, code) => {
    const r = await run();
    expect(rejected(r)?.stage).toBe(stage);
    expect(rejected(r)?.codes).toContain(code);
  });

  it("refuses an importer role that may not import (authorisation stage)", async () => {
    const r = await importErpCsv(pack, { bytes: fixture("erp-extract.csv"), name: "erp.csv", type: "text/csv" }, "ACT-06");
    expect(rejected(r)).toEqual({ stage: "authorisation", codes: ["not-authorised"] });
  });
});

describe("C2-03 verbatim source assertions with their location", () => {
  it("keeps the source text and names the file, row and column or JSON pointer", async () => {
    const e = await erp(fixture("erp-extract.csv"), "erp-extract.csv");
    const l = await lab(fixture("lab-assessment.json"), "lab-assessment.json");
    if (!e.ok || !l.ok) throw new Error("clean pair rejected");
    const text = VALID_ERP();
    for (const a of e.assertions) {
      expect(text).toContain(a.raw);
      expect(a.source.location).toMatch(/^erp-extract\.csv, row 2, column [a-z_]+$/);
    }
    const thickness = l.assertions.find((a) => a.details?.observation_id === "ST-OBS-THK-01")!;
    expect(thickness.raw).toBe("1.49");
    expect(thickness.source.location).toBe("lab-assessment.json, /lab_tests/thickness/value");
  });

  it("keeps an unknown non-lookup code, flags it, and guesses nothing", async () => {
    const e = await erp(withCell("alloy_code", "7075"));
    if (!e.ok) throw new Error("rejected");
    const alloy = e.assertions.find((a) => a.source.location.endsWith("alloy_code"))!;
    expect(alloy.raw).toBe("7075");
    expect(alloy.flags).toContain("unknown-code");
  });

  it("maps a known alloy code through the code list, keeping the raw code", async () => {
    const e = await erp(fixture("erp-extract.csv"));
    if (!e.ok) throw new Error("rejected");
    const alloy = e.assertions.find((a) => a.source.location.endsWith("alloy_code"))!;
    expect(alloy).toMatchObject({ raw: "5754", value: "EN AW-5754" });
    expect(alloy.flags).toContain("code-mapped");
  });
});

describe("C2-04 units are checked and never converted", () => {
  it("takes the unit of an ERP value from the contract column and keeps the number as given", async () => {
    const e = await erp(fixture("erp-extract.csv"));
    if (!e.ok) throw new Error("rejected");
    const thickness = e.assertions.find((a) => a.source.location.endsWith("nominal_thickness_mm"))!;
    expect(thickness).toMatchObject({ raw: "1.50", value: 1.5, unit: "mm" });
    expect(thickness.flags).toContain("unit-from-contract");
  });

  it("flags a lab unit outside the contract, even an equivalent one, without converting", async () => {
    for (const unit of ["cm", "m", "MM", "mm "]) {
      const r = await lab(enc(VALID_LAB().replace('"unit_id": "mm"', `"unit_id": ${JSON.stringify(unit)}`)));
      expect(r.ok, unit).toBe(true);
      if (r.ok) {
        const thick = r.assertions.find((a) => a.details?.observation_id === "ST-OBS-THK-01")!;
        expect(thick.flags, unit).toContain("wrong-unit");
        expect(thick.value, unit).toBe(1.49);
      }
    }
  });
});

describe("C2-05 disagreeing sources", () => {
  it("marks a conflicting value challenged and keeps both assertions", async () => {
    const state = await buildRecords([await erp(fixture("erp-extract.csv")), await lab(fixture("lab-conflicting-pre-consumer.json"))], pack);
    const challenged = state.records[0].values.filter((v) => v.status === "challenged");
    expect(challenged).toHaveLength(1);
    expect(challenged[0].assertions.map((a) => [a.source.role, a.raw])).toEqual([
      ["erp", "15"],
      ["lab", "13"],
    ]);
    for (const a of challenged[0].assertions) expect(a.flags).toContain("challenged");
  });

  it("has no challenged values on the clean pair", async () => {
    const state = await buildRecords([await erp(fixture("erp-extract.csv")), await lab(fixture("lab-assessment.json"))], pack);
    expect(state.records[0].values.some((v) => v.status === "challenged")).toBe(false);
    expect(state.records[0].dppPayload).toBeDefined();
  });

  it("keeps a lab file about another batch, unattached", async () => {
    const other = await lab(enc(VALID_LAB().replace('"batch_id": "ST-LOT-2026-001"', '"batch_id": "ST-LOT-2026-999"')));
    const state = await buildRecords([await erp(fixture("erp-extract.csv")), other], pack);
    expect(state.unattached.length).toBeGreaterThan(0);
    expect(state.records[0].sources).toHaveLength(1);
  });
});

describe("C2-06 explicit flags, no overall score", () => {
  it("flags provenance and quality on each assertion, and the record has no score", async () => {
    const state = await buildRecords([await erp(fixture("erp-extract.csv")), await lab(fixture("lab-assessment.json"))], pack);
    const record = state.records[0];
    expect(Object.keys(record).sort()).toEqual(["batch", "digest", "dppPayload", "importStatus", "model", "revision", "sources", "values"]);
    const flags = new Set(record.values.flatMap((v) => v.assertions.flatMap((a) => a.flags)));
    for (const f of ["declared", "measured", "calculated-externally", "unit-from-contract", "uncertainty-stated", "evidence-linked"]) {
      expect(flags, f).toContain(f);
    }
  });

  it("flags non-numeric observation value as shape issue instead of coercing", async () => {
    const l = await lab(enc(VALID_LAB().replace('"value": 1.49', '"value": "approx 2"')));
    expect(l.ok).toBe(true);
    if (l.ok) {
      expect(l.importStatus).toBe("IMPORTED_WITH_SHAPE_ISSUES");
      const thick = l.assertions.find((a) => a.details?.observation_id === "ST-OBS-THK-01")!;
      expect(thick.flags).toContain("shape-issue");
    }
  });
});

describe("C2-07 importing again gives the identical record state", () => {
  it("has the same digest, whatever the order of the files", async () => {
    const run = async (reverse: boolean) => {
      const files = [await erp(fixture("erp-extract.csv")), await lab(fixture("lab-assessment.json"))];
      return buildRecords(reverse ? files.reverse() : files, pack);
    };
    const [a, b, c] = [await run(false), await run(false), await run(true)];
    expect(b).toEqual(a);
    expect(c.records[0].digest).toBe(a.records[0].digest);
  });

  it("changes the digest when one source byte changes", async () => {
    const a = await buildRecords([await erp(fixture("erp-extract.csv"))], pack);
    const b = await buildRecords([await erp(withCell("nominal_width_mm", "1501"))], pack);
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
    const r = await erp(withCell("nominal_thickness_mm", cell));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("semantics");
  });

  it.each([
    ["negative length", "nominal_length_mm", "-2500"],
    ["share over 100 %", "recycled_total_percent", "100.5"],
    ["impossible date", "production_date", "2026-02-30"],
    ["date in another format", "production_date", "14.10.2026"],
    ["empty required value", "alloy_code", ""],
  ])("ERP %s is refused", async (_, column, cell) => {
    const r = await erp(withCell(column, cell));
    expect(r.ok).toBe(false);
  });

  it.each([
    ["negative measured thickness", '"value": 1.49', '"value": -1.49'],
    ["composition over 100 %", '"value": 2.9', '"value": 103.1'],
    ["duplicate key written with an escape", '"value": 1.49,', '"value": 1.49,\n      "\\u0076alue": 2.10,'],
    ["number overflowing to Infinity", '"value": 31.4', '"value": 1e400'],
    ["unit null", '"unit_id": "mm"', '"unit_id": null'],
    ["several JSON documents", '"synthetic"', '"synthetic"'],
  ])("lab %s is refused", async (name, from, to) => {
    const text = name === "several JSON documents" ? `${VALID_LAB()}{}` : VALID_LAB().replace(from, to);
    expect((await lab(enc(text))).ok).toBe(false);
  });

  it("an unknown code is never accepted silently: it is flagged", async () => {
    const e = await erp(withCell("alloy_code", "7075"));
    if (!e.ok) throw new Error("rejected");
    expect(e.assertions.find((a) => a.raw === "7075")!.flags).toContain("unknown-code");
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
  // The operator notes are kept locally, outside version control, so CI has no copy.
  it.runIf(existsSync("docs/operator/import-notes.md"))("lists each error code with its stage, and each flag, in the same words", async () => {
    const { ERROR_TEXT, FLAG_TEXT } = await import("../../src/model/ingress");
    const notes = readFileSync("docs/operator/import-notes.md", "utf8");
    for (const [code, text] of Object.entries(ERROR_TEXT)) expect(notes, code).toMatch(new RegExp(`\\| \`${code}\` \\| \\w+ \\| ${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\|`));
    for (const [flag, text] of Object.entries(FLAG_TEXT)) expect(notes, flag).toContain(`| \`${flag}\` | ${text} |`);
  });
});

describe("Cycle 3 review: padded product identifiers in the lab file", () => {
  it.each([
    ["leading space", " ST-LOT-2026-001"],
    ["trailing space", "ST-LOT-2026-001 "],
    ["zero-width space", "ST-LOT-2026-001\u200b"],
    ["soft hyphen", "\u00adST-LOT-2026-001"],
  ])("refuses batch_id with %s with padded-identifier at /batch_id", async (_, value) => {
    const doc = JSON.parse(VALID_LAB());
    doc.batch_id = value;
    const r = await lab(enc(JSON.stringify(doc)));
    expect(rejected(r)).toEqual({ stage: "semantics", codes: expect.arrayContaining(["padded-identifier"]) });
    if (!r.ok) expect(r.errors.find((e) => e.code === "padded-identifier")!.location).toContain("/batch_id");
  });
});

describe("Cycle 3 review: a text must be about the file's own product model", () => {
  it("rejects a lab text whose subject_ref names another model, with the location", async () => {
    const doc = JSON.parse(VALID_LAB());
    doc.authorised_texts[1].subject_ref = "PM-OTHER-0001";
    const r = await lab(enc(JSON.stringify(doc)));
    expect(rejected(r)).toEqual({ stage: "semantics", codes: ["subject-mismatch"] });
    if (!r.ok) expect(r.errors[0].location).toContain("/authorised_texts/1/subject_ref");
  });
});

describe("Cycle 2 re-assessment findings", () => {
  const twoRows = () => {
    const [head, row] = VALID_ERP().trimEnd().split("\n");
    return enc(`${head}\n${row}\n${row.replace("ST-LOT-2026-001", "ST-LOT-2026-999").replace(",1250,", ",1600,")}\n`);
  };

  // One product record per ERP extract is the declared default; a pack that declares a higher limit is the only way two rows load.
  const twoRowPack = () => ({ ...pack, policy: { ...pack.policy, limits: { ...pack.policy.limits, max_erp_data_rows: 2 } } });
  const erpTwo = (bytes: Uint8Array, name = "erp.csv") => importErpCsv(twoRowPack(), { bytes, name, type: "text/csv" });

  it("R2-1 attaches every ERP value to its own row's record, whatever the file is called", async () => {
    for (const name of ["export row 9.csv", "tomorrow 3.csv", "row 2.csv"]) {
      const one = await buildRecords([await erp(fixture("erp-extract.csv"), name)], pack);
      expect(one.records[0].values.length, name).toBe(22);
      const two = await buildRecords([await erpTwo(twoRows(), name)], pack);
      const [a, b] = two.records;
      expect([a.batch, b.batch]).toEqual(["ST-LOT-2026-001", "ST-LOT-2026-999"]);
      const width = (r: (typeof two.records)[number]) => r.values.find((v) => v.assertions[0].source.location.endsWith("nominal_width_mm"))!.assertions;
      expect(width(a).map((x) => x.raw)).toEqual(["1250"]);
      expect(width(b).map((x) => x.raw)).toEqual(["1600"]);
    }
  });

  it("D5-02 the declared default rejects a two-row extract: one file is one record, nothing is partly imported", async () => {
    expect(rejected(await erp(twoRows()))).toEqual({ stage: "structure", codes: ["multiple-records"] });
  });

  it("R2-2 refuses two rows for the same model and batch", async () => {
    const [head, row] = VALID_ERP().trimEnd().split("\n");
    const same = enc(`${head}\n${row}\n${row.replace(",1.50,", ",3.00,")}\n`);
    expect(rejected(await erpTwo(same))).toEqual({ stage: "semantics", codes: ["duplicate-record"] });
    expect(rejected(await erp(same))).toEqual({ stage: "structure", codes: ["multiple-records"] });
  });

  it.each([
    ["observation", '"observation_id": "ST-OBS-MG-01"', '"observation_id": "ST-OBS-THK-01"'],
    ["text", '"text_id": "ST-TEXT-DE-01"', '"text_id": "ST-TEXT-EN-01"'],
  ])("R2-2 refuses two %s entries with the same identifier", async (_, from, to) => {
    const text = VALID_LAB().replace(from, to);
    expect(text).not.toBe(VALID_LAB());
    expect(rejected(await lab(enc(text)))?.codes).toContain("duplicate-id");
  });

  it.each([
    ["a required cell of only spaces", "product_designation", "   ", "missing-value"],
    ["zero thickness", "nominal_thickness_mm", "0", "out-of-range"],
    ["negative zero thickness", "nominal_thickness_mm", "-0", "out-of-range"],
    ["zero width", "nominal_width_mm", "0.0", "out-of-range"],
    ["more digits than a double keeps", "nominal_width_mm", "9007199254740993", "precision-loss"],
    ["a long fraction", "nominal_thickness_mm", "2.00000000000000000001", "precision-loss"],
  ])("R2-4/5 refuses %s", async (_, column, cell, code) => {
    expect(rejected(await erp(withCell(column, cell)))?.codes).toContain(code);
  });

  it("R2-4 still accepts 0 % recycled content, a real value", async () => {
    expect((await erp(withCell("post_consumer_percent", "0"))).ok).toBe(true);
  });

  it.each([
    ["more digits than a double keeps", '"value": 31.4', '"value": 31.400000000000000001'],
    ["an underflow to zero", '"value": 1.49', '"value": 1e-400'],
  ])("R2-5 refuses a lab value with %s", async (_, from, to) => {
    expect(rejected(await lab(enc(VALID_LAB().replace(from, to))))?.codes).toContain("precision-loss");
  });

  it("R2-7 accepts a .csv sent as an Excel type, and blank lines at the end", async () => {
    expect((await erp(fixture("erp-extract.csv"), "erp.csv", "application/vnd.ms-excel")).ok).toBe(true);
    expect((await erp(enc(`${VALID_ERP()}\n\n`))).ok).toBe(true);
    const [head, row] = VALID_ERP().trimEnd().split("\n");
    expect(rejected(await erp(enc(`${head}\n\n${row}\n`)))?.codes).toContain("ragged-row");
  });

  it("R2-6 keeps the values of a lab file about another batch, unattached", async () => {
    const other = await lab(enc(VALID_LAB().replaceAll("ST-LOT-2026-001", "ST-LOT-OTHER")));
    const state = await buildRecords([await erp(fixture("erp-extract.csv")), other], pack);
    expect(state.unattached.map((a) => a.source.location)).toContain("lab.json, /lab_tests/thickness/value");
  });
});

describe("Cycle 2 re-assessment, round 2", () => {
  it.each([
    ["a trailing space", "ST-LOT-2026-001 "],
    ["a leading space", " ST-LOT-2026-001"],
    ["a zero-width space", "ST-LOT-2026-001\u200b"],
  ])("N1 refuses a batch ID with %s", async (_, cell) => {
    expect(rejected(await erp(withCell("batch_id", cell)))?.codes).toContain("padded-identifier");
  });

  it("N1 refuses a padded code instead of flagging it unknown", async () => {
    expect(rejected(await erp(withCell("alloy_code", "5754 ")))?.codes).toContain("padded-identifier");
  });

  it("N2 treats a cell of only invisible characters as empty", async () => {
    expect(rejected(await erp(withCell("product_designation", "\u200b")))?.codes).toContain("missing-value");
  });
});
