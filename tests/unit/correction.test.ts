// @vitest-environment node
/**
 * Cycle 5: correction of one value of the selected record, and the field-level difference between versions.
 * A correction is a new version with a reason; the earlier value stays; the corrected value counts as present, is never
 * silent, and its lineage names the correction. It cannot reach another record, the pack or a code list.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { exportCentralRecord, importCentralRecord, restoreCentralRecord } from "../../src/model/centralRecord";
import { canonicalPretty } from "../../src/model/canonical";
import { CorrectionError, correctRecord, diffHistory, diffSnapshots, storeImport } from "../../src/model/correction";
import { byRole, recheckRecord } from "../../src/model/ingress";
import { generateRelease } from "../../src/model/outputs/release";
import { verifyRelease } from "../../src/model/outputs/manifest";
import type { ProfilePack } from "../../src/model/profile";
import { assess } from "../../src/model/readiness";
import { MemoryRepository, storeRecord } from "../../src/model/recordRepository";
import { pdfText } from "../support/pdfText";
import { CLEAN, loadPack, propertyBySlug, recordFor } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});

const enc = (s: string) => new TextEncoder().encode(s);
const start = async (c = CLEAN) => {
  const repo = new MemoryRepository();
  const record = await recordFor(pack, c);
  await storeRecord(repo, record);
  return { repo, record, key: { model: record.model, batch: record.batch } };
};
const thickness = () => propertyBySlug(pack, "nominal-thickness");
const REASON = "Mill certificate shows 2.1 mm";

describe("a correction is a new version", () => {
  it("makes version 2 with the corrected value first, the earlier value kept, the status corrected and the reason recorded", async () => {
    const { repo, key } = await start();
    const v2 = await correctRecord(pack, repo, { ...key, property: thickness(), raw: "2.1", reason: REASON });
    expect(v2).toMatchObject({ version: 2, actor: "ACT-01", reason: REASON, supersedes: { version: 1 } });
    const value = v2.record.values.find((v) => v.property === thickness())!;
    expect(value.status).toBe("corrected");
    expect(value.assertions.map((a) => a.raw)).toEqual(["2.1", "2.0"]);
    expect(value.assertions[0]).toMatchObject({ value: 2.1, unit: "mm", flags: ["corrected"], correction: { version: 2, actor: "ACT-01", reason: REASON } });
    expect(value.assertions[0].source).toMatchObject({ role: "correction", file: "Operator correction v2" });
    expect(value.assertions[1].flags).toContain("unit-from-contract"); // the earlier assertion is untouched
    expect(v2.record.sources.map((s) => s.role)).toEqual(["erp", "lab", "correction"]);
    // version 1 is unchanged and readable
    const v1 = (await repo.get(key.model, key.batch, 1))!;
    expect(v1.record.values.find((v) => v.property === thickness())).toMatchObject({ status: "single" });
    expect(v2.digest).not.toBe(v1.digest);
    expect(recheckRecord(pack, v2.record)).toEqual([]);
  });

  it("can be corrected again; each correction stays", async () => {
    const { repo, key } = await start();
    await correctRecord(pack, repo, { ...key, property: thickness(), raw: "2.1", reason: "first" });
    const v3 = await correctRecord(pack, repo, { ...key, property: thickness(), raw: "2.2", reason: "second" });
    const value = v3.record.values.find((v) => v.property === thickness())!;
    expect(value.assertions.map((a) => [a.raw, a.correction?.version])).toEqual([["2.2", 3], ["2.1", 2], ["2.0", undefined]]);
    expect(recheckRecord(pack, v3.record)).toEqual([]);
  });

  it("needs a reason, and writes nothing without one", async () => {
    const { repo, key } = await start();
    for (const reason of ["", "   ", "\t"]) {
      await expect(correctRecord(pack, repo, { ...key, property: thickness(), raw: "2.1", reason })).rejects.toThrow(/needs a reason/);
    }
    await expect(correctRecord(pack, repo, { ...key, property: thickness(), raw: "2.1", reason: "a\nb" })).rejects.toThrow(CorrectionError);
    await expect(correctRecord(pack, repo, { ...key, property: thickness(), raw: "2.1", reason: "x".repeat(501) })).rejects.toThrow(CorrectionError);
    expect(await repo.history(key.model, key.batch)).toHaveLength(1);
  });

  it("is for the operator only", async () => {
    const { repo, key } = await start();
    await expect(correctRecord(pack, repo, { ...key, property: thickness(), raw: "2.1", reason: REASON }, "ACT-06")).rejects.toThrow(/Only the operator/);
    expect(await repo.history(key.model, key.batch)).toHaveLength(1);
  });
});

describe("a correction cannot reach beyond the selected record's value", () => {
  it("changes only the named record: another record, and the pack and its code lists, are left as they were", async () => {
    const { repo, key } = await start();
    const other = await recordFor(pack, { ...CLEAN, editErp: (csv) => csv.replace("B-2026-0417", "B-2026-0999") });
    await storeRecord(repo, other);
    const packBefore = canonicalPretty({ lists: pack.codeLists, pins: pack.pins, digest: pack.manifestDigest, props: pack.properties });
    const otherBefore = JSON.stringify(await repo.history(other.model, other.batch));
    await correctRecord(pack, repo, { ...key, property: thickness(), raw: "2.1", reason: REASON });
    expect(JSON.stringify(await repo.history(other.model, other.batch))).toBe(otherBefore);
    expect(await repo.history(key.model, key.batch)).toHaveLength(2);
    expect(canonicalPretty({ lists: pack.codeLists, pins: pack.pins, digest: pack.manifestDigest, props: pack.properties })).toBe(packBefore);
  });

  it("refuses a record that does not exist, and a value the record does not have", async () => {
    const { repo, key } = await start();
    await expect(correctRecord(pack, repo, { model: "PM-NOPE", batch: key.batch, property: thickness(), raw: "2.1", reason: REASON })).rejects.toThrow(/no record/);
    await expect(correctRecord(pack, repo, { ...key, batch: "B-NOPE", property: thickness(), raw: "2.1", reason: REASON })).rejects.toThrow(/no record/);
    await expect(correctRecord(pack, repo, { ...key, property: "ALU-D999", raw: "1", reason: REASON })).rejects.toThrow(/not in the record/);
    await expect(correctRecord(pack, repo, { ...key, property: thickness(), qualifier: "xx", raw: "2.1", reason: REASON })).rejects.toThrow(/not in the record/);
    expect(await repo.history(key.model, key.batch)).toHaveLength(1);
  });

  it("refuses the identifiers of the record and its evidence references", async () => {
    const { repo, key, record } = await start();
    for (const role of ["model", "batch", "evidence"] as const) {
      const v = record.values.find((x) => x.property === byRole(pack, role))!;
      await expect(correctRecord(pack, repo, { ...key, property: v.property, member: v.member, qualifier: v.qualifier, raw: "X-1", reason: REASON }), role).rejects.toThrow(/cannot be corrected by hand/);
    }
    expect(await repo.history(key.model, key.batch)).toHaveLength(1);
  });

  it.each([
    ["an empty value", "", /empty/],
    ["a padded value", " 2.1", /spaces/],
    ["a decimal comma", "2,1", /decimal comma/],
    ["text for a number", "thick", /plain number/],
    ["a negative thickness", "-2", /plain number|range/],
    ["zero thickness", "0", /range/],
    ["too many digits", "2.123456789012345678", /significant digits/],
    ["a line break", "2.1\n", /spaces|control/],
  ])("refuses %s as the corrected value", async (_, raw, message) => {
    const { repo, key } = await start();
    await expect(correctRecord(pack, repo, { ...key, property: thickness(), raw, reason: REASON })).rejects.toThrow(message);
    expect(await repo.history(key.model, key.batch)).toHaveLength(1);
  });

  it("accepts only a code the pinned list already has, and never adds a code", async () => {
    const { repo, key } = await start();
    const alloy = propertyBySlug(pack, "alloy-designation");
    await expect(correctRecord(pack, repo, { ...key, property: alloy, raw: "EN AW-9999", reason: REASON })).rejects.toThrow(/code list/);
    const ok = await correctRecord(pack, repo, { ...key, property: alloy, raw: "EN AW-6082", reason: REASON });
    expect(ok.record.values.find((v) => v.property === alloy)!.assertions[0]).toMatchObject({ raw: "EN AW-6082", value: "EN AW-6082" });
    expect(pack.codeLists.find((c) => c.ref.startsWith("ALLOY"))!.codes.map((c) => c.code)).not.toContain("EN AW-9999");
  });

  it("checks a laboratory value like the laboratory contract does: a number in its range", async () => {
    const { repo, key } = await start();
    const tensile = propertyBySlug(pack, "tensile-strength");
    await expect(correctRecord(pack, repo, { ...key, property: tensile, raw: "-5", reason: REASON })).rejects.toThrow(CorrectionError);
    const v2 = await correctRecord(pack, repo, { ...key, property: tensile, raw: "230", reason: REASON });
    expect(v2.record.values.find((v) => v.property === tensile)!.assertions[0]).toMatchObject({ value: 230, unit: "MPa", details: expect.objectContaining({ method: expect.any(String) }) });
  });
});

describe("a corrected value counts, and never silently", () => {
  it("resolves a challenged value and an unknown code in readiness, as present, while both earlier values stay", async () => {
    const challenged = await start({ ...CLEAN, lab: "lab-conflicting-alloy.json" });
    const alloy = propertyBySlug(pack, "alloy-designation");
    const before = assess(pack, challenged.record).flatMap((r) => r.holds.map((h) => h.ruleId));
    expect(before).toContain("RR-CHALLENGED");
    const v2 = await correctRecord(pack, challenged.repo, { ...challenged.key, property: alloy, raw: "EN AW-5754", reason: "ERP extract confirmed by the mill" });
    const value = v2.record.values.find((v) => v.property === alloy)!;
    expect(value.status).toBe("corrected");
    expect(value.assertions).toHaveLength(3);
    expect(assess(pack, v2.record).flatMap((r) => r.holds.map((h) => h.ruleId))).not.toContain("RR-CHALLENGED");

    const unknown = await start({ erp: "erp-unknown-company-code.csv", lab: CLEAN.lab });
    expect(assess(pack, unknown.record).flatMap((r) => r.holds.map((h) => h.ruleId))).toContain("RR-UNKNOWN-CODE");
    const company = propertyBySlug(pack, "manufacturer-id");
    const fixed = await correctRecord(pack, unknown.repo, { ...unknown.key, property: company, raw: "SI01", reason: "Wrong company code in the extract" });
    const after = assess(pack, fixed.record);
    expect(after.flatMap((r) => r.holds.map((h) => h.ruleId))).not.toContain("RR-UNKNOWN-CODE");
    expect(after.find((r) => r.route === "erp-staging-csv")!.required.find((r) => r.property === company)).toMatchObject({ state: "present", assured: true });
    expect(fixed.record.values.find((v) => v.property === company)!.assertions.map((a) => a.raw)).toEqual(["SI01", "SI99"]);
    expect(recheckRecord(pack, fixed.record)).toEqual([]);
  });

  it("puts the corrected value in the outputs and names the correction in the lineage: version, actor and reason", async () => {
    const { repo, key } = await start();
    const v2 = await correctRecord(pack, repo, { ...key, property: thickness(), raw: "2.37", reason: REASON });
    const release = await generateRelease(pack, v2, { software: TEST_SOFTWARE });
    const csv = new TextDecoder().decode(release.files.find((f) => f.route === "erp-staging-csv")!.bytes);
    const header = csv.split("\n")[0].split(";");
    const nominal = pack.routes["erp-staging-csv"].output.find((i) => i.property === thickness())!.csv!.header;
    expect(csv.split("\n")[1].split(";")[header.indexOf(nominal)]).toBe("2.37");
    const pdf = await pdfText(release.files.find((f) => f.route === "customer-pdf")!.bytes);
    expect(pdf).toContain("2.37");
    expect(pdf).not.toContain(REASON); // the recipient never sees the reason
    const entries = release.manifest.lineage.filter((e) => e.property === thickness());
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const e of entries) {
      expect(e.assertion.role).toBe("correction");
      expect(e.correction).toEqual({ version: 2, actor: "ACT-01", reason: REASON });
    }
    expect(release.manifest.inputs.map((i) => i.role).sort()).toEqual(["correction", "erp", "lab"]);
    expect((await verifyRelease(release.manifestFile.bytes, release.files.map((f) => ({ name: f.fileName, bytes: f.bytes })), pack)).ok).toBe(true);
  });

  it("leaves outputs for a record without corrections exactly as before", async () => {
    const { repo, key } = await start();
    const v1 = (await repo.get(key.model, key.batch, 1))!;
    const a = await generateRelease(pack, v1, { software: TEST_SOFTWARE });
    expect(a.manifest.lineage.every((e) => !e.correction && e.assertion.role !== "correction")).toBe(true);
  });
});

describe("the difference between versions, field by field", () => {
  it("lists exactly what a correction changed, in a fixed order, and nothing else", async () => {
    const { repo, key } = await start();
    const v2 = await correctRecord(pack, repo, { ...key, property: thickness(), raw: "2.1", reason: REASON });
    const v1 = (await repo.get(key.model, key.batch, 1))!;
    const d = diffSnapshots(v1, v2);
    expect(d).toMatchObject({ from: 1, to: 2, fromDigest: v1.digest, toDigest: v2.digest });
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]).toMatchObject({ property: thickness(), change: "changed" });
    const fields = Object.fromEntries(d.changes[0].fields.map((f) => [f.field, [f.before, f.after]]));
    expect(Object.keys(fields)).toEqual(["value", "status", "flags", "sources", "correction"]);
    expect(fields.value).toEqual(["2.0", "2.1"]);
    expect(fields.status).toEqual(["single", "corrected"]);
    expect(fields.correction).toEqual([null, `version 2, ACT-01: ${REASON}`]);
    // deterministic, and symmetric in what it names
    expect(diffSnapshots(v1, v2)).toEqual(d);
    expect(diffSnapshots(v2, v2).changes).toEqual([]);
    expect(diffSnapshots(v2, v1).changes[0].fields.find((f) => f.field === "value")).toEqual({ field: "value", before: "2.1", after: "2.0" });
  });

  it("compares any two versions and lists every consecutive pair of a history", async () => {
    const { repo, key } = await start();
    await correctRecord(pack, repo, { ...key, property: thickness(), raw: "2.1", reason: "a" });
    await correctRecord(pack, repo, { ...key, property: propertyBySlug(pack, "net-mass"), raw: "2400.0", reason: "b" });
    const h = await repo.history(key.model, key.batch);
    const pairs = diffHistory(h);
    expect(pairs.map((p) => [p.from, p.to, p.changes.length])).toEqual([[1, 2, 1], [2, 3, 1]]);
    expect(diffSnapshots(h[0], h[2]).changes.map((c) => c.property).sort()).toEqual([thickness(), propertyBySlug(pack, "net-mass")].sort());
  });
});

describe("the central-record file carries the corrections and their differences", () => {
  it("round-trips a corrected record with its diffs, and keeps the correction's version, actor and reason", async () => {
    const { repo, key } = await start();
    await correctRecord(pack, repo, { ...key, property: thickness(), raw: "2.1", reason: REASON });
    const file = await exportCentralRecord(repo, pack, key.model, key.batch);
    const doc = JSON.parse(file.text);
    expect(doc.diffs).toHaveLength(1);
    expect(doc.diffs[0].changes[0].fields.map((f: { field: string }) => f.field)).toContain("correction");
    const imported = await importCentralRecord(file.bytes, pack);
    const target = new MemoryRepository();
    expect(await restoreCentralRecord(target, imported)).toEqual({ added: 2, skipped: 0 });
    const v2 = (await target.get(key.model, key.batch, 2))!;
    expect(v2.record.values.find((v) => v.property === thickness())!.assertions[0].correction).toEqual({ version: 2, actor: "ACT-01", reason: REASON });
  });

  it("refuses a file whose differences, correction reason or correction value were changed", async () => {
    const { repo, key } = await start();
    await correctRecord(pack, repo, { ...key, property: thickness(), raw: "2.1", reason: REASON });
    const { text } = await exportCentralRecord(repo, pack, key.model, key.batch);
    const reseal = async (edit: (d: any) => void | Promise<void>) => {
      const d = JSON.parse(text);
      await edit(d);
      const { sha256: _s, ...rest } = d;
      const { canonical } = await import("../../src/model/canonical");
      const { sha256Hex } = await import("../../src/model/profile");
      return enc(canonicalPretty({ ...rest, sha256: await sha256Hex(canonical(rest)) }));
    };
    // differences that are not the versions' own
    await expect(importCentralRecord(await reseal((d) => {
      d.diffs[0].changes[0].fields[0].after = "9.9";
    }), pack)).rejects.toThrow(/differences/);
    // a correction edited with every digest made right again: only the contract checks can catch it
    const { recordDigest, snapshotDigest } = await import("../../src/model/recordRepository");
    const tamper = async (edit: (assertion: any, snapshot: any) => void) => {
      const bytes = await reseal(async (d) => {
        const s = d.snapshots[1];
        edit(s.record.values.find((v: any) => v.assertions[0].correction).assertions[0], s);
        s.record.digest = await recordDigest(s.record);
        s.digest = await snapshotDigest(s);
        d.diffs = [];
        delete d.diffs;
      });
      return importCentralRecord(bytes, pack);
    };
    await expect(tamper((a) => (a.raw = "2,1"))).rejects.toThrow(/decimal comma/);
    await expect(tamper((a) => (a.raw = "9999999"))).rejects.toThrow(/the corrected text gives|range|value is/);
    await expect(tamper((a) => (a.correction.reason = ""))).rejects.toThrow(/reason/);
    await expect(tamper((a) => (a.correction.version = 7))).rejects.toThrow(/later version|named for another/);
    await expect(tamper((a) => (a.flags = []))).rejects.toThrow(/contract checks/);
    await expect(tamper((_a, s) => (s.reason = "another reason"))).rejects.toThrow(/reason or actor/);
  });
});

describe("a re-import never silently undoes a correction", () => {
  const recycled = () => propertyBySlug(pack, "recycled-content");
  const withRecycled = (value: string) => recordFor(pack, { ...CLEAN, editErp: (csv) => csv.replace(";62.0;", `;${value};`) });
  const standing = (snapshot: { record: { values: Array<{ property: string; status: string; assertions: Array<{ raw: string; flags: string[]; source: { role: string; sha256: string } }> }> } }) => snapshot.record.values.find((v) => v.property === recycled())!;
  const setup = async () => {
    const repo = new MemoryRepository();
    const first = await storeImport(repo, await recordFor(pack, CLEAN));
    const key = { model: first.snapshot.model, batch: first.snapshot.batch };
    const v2 = await correctRecord(pack, repo, { ...key, property: recycled(), raw: "63.5", reason: "Certificate says 63.5" });
    return { repo, key, v2 };
  };

  it("labels versions honestly: the first import, a re-import, the operator's own reason, never 'Corrected import'", async () => {
    const { repo, key, v2 } = await setup();
    const h = await repo.history(key.model, key.batch);
    expect(h.map((s) => s.reason)).toEqual(["First import", "Certificate says 63.5"]);
    const again = await storeImport(repo, await recordFor(pack, { ...CLEAN, editErp: (csv) => csv.replace(";3000;", ";3100;") }));
    expect(again.snapshot.reason).toBe("Re-import: corrections carried forward");
    expect(again.snapshot.version).toBe(v2.version + 1);
    for (const s of await repo.history(key.model, key.batch)) expect(s.reason).not.toBe("Corrected import");
    const plain = new MemoryRepository();
    await storeImport(plain, await recordFor(pack, CLEAN));
    expect((await storeImport(plain, await recordFor(pack, { ...CLEAN, editErp: (csv) => csv.replace(";3000;", ";3100;") }))).snapshot.reason).toBe("Re-import");
  });

  it("carries the correction forward when the same files are imported again: nothing new is stored, the value stays corrected", async () => {
    const { repo, key, v2 } = await setup();
    const again = await storeImport(repo, await recordFor(pack, CLEAN));
    expect(again.stored).toBe(false);
    expect(again.snapshot.version).toBe(2);
    expect(again.snapshot.digest).toBe(v2.digest);
    expect(standing(again.snapshot)).toMatchObject({ status: "corrected" });
    expect(standing(again.snapshot).assertions.map((a) => a.raw)).toEqual(["63.5", "62.0"]);
    expect((await repo.history(key.model, key.batch)).length).toBe(2);
  });

  it("carries the correction onto a version where something else changed, still flagged and traced, and the outputs keep 63.5", async () => {
    const { repo } = await setup();
    const v3 = (await storeImport(repo, await recordFor(pack, { ...CLEAN, editErp: (csv) => csv.replace(";3000;", ";3100;") }))).snapshot;
    expect(v3.version).toBe(3);
    const value = standing(v3);
    expect(value.status).toBe("corrected");
    expect(value.assertions[0].flags).toEqual(["corrected"]);
    expect(recheckRecord(pack, v3.record)).toEqual([]);
    const release = await generateRelease(pack, v3, { software: TEST_SOFTWARE });
    const csv = new TextDecoder().decode(release.files.find((f) => f.route === "erp-staging-csv")!.bytes);
    expect(csv).toContain(";63.5;");
    expect(csv).not.toContain(";62.0;");
    const entries = release.manifest.lineage.filter((e) => e.property === recycled());
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.correction).toMatchObject({ version: 2, actor: "ACT-01", reason: "Certificate says 63.5" });
  });

  it("keeps both and challenges the value when the new source says something else, so the routes hold until the operator decides", async () => {
    const { repo, key } = await setup();
    const res = await storeImport(repo, await withRecycled("60.0"));
    expect(res.disputed).toBe(1);
    expect(res.snapshot.reason).toMatch(/^Re-import: the source changed after a correction/);
    const value = standing(res.snapshot);
    expect(value.status).toBe("challenged");
    expect(value.assertions.map((a) => a.raw)).toEqual(["63.5", "60.0"]);
    expect(value.assertions[1].flags).toContain("source-changed");
    expect(recheckRecord(pack, res.snapshot.record)).toEqual([]);
    const holds = assess(pack, res.snapshot.record).filter((r) => r.holds.some((h) => h.ruleId === "RR-CHALLENGED")).map((r) => r.route);
    expect(holds).toEqual(["customer-pdf", "erp-staging-csv"]);
    // an identical import of the same new file changes nothing, and the dispute stays
    const same = await storeImport(repo, await withRecycled("60.0"));
    expect(same.stored).toBe(false);
    expect(standing(same.snapshot).status).toBe("challenged");
    // the operator settles it with a correction: the earlier values stay, the flag that held the value is gone
    const settled = await correctRecord(pack, repo, { ...key, property: recycled(), raw: "61.0", reason: "Plant manager decision" });
    const done = standing(settled);
    expect(done.status).toBe("corrected");
    expect(done.assertions.map((a) => a.raw)).toEqual(["61.0", "63.5", "60.0"]);
    expect(assess(pack, settled.record).flatMap((r) => r.holds.map((h) => h.ruleId))).not.toContain("RR-CHALLENGED");
    expect(recheckRecord(pack, settled.record)).toEqual([]);
  });

  it("keeps the dispute when a later import returns to the value the correction replaced, until the operator settles it", async () => {
    const { repo } = await setup();
    await storeImport(repo, await withRecycled("60.0"));
    const back = await storeImport(repo, await withRecycled("62.0"));
    expect(standing(back.snapshot).status).toBe("challenged");
  });

  it("challenges the value when the new source drops it, keeping the correction and the replaced value attributed to its earlier file version", async () => {
    const { repo, key } = await setup();
    const res = await storeImport(repo, await recordFor(pack, { ...CLEAN, erp: "erp-missing-recycled-content.csv" }));
    expect(res.disputed).toBe(1);
    expect(res.carried).toBe(0);
    const value = standing(res.snapshot);
    expect(value.status).toBe("challenged");
    expect(value.assertions.map((a) => a.raw)).toEqual(["63.5", "62.0"]);
    expect(value.assertions[1].flags).toContain("source-changed");
    // the earlier ERP file version is retained in sources so the replaced assertion keeps its sha256 attribution
    const erpSources = res.snapshot.record.sources.filter((s) => s.role === "erp");
    expect(erpSources).toHaveLength(2);
    expect(erpSources[1].sha256).toBe(value.assertions[1].source.sha256);
    expect(recheckRecord(pack, res.snapshot.record)).toEqual([]);
    expect(assess(pack, res.snapshot.record).filter((r) => r.holds.some((h) => h.ruleId === "RR-CHALLENGED")).map((r) => r.route)).toEqual(["customer-pdf", "erp-staging-csv"]);
    // re-importing the same dropped file is idempotent and keeps the challenge
    const again = await storeImport(repo, await recordFor(pack, { ...CLEAN, erp: "erp-missing-recycled-content.csv" }));
    expect(again.stored).toBe(false);
    expect(standing(again.snapshot).status).toBe("challenged");
    // the operator can settle the challenge by confirming the corrected value
    const settled = await correctRecord(pack, repo, { ...key, property: recycled(), raw: "63.5", reason: "Confirmed despite ERP omission" });
    expect(standing(settled).status).toBe("corrected");
    expect(assess(pack, settled.record).flatMap((r) => r.holds.map((h) => h.ruleId))).not.toContain("RR-CHALLENGED");
    expect(recheckRecord(pack, settled.record)).toEqual([]);
  });

  it("confirms the correction when a later source comes to say the same value, even after an earlier dispute", async () => {
    const { repo } = await setup();
    // first dispute it with a different value (60.0), then re-import with the corrected value (63.5)
    const disputed = await storeImport(repo, await withRecycled("60.0"));
    expect(standing(disputed.snapshot).status).toBe("challenged");
    const confirmed = await storeImport(repo, await withRecycled("63.5"));
    expect(confirmed.carried).toBe(1);
    expect(confirmed.disputed).toBe(0);
    const value = standing(confirmed.snapshot);
    expect(value.status).toBe("corrected");
    expect(value.assertions.map((a) => [a.source.role, a.raw])).toEqual([["correction", "63.5"], ["erp", "63.5"]]);
    expect(value.assertions[1].flags).not.toContain("source-changed");
    expect(recheckRecord(pack, confirmed.snapshot.record)).toEqual([]);
    expect(assess(pack, confirmed.snapshot.record).flatMap((r) => r.holds.map((h) => h.ruleId))).not.toContain("RR-CHALLENGED");
  });

  it("exports and imports a disputed record, with its differences", async () => {
    const { repo, key } = await setup();
    await storeImport(repo, await withRecycled("60.0"));
    const file = await exportCentralRecord(repo, pack, key.model, key.batch);
    const imported = await importCentralRecord(file.bytes, pack);
    expect(imported.snapshots).toHaveLength(3);
  });
});

describe("a correction must change something", () => {
  it("refuses the value the record already has, however it is written, and says why", async () => {
    const { repo, key } = await start();
    const recycled = propertyBySlug(pack, "recycled-content");
    for (const raw of ["62.0", "62", "62.00"]) {
      await expect(correctRecord(pack, repo, { ...key, property: recycled, raw, reason: "no change" }), raw).rejects.toThrow(/same as the current value/);
    }
    expect(await repo.history(key.model, key.batch)).toHaveLength(1);
    const v2 = await correctRecord(pack, repo, { ...key, property: recycled, raw: "63.5", reason: "a" });
    await expect(correctRecord(pack, repo, { ...key, property: recycled, raw: "63.5", reason: "again" })).rejects.toThrow(/same as the current value/);
    expect(v2.version).toBe(2);
    expect(await repo.history(key.model, key.batch)).toHaveLength(2);
  });

  it("allows settling a challenged value on either of its two values", async () => {
    const challenged = await start({ ...CLEAN, lab: "lab-conflicting-alloy.json" });
    const alloy = propertyBySlug(pack, "alloy-designation");
    const v2 = await correctRecord(pack, challenged.repo, { ...challenged.key, property: alloy, raw: "EN AW-5083", reason: "the lab is right" });
    expect(v2.record.values.find((v) => v.property === alloy)!.status).toBe("corrected");
  });
});
