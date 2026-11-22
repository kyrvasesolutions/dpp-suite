// @vitest-environment node
/**
 * Contract tightness & live-mapping verification (C5-T1 / ADR-0002):
 * 1. Drop-one-input across every required profile property, every required ERP CSV column and every required
 *    laboratory JSON structure key — proving that no contract is too loose and no test passes by construction.
 * 2. Single-value anti-canned-data mutations across scalar permitted properties and derived properties — proving
 *    every route output changes live from its inputs and never substitutes canned text.
 * 3. Complete (100%) lineage continuity across v1 (import) -> v2 (correction) -> v3 (re-import carrying) -> v4 (confirmed).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { correctRecord, storeImport } from "../../src/model/correction";
import { byRole, importErpCsv, importLabJson, type ProductRecord } from "../../src/model/ingress";
import { generateRelease } from "../../src/model/outputs/release";
import { verifyRelease } from "../../src/model/outputs/manifest";
import { decide } from "../../src/model/policy";
import { ROUTES, type ProfilePack } from "../../src/model/profile";
import { assess } from "../../src/model/readiness";
import { MemoryRepository, recordDigest, storeRecord, type Snapshot } from "../../src/model/recordRepository";
import { pdfText } from "../support/pdfText";
import { CLEAN, loadPack, propertyBySlug, recordFor, text } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const enc = (s: string) => new TextEncoder().encode(s);

let pack: ProfilePack;
let cleanRecord: ProductRecord;

beforeAll(async () => {
  pack = await loadPack();
  cleanRecord = await recordFor(pack, CLEAN);
});

async function snapshotOf(record: ProductRecord): Promise<Snapshot> {
  const repo = new MemoryRepository();
  return (await storeRecord(repo, record)).snapshot;
}

describe("drop-one-input: every required profile property breaks its dependent routes", () => {
  it("removing any required property one at a time triggers RR-MISSING and refuses dependent outputs", async () => {
    const requiredProps = pack.properties.filter((p) => ROUTES.some((r) => p.requiredBy[r]));
    expect(requiredProps.length).toBeGreaterThanOrEqual(20);

    for (const prop of requiredProps) {
      const strippedValues = cleanRecord.values.filter((v) => v.property !== prop.id);
      const mutated: ProductRecord = {
        ...structuredClone(cleanRecord),
        values: strippedValues,
      };
      mutated.digest = await recordDigest(mutated);

      const readiness = assess(pack, mutated);
      const snap = await snapshotOf(mutated);
      const release = await generateRelease(pack, snap, { software: TEST_SOFTWARE });

      for (const route of ROUTES) {
        const rr = readiness.find((r) => r.route === route)!;
        const outcome = release.outcomes.find((o) => o.route === route)!;
        const manifestOut = release.manifest.outputs.find((o) => o.route === route)!;

        if (prop.requiredBy[route]) {
          expect(rr.status, `${prop.id} on ${route} must hold`).toBe("on-hold");
          expect(
            rr.holds.some((h) => h.ruleId === "RR-MISSING" && h.property === prop.id),
            `${prop.id} on ${route} must report RR-MISSING`,
          ).toBe(true);

          if (route === "registry-prep-json") {
            // registry always produces a HOLD draft and carries RR-MISSING alongside RR-STANDING-HOLD
            expect("file" in outcome, `${prop.id} registry draft`).toBe(true);
            const draft = JSON.parse(new TextDecoder().decode(("file" in outcome ? outcome.file.bytes : new Uint8Array()))) as {
              status: string;
              submission: string;
              holds: Array<{ rule: string; property?: string | null }>;
            };
            expect(draft.status).toBe("HOLD");
            expect(draft.submission).toBe("never");
            expect(draft.holds.some((h) => h.rule === "RR-MISSING" && h.property === prop.id)).toBe(true);
          } else {
            expect("refused" in outcome, `${prop.id} on ${route} must refuse output`).toBe(true);
            expect(release.files.some((f) => f.route === route), `${prop.id} on ${route} must not emit file`).toBe(false);
            expect(manifestOut.holds.some((h) => h.rule === "RR-MISSING" && h.property === prop.id)).toBe(true);
          }
        }
      }
    }
  });
});

describe("drop-one-input: every required ingress column and schema key is enforced", () => {
  it("dropping any required ERP CSV column fails ingress at stage structure with missing-column", async () => {
    const rawCsv = text(CLEAN.erp).trimEnd();
    const [headerLine, dataLine] = rawCsv.split(/\r?\n/);
    const headers = headerLine.split(";");
    const cells = dataLine.split(";");
    const requiredCols = pack.inputs.erp.columns.filter((c) => c.required);
    expect(requiredCols.length).toBeGreaterThanOrEqual(15);

    for (const col of requiredCols) {
      const idx = headers.indexOf(col.name);
      expect(idx, `column ${col.name} in fixture`).toBeGreaterThanOrEqual(0);
      const nextHeaders = headers.filter((_, i) => i !== idx);
      const nextCells = cells.filter((_, i) => i !== idx);
      const mutatedCsv = `${nextHeaders.join(";")}\n${nextCells.join(";")}\n`;
      const result = await importErpCsv(pack, { bytes: enc(mutatedCsv), name: `drop-${col.name}.csv`, type: "text/csv" });
      expect(result.ok, `dropping ${col.name} must fail`).toBe(false);
      if (!result.ok) {
        expect(result.stage, col.name).toBe("structure");
        expect(result.errors.some((e) => e.code === "missing-column"), col.name).toBe(true);
      }
    }
  });

  it("dropping any required laboratory JSON top-level or product key fails ingress at stage structure with schema", async () => {
    const structure = pack.inputs.lab.structure as {
      required?: string[];
      properties?: { product?: { required?: string[] } };
    };
    const topRequired = structure.required ?? [];
    const productRequired = structure.properties?.product?.required ?? [];
    expect(topRequired.length).toBeGreaterThanOrEqual(4);
    expect(productRequired.length).toBeGreaterThanOrEqual(3);

    for (const key of topRequired) {
      const doc = JSON.parse(text(CLEAN.lab)) as Record<string, unknown>;
      delete doc[key];
      const result = await importLabJson(pack, { bytes: enc(JSON.stringify(doc)), name: `drop-${key}.json`, type: "application/json" });
      expect(result.ok, `dropping root.${key} must fail`).toBe(false);
      if (!result.ok) {
        expect(result.stage, key).toBe("structure");
        expect(result.errors.some((e) => e.code === "schema"), key).toBe(true);
      }
    }

    for (const key of productRequired) {
      const doc = JSON.parse(text(CLEAN.lab)) as { product: Record<string, unknown> };
      delete doc.product[key];
      const result = await importLabJson(pack, { bytes: enc(JSON.stringify(doc)), name: `drop-product-${key}.json`, type: "application/json" });
      expect(result.ok, `dropping product.${key} must fail`).toBe(false);
      if (!result.ok) {
        expect(result.stage, key).toBe("structure");
        expect(result.errors.some((e) => e.code === "schema"), key).toBe(true);
      }
    }
  });
});

describe("anti-canned-data: single-value mutations change live outputs and lineage", () => {
  it("mutating each representative scalar permitted property changes ERP CSV and Customer PDF live", async () => {
    // Pick representative scalar properties by definition slug (never hard-coded property IDs)
    const cases: Array<{ slug: string; nextRaw: string; expectInPdf: boolean }> = [
      { slug: "nominal-thickness", nextRaw: "3.25", expectInPdf: true },
      { slug: "measured-thickness", nextRaw: "3.27", expectInPdf: true },
      { slug: "net-mass", nextRaw: "2875.5", expectInPdf: true },
      { slug: "recycled-content", nextRaw: "71.4", expectInPdf: true },
      { slug: "production-date", nextRaw: "2026-09-14", expectInPdf: true },
      { slug: "carbon-footprint", nextRaw: "4.95", expectInPdf: true },
      { slug: "product-narrative", nextRaw: "Mutated live narrative text for anti-canned check.", expectInPdf: true },
    ];

    for (const c of cases) {
      const propId = propertyBySlug(pack, c.slug);
      const repo = new MemoryRepository();
      const baseSnap = (await storeRecord(repo, cleanRecord)).snapshot;
      const target = baseSnap.record.values.find((v) => v.property === propId);
      expect(target, `value for ${c.slug}`).toBeDefined();

      const v2 = await correctRecord(pack, repo, {
        model: cleanRecord.model,
        batch: cleanRecord.batch,
        property: propId,
        member: target!.member,
        qualifier: target!.qualifier,
        raw: c.nextRaw,
        reason: `Anti-canned mutation check for ${c.slug}`,
      });
      const rel = await generateRelease(pack, v2, { software: TEST_SOFTWARE });

      // ERP CSV carries the mutated value when permitted
      if (decide(pack, "erp-staging-csv", propId) === "permit") {
        const csvFile = rel.files.find((f) => f.route === "erp-staging-csv")!;
        const csv = new TextDecoder().decode(csvFile.bytes);
        expect(csv, `${c.slug} in ERP CSV`).toContain(c.nextRaw);
      }

      // Customer PDF carries the mutated value when permitted (normalize PDF line wraps)
      if (c.expectInPdf && decide(pack, "customer-pdf", propId) === "permit") {
        const pdfFile = rel.files.find((f) => f.route === "customer-pdf")!;
        const extracted = (await pdfText(pdfFile.bytes)).replace(/\s+/g, " ");
        expect(extracted, `${c.slug} in Customer PDF`).toContain(c.nextRaw);
      }

      // Manifest lineage for that property reflects the v2 correction
      const lineage = rel.manifest.lineage.filter((l) => l.property === propId && l.member === target!.member && (!target!.qualifier || l.assertion.role === "correction"));
      expect(lineage.some((l) => l.assertion.role === "correction" && l.correction?.version === 2), `${c.slug} lineage`).toBe(true);
    }
  }, 15_000);

  it("mutating each derived property outside EN limits flips the Customer PDF from within to outside the limits", async () => {
    const baselineSnap = await snapshotOf(cleanRecord);
    const baselineRel = await generateRelease(pack, baselineSnap, { software: TEST_SOFTWARE });
    const baselinePdf = await pdfText(baselineRel.files.find((f) => f.route === "customer-pdf")!.bytes);
    expect(baselinePdf).toContain("within the limits");
    expect(baselinePdf).not.toContain("outside the limits");

    // Tensile strength mutated far above the EN 485-2 upper limit for EN AW-5754 H111
    const tensileId = propertyBySlug(pack, "tensile-strength");
    const highTensile = await recordFor(pack, {
      ...CLEAN,
      editLab: (doc) => {
        const obs = doc.observations.find((o: { property: string }) => o.property === tensileId);
        obs.value = 999;
      },
    });
    const tensileRel = await generateRelease(pack, await snapshotOf(highTensile), { software: TEST_SOFTWARE });
    const tensilePdf = await pdfText(tensileRel.files.find((f) => f.route === "customer-pdf")!.bytes);
    expect(tensilePdf).toContain("outside the limits");
    expect(tensilePdf).not.toContain("999"); // raw derived number stays withheld

    // Chemical composition element mutated far above the EN 573-3 limit
    const compId = propertyBySlug(pack, "chemical-composition");
    const highComp = await recordFor(pack, {
      ...CLEAN,
      editLab: (doc) => {
        const obs = doc.observations.find((o: { property: string }) => o.property === compId);
        obs.value = 99.5;
      },
    });
    const compRel = await generateRelease(pack, await snapshotOf(highComp), { software: TEST_SOFTWARE });
    const compPdf = await pdfText(compRel.files.find((f) => f.route === "customer-pdf")!.bytes);
    expect(compPdf).toContain("outside the limits");
    expect(compPdf).not.toContain("99.5"); // raw derived number stays withheld
  });
});

describe("100% lineage continuity across import -> correction -> re-import carrying -> confirmed re-import", () => {
  async function assertCompleteLineage(snap: Snapshot) {
    const release = await generateRelease(pack, snap, { software: TEST_SOFTWARE });
    expect(release.manifest.lineage.length).toBeGreaterThan(20);
    expect(release.manifest.record).toEqual({
      model: snap.model,
      batch: snap.batch,
      version: snap.version,
      digest: snap.record.digest,
      snapshotDigest: snap.digest,
    });

    const sourceKeys = new Set(snap.record.sources.map((s) => `${s.role}|${s.name}|${s.sha256}`));
    const manifestInputs = new Set(release.manifest.inputs.map((i) => `${i.role}|${i.name}|${i.sha256}`));

    for (const entry of release.manifest.lineage) {
      // Every lineage entry's source file must exist in both snapshot sources and manifest inputs
      const srcKey = `${entry.assertion.role}|${entry.assertion.file}|${entry.assertion.sha256}`;
      expect(sourceKeys.has(srcKey), `${entry.outputRef} source in snapshot`).toBe(true);
      expect(manifestInputs.has(srcKey), `${entry.outputRef} source in manifest inputs`).toBe(true);

      // Every lineage entry must trace back to an actual assertion in the snapshot
      const matchingValue = snap.record.values.find(
        (v) =>
          v.property === entry.property &&
          (entry.member === undefined || v.member === entry.member) &&
          v.assertions.some(
            (a) =>
              a.source.role === entry.assertion.role &&
              a.source.file === entry.assertion.file &&
              a.source.sha256 === entry.assertion.sha256 &&
              // detail-key lineage (e.g. /footprints/0/method) shares the file + prefix of the assertion location
              (a.source.location === entry.assertion.location || entry.assertion.location.startsWith(`${a.source.file}, `)),
          ),
      );
      expect(matchingValue, `${entry.outputRef} (${entry.property}) must resolve to an assertion`).toBeDefined();

      // A correction lineage entry must carry version, actor and non-empty reason
      if (entry.assertion.role === "correction") {
        expect(entry.correction, entry.outputRef).toMatchObject({ actor: "ACT-01" });
        expect(entry.correction!.version).toBeGreaterThanOrEqual(2);
        expect(entry.correction!.reason.length).toBeGreaterThan(0);
      }
    }

    // Verify manifest digests over all emitted files
    const check = await verifyRelease(
      release.manifestFile.bytes,
      release.files.map((f) => ({ name: f.fileName, bytes: f.bytes })),
      pack,
    );
    expect(check.ok, `v${snap.version} verifyRelease`).toBe(true);
  }

  it("maintains unbroken model/batch identity and 100% source/correction lineage across v1 -> v2 -> v3 -> v4", async () => {
    const repo = new MemoryRepository();
    const recycledId = propertyBySlug(pack, "recycled-content");

    // v1: clean import
    const v1 = (await storeImport(repo, cleanRecord)).snapshot;
    await assertCompleteLineage(v1);

    // v2: operator correction on recycled content (62.0 -> 63.5)
    const v2 = await correctRecord(pack, repo, {
      model: v1.model,
      batch: v1.batch,
      property: recycledId,
      raw: "63.5",
      reason: "Certificate confirms 63.5%",
    });
    await assertCompleteLineage(v2);

    // v3: re-import where another column changed (length 3000 -> 3100), carrying correction forward
    const v3 = (await storeImport(repo, await recordFor(pack, { ...CLEAN, editErp: (csv) => csv.replace(";3000;", ";3100;") }))).snapshot;
    expect(v3.version).toBe(3);
    await assertCompleteLineage(v3);

    // v4: re-import where ERP now confirms 63.5
    const v4 = (await storeImport(repo, await recordFor(pack, { ...CLEAN, editErp: (csv) => csv.replace(";3000;", ";3100;").replace(";62.0;", ";63.5;") }))).snapshot;
    expect(v4.version).toBe(4);
    await assertCompleteLineage(v4);

    // Verify model and batch identity stayed immutable across all 4 versions
    const modelId = byRole(pack, "model");
    const batchId = byRole(pack, "batch");
    for (const s of await repo.history(v1.model, v1.batch)) {
      expect(s.record.values.find((v) => v.property === modelId && v.member === "FLD-Identifier-value")?.assertions[0].raw).toBe(v1.model);
      expect(s.record.values.find((v) => v.property === batchId && v.member === "FLD-Identifier-value")?.assertions[0].raw).toBe(v1.batch);
    }
  });
});
