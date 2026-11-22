// @vitest-environment node
/**
 * Cycle 4: the customer PDF (C4-01, C4-09), the leak check over every output (AT-E), reproducibility across two processes
 * (AT-U, C4-04), the trace of ten random output values (AT-T, C4-07) and the absence of any network call.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { byRole } from "../../src/model/ingress";
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

describe("customer PDF", () => {
  it("is one PDF with the permitted content in the mapping's order, EN and DE labels, and the footprint context", async () => {
    const f = await buildCustomerPdf(pack, await recordFor(pack, CLEAN), { version: 3 });
    const t = await pdfText(f.bytes);
    expect(Buffer.from(f.bytes.slice(0, 5)).toString()).toBe("%PDF-");
    expect(f.mediaType).toBe("application/pdf");
    for (const it of pack.routes["customer-pdf"].output.filter((m) => m.role === "field")) {
      const label = pack.properties.find((p) => p.id === it.property)!.labels;
      expect(t, it.step).toContain(label.en.slice(0, 12));
      expect(t).toContain(label.de.slice(0, 12));
    }
    expect(t).toContain("Identification / Kennung");
    expect(t).toContain("ISO 14067:2018");
    expect(t).toContain("cradle-to-gate");
    expect(t).toContain("Reference year");
    expect(t).toContain("Record version 3");
    expect(t).toContain(pack.manifestDigest);
    expect(t).toContain((await recordFor(pack, CLEAN)).digest);
    // the order of the mapping: each field's label comes after the previous one's
    const at = (s: string) => t.indexOf(s);
    expect(at("Product model identifier")).toBeLessThan(at("Alloy designation"));
    expect(at("Alloy designation")).toBeLessThan(at("Nominal thickness"));
  });

  it("states derived properties only as statements with their basis and rule ID, never the raw value", async () => {
    const record = await recordFor(pack, CLEAN);
    const t = await pdfText((await buildCustomerPdf(pack, record)).bytes);
    for (const d of pack.policy.derived.rules) {
      expect(t).toContain(d.id);
      expect(t).toContain(`illustrative limits after ${d.standard}`);
    }
    expect(t).toMatch(/within the limits/);
    const tensile = record.values.find((v) => v.property === propertyBySlug(pack, "tensile-strength"))!.assertions[0].raw;
    expect(t).not.toMatch(new RegExp(`(?<![\\w.-])${tensile}(?![\\w.])`));
    expect(t).not.toContain("Demo test laboratory");
    expect(t).not.toContain("EV-TR-0417");
    expect(t).not.toContain("SS01");
  });

  it("shows the source of each value in the public form, never a file name", async () => {
    const t = await pdfText((await buildCustomerPdf(pack, await recordFor(pack, CLEAN))).bytes);
    expect(t).toContain("Source: ERP extract, row 2, column alloy");
    expect(t).toContain("Source: Laboratory file, /product/alloy");
    expect(t).not.toMatch(/d03a|\.csv|\.json/);
  });

  it("has no producer, creator or date metadata", async () => {
    const f = await buildCustomerPdf(pack, await recordFor(pack, CLEAN));
    const raw = Buffer.from(f.bytes).toString("latin1");
    for (const key of ["/Producer", "/Creator", "/CreationDate", "/ModDate", "/Author", "/Title"]) expect(raw, key).not.toContain(key);
  });

  it("refuses a route on hold, with its reasons, and makes no PDF", async () => {
    const record = await recordFor(pack, { erp: CLEAN.erp, lab: "lab-conflicting-alloy.json" });
    await expect(buildCustomerPdf(pack, record)).rejects.toThrow(RouteRefusedError);
    await expect(buildCustomerPdf(pack, await recordFor(pack, { erp: "erp-missing-recycled-content.csv", lab: CLEAN.lab }))).rejects.toThrow(/on hold/);
  });

  it("spells ≤ ≥ ₂ in ASCII, keeps WinAnsi characters, and stops at any other character", () => {
    expect(winAnsi("≤ 0.5 % and ≥ 2")).toBe("<= 0.5 % and >= 2");
    expect(winAnsi("kg CO₂e")).toBe("kg CO2e");
    expect(winAnsi("Größe µm ² ß Ä")).toBe("Größe µm ² ß Ä");
    expect(() => winAnsi("日本")).toThrow(PdfTextError);
    expect(() => winAnsi("emoji 🙂")).toThrow(/U\+1F642/);
  });

  it("refuses the file with the rule RR-PDF-CHARACTER, naming the value, when a value holds a character the font lacks", async () => {
    const record = await recordFor(pack, { ...CLEAN, editLab: (d) => (d.footprints[0].calculated_by = "Лаборатория") });
    const error = await buildCustomerPdf(pack, record).catch((e) => e);
    expect(error).toBeInstanceOf(RouteRefusedError);
    expect(error.holds).toHaveLength(1);
    expect(error.holds[0]).toMatchObject({ ruleId: "RR-PDF-CHARACTER", property: propertyBySlug(pack, "carbon-footprint") });
    expect(error.holds[0].sources[0].location).toContain("/footprints/0/value");
    expect(error.message).toContain("U+041B");
    expect(pack.policy.readiness.rules.some((r) => r.id === "RR-PDF-CHARACTER")).toBe(true);
  });

  it("lists the refusal with its rule in the release manifest, and the other outputs are still made", async () => {
    const { release } = await releaseFor({ ...CLEAN, editLab: (d) => (d.footprints[0].calculated_by = "Лаборатория") }, pack);
    const entry = release.manifest.outputs.find((o) => o.route === "customer-pdf")!;
    expect(entry).toMatchObject({ fileName: null, sha256: null, status: "hold" });
    expect(entry.holds.map((h) => h.rule)).toEqual(["RR-PDF-CHARACTER"]);
    expect(release.files.map((f) => f.route).sort()).toEqual(["erp-staging-csv", "registry-prep-json"]);
  });

  it("prints ≤ as <= and never as HTML text", async () => {
    const record = await recordFor(pack, { ...CLEAN, editLab: (d) => (d.footprints[0].method = "ISO 14067 (≤ 5 % cut-off, ≥ 95 % covered, CO₂e)") });
    const t = await pdfText((await buildCustomerPdf(pack, record)).bytes);
    expect(t).toContain("<= 5 % cut-off");
    expect(t).toContain(">= 95 % covered");
    expect(t).toContain("CO2e");
    expect(t).not.toMatch(/&lt;|&gt;|&amp;/);
  });
});

describe("AT-E: no forbidden content in any output, for every accepted combination", () => {
  it.each(COMBINATIONS.map((c) => [`${c.erp} + ${c.lab ?? "no lab file"}`, c] as const))("%s", async (_, c) => {
    const record = await recordFor(pack, c);
    const outputs: Array<[Parameters<typeof assertNoLeakText>[1], () => Promise<string>]> = [
      ["customer-pdf", async () => pdfText((await buildCustomerPdf(pack, record)).bytes)],
      ["erp-staging-csv", async () => buildErpCsv(pack, record).text],
      ["registry-prep-json", async () => buildRegistryJson(pack, record).text],
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
    const t = `${buildErpCsv(pack, record).text}`;
    // the narrative is denied for ERP staging; the evidence is denied for the customer
    expect(() => assertNoLeakText(`${t};${fixtureText("d03a-lab-assessment.json").includes("Fassaden") ? "Gewalztes Aluminiumblech für Fassaden und Dächer, walzblank geliefert." : "x"}`, "erp-staging-csv", record, pack)).toThrow(/leak/);
    expect(() => assertNoLeakText("Demo test laboratory (synthetic) EV-TR-0417", "customer-pdf", record, pack)).toThrow(/leak/);
  });
});

describe("AT-U: reproducibility across two processes (C4-04)", () => {
  it("gives byte-identical files and manifest in two separate runs, and the same as this process", async () => {
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
        expect(a.equals(readFileSync(join(dirs[1], n))), n).toBe(true);
        expect(a.equals(Buffer.from(here.get(n)!)), `${n} in this process`).toBe(true);
      }
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("AT-T: ten random output values trace to a source cell that exists", () => {
  // a seeded generator, so the choice is the same on every run
  const rng = (seed: number) => () => ((seed = (seed + 0x6d2b79f5) | 0), (((t) => ((t ^ (t >>> 14)) >>> 0) / 4294967296)(Math.imul(seed ^ (seed >>> 15), 1 | seed))));

  const resolve = (location: string): boolean => {
    const [file, rest] = [location.slice(0, location.indexOf(", ")), location.slice(location.indexOf(", ") + 2)];
    const body = fixtureText(file);
    const row = /^row (\d+), column (.+)$/.exec(rest);
    if (row) {
      const lines = body.split(/\r?\n/).filter(Boolean);
      return lines[0].split(";").includes(row[2]) && lines.length > Number(row[1]) - 1 && lines[Number(row[1]) - 1] !== undefined;
    }
    let node: unknown = JSON.parse(body);
    for (const k of rest.split("/").slice(1)) {
      if (node === null || typeof node !== "object" || !(k in (node as object))) return false;
      node = (node as Record<string, unknown>)[k];
    }
    return node !== undefined;
  };

  it("resolves 10 values chosen at random from the three outputs", async () => {
    const { release } = await releaseFor();
    const pool = release.files.flatMap((f) => f.items.filter((i) => i.present).map((i) => ({ route: f.route, item: i, lineage: f.lineage })));
    const next = rng(20261122);
    const picked = new Set<number>();
    while (picked.size < 10) picked.add(Math.floor(next() * pool.length));
    for (const n of picked) {
      const { route, item, lineage } = pool[n];
      const chain = trace(lineage, outputRef(route, item.step));
      expect(chain.length, `${route} ${item.step}`).toBeGreaterThan(0);
      for (const e of chain) {
        expect(e.stepId).toBe(item.step);
        expect(resolve(e.assertion.location), `${e.outputRef}: ${e.assertion.location}`).toBe(true);
      }
    }
  });

  it("every present value of every output resolves, and a derived one lists every input", async () => {
    const { release } = await releaseFor();
    let derived = 0;
    for (const f of release.files) {
      for (const item of f.items.filter((i) => i.present)) {
        const chain = trace(f.lineage, outputRef(f.route, item.step));
        expect(chain.length).toBeGreaterThan(0);
        for (const e of chain) expect(resolve(e.assertion.location), e.assertion.location).toBe(true);
        if (item.kind === "derived") {
          derived++;
          expect(chain.some((e) => e.property === byRole(pack, "alloy"))).toBe(true);
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
  const FOOTER_TOP = 60; // the footer's three lines sit at y = 26, 35 and 44; nothing else may be drawn below this
  const sentences = (n: number) => Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} describes the rolled sheet.`);

  const check = async (c: Parameters<typeof recordFor>[1], expectAll: string[], mustHaveSources: string[]) => {
    const record = await recordFor(pack, c);
    const f = await buildCustomerPdf(pack, record);
    const items = await pdfItems(f.bytes);
    const footer = items.filter((i) => i.y < FOOTER_TOP);
    // only the footer is drawn low on the page: three lines per page at fixed heights, and nothing between them and the text above
    const pageCount = new Set(items.map((i) => i.page)).size;
    expect(footer.every((i) => [44, 35, 26].includes(Math.round(i.y)))).toBe(true);
    expect(new Set(footer.map((i) => `${i.page}|${Math.round(i.y)}`)).size).toBe(3 * pageCount);
    expect(Math.min(...items.filter((i) => i.y >= FOOTER_TOP).map((i) => i.y))).toBeGreaterThanOrEqual(70);
    const body = items.filter((i) => i.y >= FOOTER_TOP).map((i) => i.str).join(" ").replace(/\s+/g, " ");
    for (const s of expectAll) expect(body.includes(s), s).toBe(true);
    for (const s of mustHaveSources) expect(body).toContain(s);
    return { f, pages: pageCount };
  };

  it("draws all 400 sentences of a 10,000-character narrative and both of its source lines, over several pages", async () => {
    const all = sentences(400);
    expect(all.join(" ").length).toBeGreaterThan(10_000);
    const { pages } = await check(
      { ...CLEAN, editLab: (d) => (d.texts[0].text = all.join(" ")) },
      all,
      ["Source: Laboratory file, /texts/0/text", "Source: Laboratory file, /texts/1/text"],
    );
    expect(pages).toBeGreaterThan(3);
  });

  it("draws an 800-word product name in full, in the title and in its item, without touching the footer", async () => {
    const words = Array.from({ length: 800 }, (_, i) => `Wort${i + 1}`);
    const name = words.join(" ");
    const { f } = await check(
      { ...CLEAN, editErp: (csv) => csv.replace("Aluminiumblech EN AW-5754 H111, 2,0 mm", name) },
      [name],
      ["Source: ERP extract, row 2, column product_name_de"],
    );
    const t = await pdfText(f.bytes);
    // the title and the item both carry it
    expect(t.split("Wort800").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("keeps every line above the bottom margin when many values fill the pages", async () => {
    const { pages } = await check({ ...CLEAN, editLab: (d) => (d.texts[1].text = sentences(120).join(" ")) }, sentences(120), []);
    expect(pages).toBeGreaterThanOrEqual(2);
  });
});
