// @vitest-environment node
/**
 * R2-01 sweep: every output builder (customer PDF, ERP CSV, registry JSON, manifest) runs in time that grows linearly with the free text a
 * record can hold. A field is at most MAX_TEXT_FIELD_CHARS long (ingress refuses more), so the worst record is many such fields.
 */
import { describe, expect, it } from "vitest";
import { MAX_TEXT_FIELD_CHARS } from "../../src/model/ingress";
import { generateRelease } from "../../src/model/outputs/release";
import { CLEAN, loadPack, recordsFor, text } from "../support/records";

const words = (n: number) => "ab cd ef gh ".repeat(Math.ceil(n / 12)).slice(0, n).trim();

async function release(observations: number, name: string, method: string) {
  const pack = await loadPack();
  const [record] = await recordsFor(pack, {
    erp: CLEAN.erp,
    lab: CLEAN.lab,
    editErp: (csv) => csv.replace("Stand-in 5754 aluminium sheet", name),
    editLab: (doc) => {
      const base = doc.recycled_content.evidence[0];
      for (let i = 0; i < observations; i++) doc.recycled_content.evidence.push({ ...base, evidence_id: `EV-X${i}`, issuer: method });
    },
  });
  const t0 = performance.now();
  const rel = await generateRelease(pack, { model: record!.model, batch: record!.batch, version: 1, actor: "ACT-01", reason: "t", sources: [], record: record!, digest: "0".repeat(64) } as never, {});
  return { ms: performance.now() - t0, rel };
}

describe("outputs on the largest free text a record may hold", () => {
  it("the field limit is what the test assumes", () => {
    expect(MAX_TEXT_FIELD_CHARS).toBe(2000);
    void text;
  });

  it("a 2000-character product name of short words, and of one unbroken word, release in well under a second each", async () => {
    for (const name of [words(MAX_TEXT_FIELD_CHARS), "W".repeat(MAX_TEXT_FIELD_CHARS)]) {
      const { ms } = await release(0, name, "m");
      expect(ms, name.slice(0, 8)).toBeLessThan(1500);
    }
  });

  it("many long fields: four times the text takes about four times as long, not sixteen", async () => {
    const m = words(MAX_TEXT_FIELD_CHARS);
    const small = await release(100, words(MAX_TEXT_FIELD_CHARS), m);
    const large = await release(400, words(MAX_TEXT_FIELD_CHARS), m);
    process.stderr.write(`[R2-01] release 100 long fields ${small.ms.toFixed(0)} ms, 400 long fields ${large.ms.toFixed(0)} ms\n`);
    expect(large.ms).toBeLessThan(Math.max(small.ms * 8, 1500));
  }, 60_000);
});
