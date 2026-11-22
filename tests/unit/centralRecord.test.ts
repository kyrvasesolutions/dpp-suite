// @vitest-environment node
/** Cycle 4: portable export and import of the central record (C4-08). */
import { beforeAll, describe, expect, it } from "vitest";
import { canonical, canonicalPretty, utf8 } from "../../src/model/canonical";
import { CentralRecordError, exportCentralRecord, importCentralRecord, restoreCentralRecord } from "../../src/model/centralRecord";
import type { ProfilePack } from "../../src/model/profile";
import { MemoryRepository, snapshotDigest, storeRecord, type Snapshot } from "../../src/model/recordRepository";
import { sha256Hex } from "../../src/model/profile";
import { CLEAN, loadPack, recordFor } from "../support/records";

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
    expect(await target.history(model, batch)).toEqual(await repo.history(model, batch));
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
