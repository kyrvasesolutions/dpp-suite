// @vitest-environment node
/**
 * Cycle 4 (aligned in Cycle 9): the customer PDF (EN & DE variants, C4-01, C4-09, C9-03),
 * leak check over every output (AT-E), reproducibility across two processes (AT-U, C4-04),
 * trace of random output values (AT-T, C4-07), and no network calls.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalPretty } from "../../src/model/canonical";
import { outputRef, trace } from "../../src/model/lineage";
import { buildCustomerPdf, PdfTextError, winAnsi } from "../../src/model/outputs/customerPdf";
import { buildErpCsv } from "../../src/model/outputs/erpCsv";
import { RouteRefusedError } from "../../src/model/outputs/items";
import { buildRegistryJson } from "../../src/model/outputs/registryJson";
import type { ProfilePack } from "../../src/model/profile";
import { assertNoLeakText } from "../support/leak";
import { pdfItems, pdfText } from "../support/pdfText";
import { CLEAN, COMBINATIONS, loadPack, propertyBySlug, recordFor, text as fixtureText } from "../support/records";
import { releaseFor } from "../support/release";

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});

describe("customer PDF (EN and DE variants, C9-03)", () => {
  it("renders the English customer PDF with 004215, 0.0015 m, 65 % + basis, <80 mg/kg screening, footprint context, and zero raw Pb/Mg/evidence/cost", async () => {
    const record = await recordFor(pack, CLEAN);
    const f = await buildCustomerPdf(pack, record, { version: 3, language: "en" });
    const t = (await pdfText(f.bytes)).replace(/\s+/g, " ");
    expect(Buffer.from(f.bytes.slice(0, 5)).toString()).toBe("%PDF-");
    expect(f.mediaType).toBe("application/pdf");
    expect(f.status).toBe("RELEASED");
    for (const it of pack.routes.customer.output.filter((m) => m.role === "field")) {
      const label = pack.properties.find((p) => p.id === it.property)!.labels;
      expect(t, it.step).toContain(label.en.slice(0, 12));
      expect(t).toContain(label.de.slice(0, 12));
    }
    // Aligned customer witness checks (C9-03, HT-W)
    expect(t).toContain("004215");
    expect(t).toContain("0.0015 m");
    expect(t).toContain("1.25 m");
    expect(t).toContain("2.5 m");
    expect(t).toContain("65 %");
    expect(t).toContain("RC-BASIS-001");
    expect(t).toContain("<80 mg/kg");
    expect(t).toContain("ST-METHOD-PCF-001");
    expect(t).toContain("ST-BOUNDARY-001");
    expect(t).toContain("Record version 3");
    expect(t).toContain(pack.manifestDigest);
    expect(t).toContain(record.digest);
    // English authorised text rendered; German text NOT mixed in
    expect(t).toContain("Stand-in aluminium sheet, alloy family 5754");
    expect(t).not.toContain("Platzhalter-Aluminiumblech");
    // Zero raw restricted leakage (Pb=31.4, Mg=2.9, cost=1.95, evidence IDs)
    expect(t).not.toContain("31.4");
    expect(t).not.toContain("1.95");
    expect(t).not.toContain("EV-RC-DECL-001");
    expect(t).not.toContain("ST-EV-PB-01");
    assertNoLeakText(t, "customer", record, pack);
  });

  it("renders the German customer variant (language: 'de') using the authorised German text with no machine translation", async () => {
    const record = await recordFor(pack, CLEAN);
    const f = await buildCustomerPdf(pack, record, { version: 1, language: "de" });
    const t = (await pdfText(f.bytes)).replace(/\s+/g, " ");
    expect(f.fileName).toContain("-de_");
    expect(t).toContain("Platzhalter-Aluminiumblech, Legierungsfamilie 5754");
    expect(t).not.toContain("Stand-in aluminium sheet, alloy family 5754");
    expect(t).toContain("004215");
    expect(t).toContain("0.0015 m");
    expect(t).toContain("65 %");
    expect(t).toContain("<80 mg/kg");
    assertNoLeakText(t, "customer", record, pack);
  });

  it("shows the source of each value in the public form, never a file name", async () => {
    const t = await pdfText((await buildCustomerPdf(pack, await recordFor(pack, CLEAN))).bytes);
    expect(t).toContain("Source: ERP extract, row 2, column alloy_code");
    expect(t).not.toMatch(/erp-extract|lab-assessment|\.csv|\.json/);
  });

  it("has no producer, creator or date metadata", async () => {
    const f = await buildCustomerPdf(pack, await recordFor(pack, CLEAN));
    const raw = Buffer.from(f.bytes).toString("latin1");
    for (const key of ["/Producer", "/Creator", "/CreationDate", "/ModDate", "/Author", "/Title"]) expect(raw, key).not.toContain(key);
  });

  it("refuses a route on HOLD, with its reasons, and makes no PDF", async () => {
    const record = await recordFor(pack, { erp: CLEAN.erp, lab: "lab-conflicting-pre-consumer.json" });
    await expect(buildCustomerPdf(pack, record)).rejects.toThrow(RouteRefusedError);
    await expect(buildCustomerPdf(pack, await recordFor(pack, { erp: "erp-missing-thickness.csv", lab: CLEAN.lab }))).rejects.toThrow(/on hold|HOLD/i);
  });

  it("spells ≤ ≥ ₂ in ASCII, keeps WinAnsi characters, and stops at any other character", () => {
    expect(winAnsi("≤ 0.5 % and ≥ 2")).toBe("<= 0.5 % and >= 2");
    expect(winAnsi("kg CO₂e")).toBe("kg CO2e");
    expect(winAnsi("Größe µm ² ß Ä")).toBe("Größe µm ² ß Ä");
    expect(() => winAnsi("日本")).toThrow(PdfTextError);
    expect(() => winAnsi("emoji 🙂")).toThrow(/U\+1F642/);
  });

  it("refuses the PDF with RR-PDF-CHARACTER when an authorised description holds a non-WinAnsi character, while other outputs succeed", async () => {
    const { release } = await releaseFor({ ...CLEAN, editLab: (d) => (d.authorised_texts[0].text += " Ω") }, pack);
    const entry = release.manifest.outputs.find((o) => o.route === "customer")!;
    expect(entry).toMatchObject({ fileName: null, sha256: null, status: "HOLD" });
    expect(entry.holds.map((h) => h.rule)).toEqual(["RR-PDF-CHARACTER"]);
    expect(entry.holds[0]).toMatchObject({ detail: "U+03A9", property: propertyBySlug(pack, "product-narrative") });
    expect(release.files.map((f) => f.route).sort()).toEqual(["internal", "registry"]);
  });

  it("prints ≤ as <= and never as HTML text", async () => {
    const record = await recordFor(pack, { ...CLEAN, editLab: (d) => (d.authorised_texts[0].text = "Cut-off ≤ 5 %, ≥ 95 % covered, CO₂e.") });
    const t = (await pdfText((await buildCustomerPdf(pack, record)).bytes)).replace(/\s+/g, " ");
    expect(t).toContain("<= 5 %");
    expect(t).toContain(">= 95 % covered");
    expect(t).toContain("CO2e");
    expect(t).not.toMatch(/&lt;|&gt;|&amp;/);
  });
});

describe("AT-E: no forbidden content in any output, for every accepted combination", () => {
  it.each(COMBINATIONS.map((c) => [`${c.erp} + ${c.lab ?? "no lab file"}`, c] as const))("%s", async (_, c) => {
    const record = await recordFor(pack, c);
    const outputs: Array<[Parameters<typeof assertNoLeakText>[1], () => Promise<string>]> = [
      ["customer", async () => pdfText((await buildCustomerPdf(pack, record)).bytes)],
      ["internal", async () => buildErpCsv(pack, record).text],
      ["registry", async () => buildRegistryJson(pack, record).text],
    ];
    for (const [route, make] of outputs) {
      let t: string;
      try {
        t = await make();
      } catch (e) {
        expect(e, route).toBeInstanceOf(RouteRefusedError);
        continue;
      }
      assertNoLeakText(t, route, record, pack);
    }
  });

  it("would notice a leak: the check fails on an output that carries a denied value", async () => {
    const record = await recordFor(pack, CLEAN);
    const t = buildErpCsv(pack, record).text;
    expect(() => assertNoLeakText(`${t},Stand-in aluminium sheet, alloy family 5754, specified thickness 1.5 mm. Made-up test data; no claim about any real product.`, "internal", record, pack)).toThrow(/leak/);
    expect(() => assertNoLeakText("raw lead 31.4 mg/kg EV-RC-DECL-001", "customer", record, pack)).toThrow(/leak/);
  });
});

describe("AT-U: reproducibility across two processes (C4-04)", () => {
  it("gives byte-identical files and the same substantive manifest in two separate runs, and the same as this process", async () => {
    const dirs = [mkdtempSync(join(tmpdir(), "dpp-run-a-")), mkdtempSync(join(tmpdir(), "dpp-run-b-"))];
    try {
      for (const dir of dirs) {
        execFileSync("npx", ["vitest", "run", "tests/unit/emit.test.ts"], { env: { ...process.env, EMIT_DIR: dir }, stdio: "pipe" });
      }
      const names = readdirSync(dirs[0]).sort();
      expect(names).toHaveLength(4);
      expect(readdirSync(dirs[1]).sort()).toEqual(names);
      const { release } = await releaseFor();
      const here = new Map([...release.files.map((f) => [f.fileName, f.bytes] as const), [release.manifestFile.fileName, release.manifestFile.bytes] as const]);
      for (const n of names) {
        const a = readFileSync(join(dirs[0], n));
        if (n === release.manifestFile.fileName) {
          const substantive = (bytes: Uint8Array) => {
            const { generated, ...rest } = JSON.parse(new TextDecoder().decode(bytes));
            expect(generated.at, n).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            return canonicalPretty(rest);
          };
          expect(substantive(a), n).toBe(substantive(readFileSync(join(dirs[1], n))));
          expect(substantive(a), `${n} in this process`).toBe(release.manifestFile.substantiveText);
          continue;
        }
        expect(a.equals(readFileSync(join(dirs[1], n))), n).toBe(true);
        expect(a.equals(Buffer.from(here.get(n)!)), `${n} in this process`).toBe(true);
      }
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("AT-T: output values trace to source cells that exist", () => {
  const resolve = (location: string): boolean => {
    const [file, rest] = [location.slice(0, location.indexOf(", ")), location.slice(location.indexOf(", ") + 2)];
    const body = fixtureText(file);
    const row = /^row (\d+), column (.+)$/.exec(rest);
    if (row) {
      const lines = body.split(/\r?\n/).filter(Boolean);
      return lines[0].split(",").includes(row[2]) && lines.length > Number(row[1]) - 1 && lines[Number(row[1]) - 1] !== undefined;
    }
    let node: unknown = JSON.parse(body);
    for (const k of rest.split("/").slice(1)) {
      if (node === null || typeof node !== "object" || !(k in (node as object))) return false;
      node = (node as Record<string, unknown>)[k];
    }
    return node !== undefined;
  };

  it("every present value of every output resolves, and derived outputs list every input with their rule", async () => {
    const { release } = await releaseFor();
    let derived = 0;
    for (const f of release.files) {
      for (const item of f.items.filter((i) => i.present)) {
        const chain = trace(f.lineage, outputRef(f.route, item.step));
        expect(chain.length, `${f.route} ${item.step}`).toBeGreaterThan(0);
        for (const e of chain) expect(resolve(e.assertion.location), e.assertion.location).toBe(true);
        if (item.kind === "derived") {
          derived++;
          expect(chain.every((e) => e.ruleId === item.ruleId)).toBe(true);
        }
      }
    }
    expect(derived).toBe(2);
  });
});

describe("no network", () => {
  it("makes all three outputs and the manifest without fetch, XMLHttpRequest or sendBeacon", async () => {
    const record = await recordFor(pack, CLEAN);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("network")));
    const xhr = vi.fn();
    const beacon = vi.fn();
    vi.stubGlobal("XMLHttpRequest", xhr);
    vi.stubGlobal("navigator", { ...globalThis.navigator, sendBeacon: beacon });
    try {
      await releaseFor(CLEAN, pack);
      await buildCustomerPdf(pack, record);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(xhr).not.toHaveBeenCalled();
      expect(beacon).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      fetchSpy.mockRestore();
    }
  });
});

describe("long texts are never cut off or drawn over the footer", () => {
  const FOOTER_TOP = 60;
  const sentences = (n: number) => Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} describes the rolled sheet.`);

  const check = async (c: Parameters<typeof recordFor>[1], expectAll: string[]) => {
    const record = await recordFor(pack, c);
    const f = await buildCustomerPdf(pack, record);
    const items = await pdfItems(f.bytes);
    const footer = items.filter((i) => i.y < FOOTER_TOP);
    const pageCount = new Set(items.map((i) => i.page)).size;
    expect(footer.every((i) => [44, 35, 26].includes(Math.round(i.y)))).toBe(true);
    expect(new Set(footer.map((i) => `${i.page}|${Math.round(i.y)}`)).size).toBe(3 * pageCount);
    expect(Math.min(...items.filter((i) => i.y >= FOOTER_TOP).map((i) => i.y))).toBeGreaterThanOrEqual(70);
    const body = items.filter((i) => i.y >= FOOTER_TOP).map((i) => i.str).join(" ").replace(/\s+/g, " ");
    for (const s of expectAll) expect(body.includes(s), s).toBe(true);
    return { f, pages: pageCount };
  };

  it("draws all 40 sentences of a 1,900-character authorised description without touching the footer", async () => {
    const all = sentences(40);
    expect(all.join(" ").length).toBeGreaterThan(1_800);
    expect(all.join(" ").length).toBeLessThanOrEqual(2_000);
    const { pages } = await check({ ...CLEAN, editLab: (d) => (d.authorised_texts[0].text = all.join(" ")) }, all);
    expect(pages).toBeGreaterThanOrEqual(2);
  });
});

describe("customer sheet clarity & column wrapping", () => {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();

  it("keeps each label inside its own column and explains the digests in the legend", async () => {
    const record = await recordFor(pack, CLEAN);
    const out = await buildCustomerPdf(pack, record);
    const text = await pdfText(out.bytes);
    const items = await pdfItems(out.bytes);
    const t = flat(text);
    expect(t).toContain("Reading this sheet");
    expect(t).toContain("The record digest and the contract pack digest in the footer identify exactly which record and which contract this sheet was made from.");
    const labels = out.items.filter((i) => i.present).flatMap((i) => [flat(i.label.en), flat(i.label.de)]);
    for (const l of labels) expect(t, l).toContain(l);
    const inColumn = (x: number) => items.filter((i) => Math.abs(i.x - x) < 0.5 && labels.some((l) => l.includes(flat(i.str))) && i.str.length > 2);
    const en = inColumn(48);
    const de = inColumn(190);
    expect(en.length).toBeGreaterThanOrEqual(10);
    expect(de.length).toBeGreaterThanOrEqual(10);
    for (const i of en) expect(i.x + i.width, i.str).toBeLessThanOrEqual(190 - 2);
    for (const i of de) expect(i.x + i.width, i.str).toBeLessThanOrEqual(332 - 2);
  });
});
