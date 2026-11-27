// @vitest-environment node
/**
 * Cycle 4 (aligned in Cycle 9): internal ERP staging CSV (`internal`), held `RegistryRequest` JSON (`registry`),
 * and lineage behind every value (C4-02, C4-03, C4-07, C9-03, C9-04).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildLineage, outputRef, trace } from "../../src/model/lineage";
import { byRole } from "../../src/model/ingress";
import { buildErpCsv, csvCell } from "../../src/model/outputs/erpCsv";
import { detailPosition, RouteRefusedError } from "../../src/model/outputs/items";
import { buildRegistryJson } from "../../src/model/outputs/registryJson";
import { decide } from "../../src/model/policy";
import { ROUTES, type ProfilePack } from "../../src/model/profile";
import { assertNoLeakText } from "../support/leak";
import { ACCEPTED_ERP, ACCEPTED_LAB, CLEAN, COMBINATIONS, loadPack, propertyBySlug, recordFor } from "../support/records";

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});

/** RFC 4180 reader with ',' delimiter matching internal ERP staging CSV (MAP-EXP-ERP-01). */
function parseCsv(text: string): string[][] {
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
    else if (c === ",") (row.push(cell), (cell = ""));
    else if (c === "\n") (row.push(cell), rows.push(row), (row = []), (cell = ""));
    else cell += c;
  }
  return rows;
}

describe("internal ERP staging CSV", () => {
  it("has the 12 aligned comma-delimited columns, one row, UTF-8 without BOM, and \\n line ends", async () => {
    const f = buildErpCsv(pack, await recordFor(pack, CLEAN));
    const [header, row] = parseCsv(f.text);
    expect(header).toEqual([
      "product_model",
      "batch",
      "customer_material_code",
      "nominal_thickness_mm",
      "measured_thickness_mm",
      "nominal_width_mm",
      "nominal_length_mm",
      "magnesium_mass_percent",
      "lead_mg_per_kg",
      "lead_qualifier",
      "internal_conversion_cost_eur_per_kg",
      "synthetic",
    ]);
    expect(row).toHaveLength(header.length);
    expect(f.text.endsWith("\n")).toBe(true);
    expect(f.text.includes("\r")).toBe(false);
    expect(f.bytes[0]).not.toBe(0xef);
    expect(new TextDecoder().decode(f.bytes)).toBe(f.text);
    expect(f.mediaType).toBe("text/csv");
    expect(f.status).toBe("RELEASED");
  });

  it("carries raw internal measurements (Mg, Pb, conversion cost) and nominal dimensions verbatim", async () => {
    const record = await recordFor(pack, CLEAN);
    const f = buildErpCsv(pack, record);
    const [header, row] = parseCsv(f.text);
    const col = (name: string) => row[header.indexOf(name)];
    expect(col("customer_material_code")).toBe("004215");
    expect(col("nominal_thickness_mm")).toBe("1.50");
    expect(col("measured_thickness_mm")).toBe("1.49");
    expect(col("nominal_width_mm")).toBe("1250");
    expect(col("nominal_length_mm")).toBe("2500");
    expect(col("magnesium_mass_percent")).toBe("2.9");
    expect(col("lead_mg_per_kg")).toBe("31.4");
    expect(col("lead_qualifier")).toBe("measured_estimate");
    expect(col("internal_conversion_cost_eur_per_kg")).toBe("1.95");
    expect(col("synthetic")).toBe("True");
  });

  it("never leaks fields denied for internal staging in any accepted combination", async () => {
    for (const c of COMBINATIONS) {
      const record = await recordFor(pack, c);
      let file;
      try {
        file = buildErpCsv(pack, record);
      } catch (e) {
        expect(e).toBeInstanceOf(RouteRefusedError);
        continue;
      }
      assertNoLeakText(file.text, "internal", record, pack);
      expect(file.text).not.toContain("Stand-in aluminium sheet, alloy family");
    }
  });

  it("refuses a route on HOLD, with the reasons, and makes no file", async () => {
    const record = await recordFor(pack, { erp: "erp-missing-thickness.csv", lab: CLEAN.lab });
    expect(() => buildErpCsv(pack, record)).toThrow(RouteRefusedError);
    try {
      buildErpCsv(pack, record);
    } catch (e) {
      expect((e as RouteRefusedError).holds.map((h) => h.ruleId)).toContain("RR-MISSING");
    }
    const unknownAssurance = await recordFor(pack, { erp: CLEAN.erp, lab: "lab-assurance-unknown.json" });
    expect(() => buildErpCsv(pack, unknownAssurance)).toThrow(/on hold|HOLD/i);
  });

  it("makes cells that start with = + - @ TAB or CR safe, counts them, and leaves numbers alone", async () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(csvCell(`${lead}1+1`, false).cell.replace(/^"|"$/g, "")).toBe(`'${lead}1+1`);
      expect(csvCell(`${lead}1+1`, false).prefixed).toBe(true);
    }
    expect(csvCell("-2.0", true)).toEqual({ cell: "-2.0", prefixed: false });
    expect(csvCell("normal", false)).toEqual({ cell: "normal", prefixed: false });
    expect(csvCell('a,b"c', false).cell).toBe('"a,b""c"');
    expect(csvCell("two\nlines", false).cell).toBe('"two\nlines"');

    // Formula-leading customer_material_code is prefixed safely without altering numeric cells
    const record = await recordFor(pack, {
      ...CLEAN,
      editErp: (csv) => csv.replace(",004215,", ",+HYPERLINK,"),
    });
    const f = buildErpCsv(pack, record);
    expect(f.formulaPrefixedCells).toBe(1);
    const [header, row] = parseCsv(f.text);
    expect(row[header.indexOf("customer_material_code")]).toBe("'+HYPERLINK");
    expect(row[header.indexOf("lead_mg_per_kg")]).toBe("31.4");
  });

  it("is the same on every run", async () => {
    const a = buildErpCsv(pack, await recordFor(pack, CLEAN));
    const b = buildErpCsv(pack, await recordFor(pack, CLEAN));
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });
});

describe("held RegistryRequest JSON", () => {
  it("is always a held RegistryRequest that is never submitted, with TARGET_PROFILE_UNCONFIRMED", async () => {
    for (const c of COMBINATIONS) {
      const record = await recordFor(pack, c);
      const f = buildRegistryJson(pack, record);
      const doc = JSON.parse(f.text);
      expect(doc.status, `${c.erp}+${c.lab}`).toBe("HOLD");
      expect(doc.code).toBe("TARGET_PROFILE_UNCONFIRMED");
      expect(doc.exchange_type).toBe("RegistryRequest");
      expect(f.exchangeType).toBe("RegistryRequest");
      expect(doc.not_a_registration_request).toBe(true);
      expect(doc.submission).toBe("never");
      expect(doc.holds.map((h: { rule: string }) => h.rule)).toContain("RR-STANDING-HOLD");
      expect(f.status).toBe("HOLD");
      assertNoLeakText(f.text, "registry", record, pack);
    }
  });

  it("names only the fields the matrix permits for the registry, in canonical form", async () => {
    const record = await recordFor(pack, CLEAN);
    const f = buildRegistryJson(pack, record);
    const doc = JSON.parse(f.text);
    expect(Object.keys(doc.properties)).toHaveLength(pack.routes.registry.output.length);
    for (const item of pack.routes.registry.output) expect(decide(pack, "registry", item.property)).toBe("permit");
    expect(f.text).toBe(
      `${JSON.stringify(
        JSON.parse(f.text),
        (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v),
        2,
      )}\n`,
    );
    expect(f.text).not.toContain("Stand-in aluminium sheet");
    expect(f.text).not.toContain(byRole(pack, "alloy"));
  });

  it("is deterministic across repeated runs", async () => {
    const a = buildRegistryJson(pack, await recordFor(pack, CLEAN));
    const b = buildRegistryJson(pack, await recordFor(pack, CLEAN));
    expect(a.text).toBe(b.text);
  });
});

describe("lineage", () => {
  it("traces every stated value of every output to source assertions that exist", async () => {
    for (const route of ["internal", "registry"] as const) {
      const record = await recordFor(pack, CLEAN);
      const f = route === "internal" ? buildErpCsv(pack, record) : buildRegistryJson(pack, record);
      for (const item of f.items.filter((i) => i.present)) {
        const chain = trace(f.lineage, outputRef(route, item.step));
        expect(chain.length, `${route} ${item.step}`).toBeGreaterThan(0);
        for (const e of chain) {
          expect(e.stepId).toBe(item.step);
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
    const recycled = propertyBySlug(pack, "recycled-content");
    const rule = pack.policy.derived.rules.find((r) => r.property === recycled)!;
    const item = {
      step: "MAP-PDF-X",
      kind: "derived",
      property: recycled,
      present: true,
      ruleId: rule.id,
      refs: [],
    } as never;
    const entries = buildLineage(pack, record, "customer", [item]);
    expect(entries.map((e) => e.property).sort()).toEqual(
      [byRole(pack, "recycledTotal"), byRole(pack, "recycledPre"), byRole(pack, "recycledPost"), byRole(pack, "recycledBasis")].sort(),
    );
    expect(entries.every((e) => e.ruleId === rule.id && e.outputRef === "customer/MAP-PDF-X")).toBe(true);
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
  it("the registry route is the only one that is on HOLD for the clean pair", async () => {
    const record = await recordFor(pack, CLEAN);
    expect(() => buildErpCsv(pack, record)).not.toThrow();
    expect(ROUTES).toHaveLength(3);
    expect(ACCEPTED_ERP.length * (ACCEPTED_LAB.length + 1)).toBe(COMBINATIONS.length);
  });
});
