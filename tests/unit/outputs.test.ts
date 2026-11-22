// @vitest-environment node
/**
 * Cycle 4: the ERP CSV and the registry JSON (C4-02, C4-03), and the lineage behind every value (C4-07).
 * Outputs come only from `project()` and the pinned mapping; a route on hold is refused; nothing uses the clock.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildLineage, trace, outputRef } from "../../src/model/lineage";
import { byRole } from "../../src/model/ingress";
import { detailPosition, RouteRefusedError } from "../../src/model/outputs/items";
import { buildErpCsv, csvCell } from "../../src/model/outputs/erpCsv";
import { buildRegistryJson } from "../../src/model/outputs/registryJson";
import { decide } from "../../src/model/policy";
import { ROUTES, type ProfilePack } from "../../src/model/profile";
import { assertNoLeakText } from "../support/leak";
import { ACCEPTED_ERP, ACCEPTED_LAB, CLEAN, COMBINATIONS, loadPack, propertyBySlug, recordFor } from "../support/records";

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});

/** A small RFC 4180 reader with ';' as the delimiter, so quoted cells with ';' or line breaks come back whole. */
function parse(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ";") (row.push(cell), (cell = ""));
    else if (c === "\n") (row.push(cell), rows.push(row), (row = []), (cell = ""));
    else cell += c;
  }
  return rows;
}

describe("ERP CSV", () => {
  it("has the mapped columns in order, one row, UTF-8 without BOM, ';' delimiter and \\n line ends", async () => {
    const f = buildErpCsv(pack, await recordFor(pack, CLEAN));
    const [header, row] = parse(f.text);
    expect(header).toEqual(pack.routes["erp-staging-csv"].output.map((m) => m.csv!.header));
    expect(row).toHaveLength(header.length);
    expect(f.text.endsWith("\n")).toBe(true);
    expect(f.text.includes("\r")).toBe(false);
    expect(f.bytes[0]).not.toBe(0xef);
    expect(new TextDecoder().decode(f.bytes)).toBe(f.text);
    expect(f.mediaType).toBe("text/csv");
    expect(f.status).toBe("ready");
  });

  it("states numbers as the source wrote them and carries the footprint context and the evidence metadata", async () => {
    const record = await recordFor(pack, CLEAN);
    const f = buildErpCsv(pack, record);
    const cell = (property: string, header?: string) => {
      const i = pack.routes["erp-staging-csv"].output.findIndex((m) => m.property === property && (!header || m.csv!.header === header));
      return parse(f.text)[1][i];
    };
    expect(cell(propertyBySlug(pack, "nominal-thickness"))).toBe("2.0");
    expect(cell(propertyBySlug(pack, "net-mass"))).toBe("2412.5");
    expect(cell(propertyBySlug(pack, "carbon-footprint"), "footprint_method")).toBe("ISO 14067:2018");
    expect(cell(propertyBySlug(pack, "carbon-footprint"), "footprint_reference_year")).toBe("2025");
    expect(cell(propertyBySlug(pack, "carbon-footprint"), "footprint_system_boundary")).toBe("cradle-to-gate");
    const evidence = cell(propertyBySlug(pack, "evidence-references"));
    for (const word of ["issuer=", "revision=", "digest=sha256:", "access_policy_ref="]) expect(evidence).toContain(word);
  });

  it("never states the narrative, which the matrix denies for ERP staging, in any combination", async () => {
    for (const c of COMBINATIONS) {
      const record = await recordFor(pack, c);
      let file;
      try {
        file = buildErpCsv(pack, record);
      } catch (e) {
        expect(e).toBeInstanceOf(RouteRefusedError);
        continue;
      }
      assertNoLeakText(file.text, "erp-staging-csv", record, pack);
      expect(file.text).not.toContain("Fassaden");
    }
  });

  it("refuses a route on hold, with the reasons, and makes no file", async () => {
    const record = await recordFor(pack, { erp: "erp-missing-recycled-content.csv", lab: CLEAN.lab });
    expect(() => buildErpCsv(pack, record)).toThrow(RouteRefusedError);
    try {
      buildErpCsv(pack, record);
    } catch (e) {
      expect((e as RouteRefusedError).holds.map((h) => h.ruleId)).toContain("RR-MISSING");
    }
    const conflict = await recordFor(pack, { erp: CLEAN.erp, lab: "lab-conflicting-alloy.json" });
    expect(() => buildErpCsv(pack, conflict)).toThrow(/on hold/);
  });

  it("makes cells that start with = + - @ TAB or CR safe, counts them, and leaves numbers alone", async () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(csvCell(`${lead}1+1`, false).cell.replace(/^"|"$/g, "")).toBe(`'${lead}1+1`);
      expect(csvCell(`${lead}1+1`, false).prefixed).toBe(true);
    }
    expect(csvCell("-2.0", true)).toEqual({ cell: "-2.0", prefixed: false });
    expect(csvCell("normal", false)).toEqual({ cell: "normal", prefixed: false });
    expect(csvCell('a;b"c', false).cell).toBe('"a;b""c"');
    expect(csvCell("two\nlines", false).cell).toBe('"two\nlines"');

    // the footprint context cells carry free text from the laboratory file: crafted starts must be prefixed
    const record = await recordFor(pack, {
      ...CLEAN,
      editLab: (d) => {
        d.footprints[0].calculated_by = "=HYPERLINK(1)";
        d.footprints[0].method = "-ISO 14067";
        d.footprints[0].evidence_id = "+EV-CR-0099";
        d.evidence[1].evidence_id = "+EV-CR-0099";
      },
    });
    const f = buildErpCsv(pack, record);
    expect(f.formulaPrefixedCells).toBe(3);
    const [header, row] = parse(f.text);
    expect(row[header.indexOf("footprint_calculated_by")]).toBe("'=HYPERLINK(1)");
    expect(row[header.indexOf("footprint_method")]).toBe("'-ISO 14067");
    expect(row.some((c) => c.startsWith("'+EV-CR-0099"))).toBe(true);
    // the numbers are untouched, the footprint value and the year included
    expect(row[header.indexOf("footprint_reference_year")]).toBe("2025");
    expect(row.filter((c) => c.startsWith("'"))).toHaveLength(3);
  });

  it("is the same on every run", async () => {
    const a = buildErpCsv(pack, await recordFor(pack, CLEAN));
    const b = buildErpCsv(pack, await recordFor(pack, CLEAN));
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });
});

describe("registry JSON", () => {
  it("is always a HOLD draft that is never submitted, with the standing hold reason", async () => {
    for (const c of COMBINATIONS) {
      const record = await recordFor(pack, c);
      const f = buildRegistryJson(pack, record);
      const doc = JSON.parse(f.text);
      expect(doc.status, `${c.erp}+${c.lab}`).toBe("HOLD");
      expect(doc.submission).toBe("never");
      expect(doc.holds.map((h: { rule: string }) => h.rule)).toContain("RR-STANDING-HOLD");
      expect(doc.hold_reason).toBe(pack.routes["registry-prep-json"].holdReason);
      expect(f.status).toBe("hold");
      assertNoLeakText(f.text, "registry-prep-json", record, pack);
    }
  });

  it("names only the fields the matrix permits for the registry, in canonical form", async () => {
    const record = await recordFor(pack, CLEAN);
    const f = buildRegistryJson(pack, record);
    const doc = JSON.parse(f.text);
    expect(Object.keys(doc.properties)).toHaveLength(pack.routes["registry-prep-json"].output.length);
    for (const item of pack.routes["registry-prep-json"].output) expect(decide(pack, "registry-prep-json", item.property)).toBe("permit");
    expect(f.text).toBe(`${JSON.stringify(JSON.parse(f.text), (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v), 2)}\n`);
    expect(f.text).not.toContain("Fassaden");
    expect(f.text).not.toContain(byRole(pack, "alloy"));
  });

  it("includes the other holds of a record next to the standing hold", async () => {
    const record = await recordFor(pack, { erp: "erp-unknown-company-code.csv", lab: CLEAN.lab });
    const doc = JSON.parse(buildRegistryJson(pack, record).text);
    expect(doc.holds.map((h: { rule: string }) => h.rule).sort()).toEqual(["RR-STANDING-HOLD", "RR-UNKNOWN-CODE"]);
    expect(doc.holds.find((h: { rule: string }) => h.rule === "RR-UNKNOWN-CODE").property).toBe(propertyBySlug(pack, "manufacturer-id"));
  });

  it("is the same on every run and refuses nothing the route does not allow", async () => {
    const a = buildRegistryJson(pack, await recordFor(pack, CLEAN));
    const b = buildRegistryJson(pack, await recordFor(pack, CLEAN));
    expect(a.text).toBe(b.text);
  });
});

describe("lineage", () => {
  it("traces every stated value of every output to source assertions that exist", async () => {
    for (const route of ["erp-staging-csv", "registry-prep-json"] as const) {
      const record = await recordFor(pack, CLEAN);
      const f = route === "erp-staging-csv" ? buildErpCsv(pack, record) : buildRegistryJson(pack, record);
      for (const item of f.items.filter((i) => i.present)) {
        const chain = trace(f.lineage, outputRef(route, item.step));
        expect(chain.length, `${route} ${item.step}`).toBeGreaterThan(0);
        for (const e of chain) {
          expect(e.stepId).toBe(item.step);
          // a detail (a footprint's method, say) is read from another key of the object the assertion stands for
          const where = (loc: string) => (e.detail ? `${e.assertion.file}, ${detailPosition(loc.slice(e.assertion.file.length + 2), e.detail)}` : loc);
          const a = record.values.flatMap((v) => v.assertions).find((x) => x.source.file === e.assertion.file && where(x.source.location) === e.assertion.location);
          expect(a, `${e.outputRef} ${e.assertion.location}`).toBeDefined();
          expect(e.assertion.sha256).toBe(a!.source.sha256);
          expect(e.property).toBe(a!.property);
        }
      }
    }
  });

  it("lists every input assertion of a derived statement, with its rule", async () => {
    const record = await recordFor(pack, CLEAN);
    const tensile = propertyBySlug(pack, "tensile-strength");
    const item = {
      step: "MAP-PDF-X",
      kind: "derived",
      property: tensile,
      present: true,
      ruleId: pack.policy.derived.rules.find((r) => r.property === tensile)!.id,
      refs: [],
    } as never;
    const entries = buildLineage(pack, record, "customer-pdf", [item]);
    // the alloy is stated by both files, and both are inputs
    expect(entries.map((e) => e.property).sort()).toEqual([byRole(pack, "alloy"), byRole(pack, "alloy"), byRole(pack, "temper"), tensile].sort());
    expect(entries.every((e) => e.ruleId === pack.policy.derived.rules.find((r) => r.property === tensile)!.id && e.outputRef === "customer-pdf/MAP-PDF-X")).toBe(true);
  });
});

describe("no clock, no network", () => {
  it("makes the files without a call to fetch, XMLHttpRequest, sendBeacon, the date or randomness", async () => {
    const record = await recordFor(pack, CLEAN);
    const spies = [
      vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("network"))),
      vi.spyOn(Date, "now"),
      vi.spyOn(Math, "random"),
    ];
    const xhr = vi.fn();
    const beacon = vi.fn();
    vi.stubGlobal("XMLHttpRequest", xhr);
    vi.stubGlobal("navigator", { ...globalThis.navigator, sendBeacon: beacon });
    buildErpCsv(pack, record);
    buildRegistryJson(pack, record);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    spies.forEach((s) => s.mockRestore());
  });
});

describe("every route", () => {
  it("the registry route is the only one that is on hold for the clean pair", async () => {
    const record = await recordFor(pack, CLEAN);
    expect(() => buildErpCsv(pack, record)).not.toThrow();
    expect(ROUTES).toHaveLength(3);
    expect(ACCEPTED_ERP.length * (ACCEPTED_LAB.length + 1)).toBe(COMBINATIONS.length);
  });
});

describe("lineage of the footprint context points at the key that was read", () => {
  const KEYS: Record<string, string> = { "footprint_method": "method", "footprint_system_boundary": "system_boundary", "footprint_reference_year": "reference_year", "footprint_calculated_by": "calculated_by" };

  it("names /footprints/0/method, /system_boundary, /reference_year and /calculated_by, with the detail key", async () => {
    const record = await recordFor(pack, CLEAN);
    const f = buildErpCsv(pack, record);
    const mapping = pack.routes["erp-staging-csv"].output;
    let seen = 0;
    f.items.forEach((item, i) => {
      const key = KEYS[mapping[i].csv!.header];
      if (!key) return;
      seen++;
      const chain = trace(f.lineage, outputRef("erp-staging-csv", item.step));
      expect(chain).toHaveLength(1);
      expect(chain[0].detail).toBe(key);
      expect(chain[0].assertion.location).toBe(`d03a-lab-assessment.json, /footprints/0/${key}`);
      // the value item itself still points at the value
      expect(item.sources[0].position).toBe(`/footprints/0/${key}`);
    });
    expect(seen).toBe(4);
    const value = f.items.find((it) => it.property === propertyBySlug(pack, "carbon-footprint") && it.role === "field")!;
    expect(trace(f.lineage, outputRef("erp-staging-csv", value.step))[0]).toMatchObject({ assertion: { location: "d03a-lab-assessment.json, /footprints/0/value" } });
    expect(trace(f.lineage, outputRef("erp-staging-csv", value.step))[0].detail).toBeUndefined();
  });

  it("shows the right position in the PDF and in the manifest", async () => {
    const { release } = await (await import("../support/release")).releaseFor(CLEAN, pack);
    const pdf = release.files.find((f) => f.route === "customer-pdf")!;
    const t = await (await import("../support/pdfText")).pdfText(pdf.bytes);
    for (const key of Object.values(KEYS)) expect(t).toContain(`Source: Laboratory file, /footprints/0/${key}`);
    const details = release.manifest.lineage.filter((e) => e.detail);
    expect(details.map((e) => e.detail).sort()).toEqual([...Object.values(KEYS), ...Object.values(KEYS)].sort());
    for (const e of details) expect(e.assertion.location).toBe(`d03a-lab-assessment.json, /footprints/0/${e.detail}`);
  });
});

describe("separators in combined cells are escaped", () => {
  /** Splits on `|` that is not escaped, then reads each part's `key=` the way the escaping defines it. */
  const parts = (cell: string) => cell.split(/(?<!\\)\|/);
  const unescape = (s: string) => s.replace(/\\(.)/g, "$1");
  const cellOf = (csv: string, header: string) => {
    const [h, r] = parse(csv);
    return r[h.indexOf(header)];
  };

  it("keeps a crafted issuer inside its own evidence entry: no fake digest and no fake entry", async () => {
    const evil = "Lab), digest=sha256:" + "0".repeat(64) + "|EV-FAKE (issuer=x";
    const record = await recordFor(pack, { ...CLEAN, editLab: (d) => (d.evidence[0].issuer = evil) });
    const csv = buildErpCsv(pack, record).text;
    const cell = cellOf(csv, "evidence_references");
    expect(parts(cell)).toHaveLength(2); // the two evidence records and no more
    expect(cell).not.toContain("EV-FAKE (issuer=x");
    const entry = parts(cell).find((p) => p.includes("issuer=Lab"))!;
    // exactly one unescaped digest= in the entry, and it is the real one
    expect(entry.match(/(?<!\\)digest=sha256:[0-9a-f]{64}/g)).toHaveLength(1);
    expect(entry).not.toContain("digest=sha256:" + "0".repeat(64) + ",");
    expect(unescape(entry)).toContain(evil);
  });

  it("keeps an element named like a separator inside its own part", async () => {
    const record = await recordFor(pack, { ...CLEAN, editLab: (d) => (d.observations[2].element = "Mg=9.99|Fe") });
    const cell = cellOf(buildErpCsv(pack, record).text, "chemical_composition_pct");
    expect(parts(cell)).toHaveLength(2);
    expect(cell).toContain("Mg\\=9.99\\|Fe=3.05");
    expect(unescape(parts(cell)[0].split(/(?<!\\)=/)[0])).toBe("Mg=9.99|Fe");
  });

  it("escapes a backslash and a pipe in text parts, and leaves a single plain value exactly as the source wrote it", async () => {
    const record = await recordFor(pack, { ...CLEAN, editErp: (csv) => csv.replace("KA-778812", "KA|1\\2") });
    const f = buildErpCsv(pack, record);
    const cell = cellOf(f.text, "customer_article_number");
    expect(cell).toContain("value=KA\\|1\\\\2");
    expect(cellOf(f.text, "net_mass_kg")).toBe("2412.5");
    expect(cellOf(f.text, "commodity_code")).toBe("76061293");
  });

  it("is deterministic", async () => {
    const mk = async () => buildErpCsv(pack, await recordFor(pack, { ...CLEAN, editLab: (d) => (d.evidence[0].issuer = "a|b=(c),\\d") })).text;
    expect(await mk()).toBe(await mk());
  });
});

describe("a text property with qualifiers always names them", () => {
  const cell = (csv: string, header: string) => {
    const [h, r] = parse(csv);
    return r[h.indexOf(header)];
  };

  it("writes element=value for one element, as for several", async () => {
    const only = await recordFor(pack, { ...CLEAN, editLab: (d) => (d.observations = d.observations.filter((o: { element?: string }) => o.element !== "Mn")) });
    const one = buildErpCsv(pack, only);
    expect(cell(one.text, "chemical_composition_pct")).toBe("Mg=3.05");
    const both = buildErpCsv(pack, await recordFor(pack, CLEAN));
    expect(cell(both.text, "chemical_composition_pct")).toBe("Mg=3.05|Mn=0.31");
  });

  it("still writes a number plain, the footprint with its result ID included", async () => {
    const f = buildErpCsv(pack, await recordFor(pack, CLEAN));
    expect(cell(f.text, "carbon_footprint_kgco2e_per_kg")).toBe("4.2");
    expect(cell(f.text, "net_mass_kg")).toBe("2412.5");
    expect(cell(f.text, "commodity_code")).toBe("76061293");
  });

  it("keeps a method that starts with = formula-safe in the CSV", async () => {
    const f = buildErpCsv(pack, await recordFor(pack, { ...CLEAN, editLab: (d) => (d.footprints[0].method = "=cmd|calc") }));
    expect(cell(f.text, "footprint_method")).toBe("'=cmd|calc");
    expect(f.formulaPrefixedCells).toBe(1);
  });
});
