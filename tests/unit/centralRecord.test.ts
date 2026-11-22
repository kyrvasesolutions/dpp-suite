// @vitest-environment node
/** Cycle 4: portable export and import of the central record (C4-08). */
import { beforeAll, describe, expect, it } from "vitest";
import { canonical, canonicalPretty, utf8 } from "../../src/model/canonical";
import { CentralRecordError, exportCentralRecord, importCentralRecord, restoreCentralRecord } from "../../src/model/centralRecord";
import type { ProfilePack } from "../../src/model/profile";
import { MemoryRepository, ORIGIN_IMPORTED, snapshotDigest, storeRecord, type Snapshot } from "../../src/model/recordRepository";
import { sha256Hex } from "../../src/model/profile";
import { recordDigest } from "../../src/model/recordRepository";
import { CLEAN, loadPack, propertyBySlug, recordFor } from "../support/records";

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});

const withTemper = (t: string) => recordFor(pack, { ...CLEAN, editErp: (csv) => csv.replace(";H111;2.0;", `;${t};2.0;`) });

async function build(versions: number) {
  const repo = new MemoryRepository();
  for (const t of ["H111", "H22", "H24"].slice(0, versions)) await storeRecord(repo, await withTemper(t));
  const first = (await repo.records())[0];
  return { repo, ...first };
}

describe.each([1, 3])("round trip with %i version(s)", (n) => {
  it("gives a repository state deep-equal to the original, and the same bytes again", async () => {
    const { repo, model, batch } = await build(n);
    const file = await exportCentralRecord(repo, pack, model, batch);
    const imported = await importCentralRecord(file.bytes, pack);
    expect(imported.snapshots).toHaveLength(n);
    expect(await imported.repository.history(model, batch)).toEqual(await repo.history(model, batch));
    expect(await imported.repository.records()).toEqual(await repo.records());
    const again = await exportCentralRecord(imported.repository, pack, model, batch);
    expect(again.text).toBe(file.text);
    expect(file.text).toBe(canonicalPretty(JSON.parse(file.text)));
    expect(JSON.parse(file.text)).toMatchObject({ format: "dpp-central-record", packManifestDigest: pack.manifestDigest });
  });

  it("restores into an empty repository and then skips what is there", async () => {
    const { repo, model, batch } = await build(n);
    const imported = await importCentralRecord((await exportCentralRecord(repo, pack, model, batch)).bytes, pack);
    const target = new MemoryRepository();
    expect(await restoreCentralRecord(target, imported)).toEqual({ added: n, skipped: 0 });
    // the same versions, each now saying that this copy was restored from a file (the origin is outside the digests)
    expect(await target.history(model, batch)).toEqual((await repo.history(model, batch)).map((s) => ({ ...s, origin: ORIGIN_IMPORTED })));
    expect(await restoreCentralRecord(target, imported)).toEqual({ added: 0, skipped: n });
  });
});

describe("refusals", () => {
  it("refuses a file in which any digest is wrong", async () => {
    const { repo, model, batch } = await build(3);
    const text = (await exportCentralRecord(repo, pack, model, batch)).text;
    const doc = JSON.parse(text);
    // a changed value, file digest left alone
    const edited = structuredClone(doc);
    edited.snapshots[0].record.values[0].assertions[0].raw = "changed";
    await expect(importCentralRecord(utf8(JSON.stringify(edited)), pack)).rejects.toThrow(/changed/);
    // a changed value with the file digest recomputed: the record digest still refuses it
    const { sha256: _s, ...rest } = edited;
    edited.sha256 = await sha256Hex(canonical(rest));
    await expect(importCentralRecord(utf8(JSON.stringify(edited)), pack)).rejects.toThrow(/does not match its digest/);
    // the digest of a snapshot replaced by another
    const swapped = structuredClone(doc);
    swapped.snapshots[1].digest = "0".repeat(64);
    const { sha256: _t, ...rest2 } = swapped;
    swapped.sha256 = await sha256Hex(canonical(rest2));
    await expect(importCentralRecord(utf8(JSON.stringify(swapped)), pack)).rejects.toThrow(CentralRecordError);
    // a whole version fully re-signed in place: the next version's link to it breaks
    const forged = structuredClone(doc) as { snapshots: Snapshot[]; sha256: string };
    const v1 = forged.snapshots[0];
    v1.reason = "forged";
    v1.digest = await snapshotDigest(v1);
    const { sha256: _u, ...rest3 } = forged;
    forged.sha256 = await sha256Hex(canonical(rest3));
    await expect(importCentralRecord(utf8(JSON.stringify(forged)), pack)).rejects.toThrow(/link/);
    // and a version dropped from the middle
    const gap = structuredClone(doc) as { snapshots: Snapshot[]; sha256: string };
    gap.snapshots.splice(1, 1);
    const { sha256: _v, ...rest4 } = gap;
    gap.sha256 = await sha256Hex(canonical(rest4));
    await expect(importCentralRecord(utf8(JSON.stringify(gap)), pack)).rejects.toThrow(/does not follow/);
  });

  it("refuses bad JSON, a duplicate key, an extra key, another pack, and any role but the operator", async () => {
    const { repo, model, batch } = await build(1);
    const file = await exportCentralRecord(repo, pack, model, batch);
    await expect(importCentralRecord(utf8("{broken"), pack)).rejects.toThrow(/not valid JSON/);
    await expect(importCentralRecord(utf8(file.text.replace('"format"', '"format":"x","format"')), pack)).rejects.toThrow(/not valid JSON/);
    const extra = JSON.parse(file.text);
    extra.note = "hidden";
    await expect(importCentralRecord(utf8(JSON.stringify(extra)), pack)).rejects.toThrow(/not a central-record export/);
    await expect(importCentralRecord(file.bytes, { ...pack, manifestDigest: "a".repeat(64) })).rejects.toThrow(/another contract pack/);
    await expect(importCentralRecord(file.bytes, pack, "ACT-06")).rejects.toThrow(/Only the operator/);
    await expect(exportCentralRecord(repo, pack, model, batch, "ACT-06")).rejects.toThrow(/Only the operator/);
    await expect(exportCentralRecord(repo, pack, "no such model", batch)).rejects.toThrow(/no central record/);
    // a flipped byte in the file
    const bytes = Uint8Array.from(file.bytes);
    bytes[bytes.length - 10] ^= 1;
    await expect(importCentralRecord(bytes, pack)).rejects.toThrow(CentralRecordError);
  });

  it("does not merge a record that differs from what the target already holds", async () => {
    const a = await build(2);
    const b = new MemoryRepository();
    await storeRecord(b, await withTemper("H111"));
    await storeRecord(b, await withTemper("H24"));
    const imported = await importCentralRecord((await exportCentralRecord(a.repo, pack, a.model, a.batch)).bytes, pack);
    await expect(restoreCentralRecord(b, imported)).rejects.toThrow(/differs/);
    expect((await b.history(a.model, a.batch)).map((s) => s.record.values.length)).toHaveLength(2);
  });
});

/** Changes a one-version export and seals it again consistently: record digest, snapshot digest and file sha256 all recomputed. */
async function resealed(edit: (snapshot: Snapshot) => void, c = CLEAN) {
  const repo = new MemoryRepository();
  const record = await recordFor(pack, c);
  await storeRecord(repo, record);
  const doc = JSON.parse((await exportCentralRecord(repo, pack, record.model, record.batch)).text);
  const s = doc.snapshots[0] as Snapshot;
  edit(s);
  s.record.digest = await recordDigest(s.record);
  s.digest = await snapshotDigest(s);
  const { sha256: _o, ...rest } = doc;
  doc.sha256 = await sha256Hex(canonical(rest));
  return utf8(JSON.stringify(doc));
}
const valueOf = (s: Snapshot, slug: string, member?: string) => s.record.values.find((v) => v.property === propertyBySlug(pack, slug) && v.member === member)!;

describe("the origin of a restored version", () => {
  it("is recorded as imported from a central-record file, not as a first import, and is outside the digest", async () => {
    const { repo, model, batch } = await build(2);
    const imported = await importCentralRecord((await exportCentralRecord(repo, pack, model, batch)).bytes, pack);
    const target = new MemoryRepository();
    await restoreCentralRecord(target, imported);
    for (const s of await target.history(model, batch)) {
      expect(s.origin).toBe(ORIGIN_IMPORTED);
      expect(s.digest).toBe(await snapshotDigest(s));
    }
    // it survives a second export and import
    const again = await importCentralRecord((await exportCentralRecord(target, pack, model, batch)).bytes, pack);
    expect(again.snapshots.every((s) => s.origin === ORIGIN_IMPORTED)).toBe(true);
    expect((await target.history(model, batch))[0].reason).toBe("First import");
  });
});

describe("re-checks on import: a file sealed again consistently is still checked against the contract", () => {
  it("accepts an untouched file sealed again, since only content that breaks the contract can be refused", async () => {
    await expect(importCentralRecord(await resealed(() => undefined), pack)).resolves.toBeDefined();
  });

  it("refuses a status that the assertions do not give, and a challenged flag that does not match", async () => {
    await expect(importCentralRecord(await resealed((s) => (valueOf(s, "alloy-designation").status = "single")), pack)).rejects.toThrow(/status is single, the assertions make it agreeing/);
    const conflict = { erp: CLEAN.erp, lab: "lab-conflicting-alloy.json" };
    await expect(
      importCentralRecord(await resealed((s) => (valueOf(s, "alloy-designation").status = "agreeing"), conflict), pack),
    ).rejects.toThrow(/status is agreeing, the assertions make it challenged/);
    await expect(
      importCentralRecord(await resealed((s) => valueOf(s, "alloy-designation").assertions.forEach((a) => (a.flags = a.flags.filter((f) => f !== "challenged"))), conflict), pack),
    ).rejects.toThrow(/challenged flag/);
  });

  it("refuses cleared or added flags", async () => {
    const unknownCode = { erp: "erp-unknown-company-code.csv", lab: CLEAN.lab };
    await expect(
      importCentralRecord(await resealed((s) => (valueOf(s, "manufacturer-id").assertions[0].flags = ["declared"]), unknownCode), pack),
    ).rejects.toThrow(/flags are \[declared\]/);
    await expect(importCentralRecord(await resealed((s) => valueOf(s, "nominal-thickness").assertions[0].flags.push("unknown-code")), pack), ).rejects.toThrow(/flags are/);
    await expect(
      importCentralRecord(await resealed((s) => (valueOf(s, "evidence-references").assertions[0].flags = ["declared"]), { erp: CLEAN.erp, lab: "lab-evidence-digest-missing.json" }), pack),
    ).rejects.toThrow(/evidence-digest-missing/);
    await expect(
      importCentralRecord(await resealed((s) => (valueOf(s, "carbon-footprint").assertions[0].flags = ["calculated-externally", "unit-stated", "evidence-linked"]), { erp: CLEAN.erp, lab: "lab-two-footprints.json" }), pack),
    ).rejects.toThrow(/several-results/);
  });

  it("refuses a code that the pinned code list does not hold, and a mapping that does not follow it", async () => {
    // a known code changed to an unknown one without the flag
    await expect(importCentralRecord(await resealed((s) => (valueOf(s, "manufacturer-id").assertions[0].raw = "SI77")), pack)).rejects.toThrow(/flags are|value is/);
    // the mapped value changed
    await expect(importCentralRecord(await resealed((s) => (valueOf(s, "manufacturer-id").assertions[0].value = "SOMEONE-ELSE")), pack)).rejects.toThrow(/the value is "SOMEONE-ELSE"/);
  });

  it("refuses numbers out of range, a changed literal, and units the contract does not allow", async () => {
    await expect(importCentralRecord(await resealed((s) => Object.assign(valueOf(s, "recycled-content").assertions[0], { raw: "620", value: 620 })), pack)).rejects.toThrow(/out of range/);
    await expect(importCentralRecord(await resealed((s) => (valueOf(s, "net-mass").assertions[0].value = 9999)), pack)).rejects.toThrow(/the value is 9999/);
    await expect(importCentralRecord(await resealed((s) => (valueOf(s, "net-mass").assertions[0].unit = "lb")), pack)).rejects.toThrow(/the unit is lb/);
    await expect(importCentralRecord(await resealed((s) => (valueOf(s, "tensile-strength").assertions[0].unit = "inch")), pack)).rejects.toThrow(/not allowed/);
    await expect(importCentralRecord(await resealed((s) => Object.assign(valueOf(s, "tensile-strength").assertions[0], { raw: "-5", value: -5 })), pack)).rejects.toThrow(/out of range/);
  });

  it("refuses a value that does not belong to its column, a property the profile lacks, and a source the record does not list", async () => {
    await expect(importCentralRecord(await resealed((s) => (valueOf(s, "net-mass").assertions[0].source.location = valueOf(s, "net-mass").assertions[0].source.location.replace("net_mass_kg", "alloy"))), pack)).rejects.toThrow(/maps to/);
    await expect(importCentralRecord(await resealed((s) => (valueOf(s, "net-mass").property = "ALU-D999")), pack)).rejects.toThrow(/not a property of the profile/);
    await expect(importCentralRecord(await resealed((s) => (valueOf(s, "net-mass").assertions[0].source.sha256 = "1".repeat(64))), pack)).rejects.toThrow(/not listed in the record/);
  });

  it("cannot tell a changed value that is still valid: that needs signing (documented limit)", async () => {
    const bytes = await resealed((s) => Object.assign(valueOf(s, "net-mass").assertions[0], { raw: "9999", value: 9999 }));
    const imported = await importCentralRecord(bytes, pack);
    expect(valueOf(imported.snapshots[0], "net-mass").assertions[0].raw).toBe("9999");
  });
});
