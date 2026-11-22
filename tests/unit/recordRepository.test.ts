// @vitest-environment node
/** Cycle 4: the central record. Append-only snapshots, a correction links to what it replaces, re-import stores nothing. */
import { beforeAll, describe, expect, it } from "vitest";
import { byRole } from "../../src/model/ingress";
import type { ProfilePack } from "../../src/model/profile";
import { MemoryRepository, RepositoryError, StoreRepository, snapshotDigest, storeRecord, type Snapshot, type SnapshotStore } from "../../src/model/recordRepository";
import { CLEAN, loadPack, recordFor } from "../support/records";

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});

const corrected = () => recordFor(pack, { ...CLEAN, editErp: (csv) => csv.replace(";H111;2.0;", ";H22;2.0;") });

describe("snapshots", () => {
  it("stores the first import as version 1 with its sources and an actor", async () => {
    const repo = new MemoryRepository();
    const record = await recordFor(pack, CLEAN);
    const { stored, snapshot } = await storeRecord(repo, record);
    expect(stored).toBe(true);
    expect(snapshot).toMatchObject({ model: record.model, batch: record.batch, version: 1, actor: "ACT-01", reason: "First import" });
    expect(snapshot.supersedes).toBeUndefined();
    expect(snapshot.sources.map((s) => s.role).sort()).toEqual(["erp", "lab"]);
    expect(snapshot.sources.every((s) => /^[0-9a-f]{64}$/.test(s.sha256))).toBe(true);
    expect(snapshot.record).toEqual(record);
    expect(snapshot.digest).toBe(await snapshotDigest(snapshot));
  });

  it("makes version 2 from a corrected re-import, linked to version 1, and leaves version 1 unchanged and readable", async () => {
    const repo = new MemoryRepository();
    const first = await recordFor(pack, CLEAN);
    const v1 = (await storeRecord(repo, first)).snapshot;
    const before = JSON.stringify(v1);
    const second = await corrected();
    expect(second.digest).not.toBe(first.digest);
    const { stored, snapshot: v2 } = await storeRecord(repo, second);
    expect(stored).toBe(true);
    expect(v2.version).toBe(2);
    expect(v2.supersedes).toEqual({ version: 1, digest: v1.digest });
    expect(v2.reason).toBe("Re-import");
    const read = await repo.get(first.model, first.batch, 1);
    expect(JSON.stringify(read)).toBe(before);
    expect((await repo.history(first.model, first.batch)).map((s) => s.version)).toEqual([1, 2]);
    expect((await repo.latest(first.model, first.batch))?.digest).toBe(v2.digest);
    // the temper changed in version 2 only
    const temper = byRole(pack, "temper");
    const text = (s: Snapshot) => s.record.values.find((v) => v.property === temper)!.assertions[0].raw;
    expect([text(v1), text(v2)]).toEqual(["H111", "H22"]);
  });

  it("stores nothing for an identical re-import", async () => {
    const repo = new MemoryRepository();
    const record = await recordFor(pack, CLEAN);
    await storeRecord(repo, record);
    const again = await storeRecord(repo, await recordFor(pack, CLEAN));
    expect(again.stored).toBe(false);
    expect(again.snapshot.version).toBe(1);
    expect(await repo.history(record.model, record.batch)).toHaveLength(1);
  });

  it("throws when a version is written again, skipped, or not linked to the latest", async () => {
    const repo = new MemoryRepository();
    const record = await recordFor(pack, CLEAN);
    const v1 = (await storeRecord(repo, record)).snapshot;
    await expect(repo.put(v1)).rejects.toThrow(/already exists/);
    const v2 = (await storeRecord(repo, await corrected())).snapshot;
    // a rewritten version 1 with other content is also refused
    await expect(repo.put({ ...v1, reason: "rewritten", digest: await snapshotDigest({ ...v1, reason: "rewritten" }) })).rejects.toThrow(RepositoryError);
    const gap = { ...v2, version: 4 };
    await expect(repo.put({ ...gap, digest: await snapshotDigest(gap) })).rejects.toThrow(/does not follow/);
    const unlinked = { ...v2, version: 3, supersedes: { version: 2, digest: "0".repeat(64) } };
    await expect(repo.put({ ...unlinked, digest: await snapshotDigest(unlinked) })).rejects.toThrow(/link/);
    await expect(repo.put({ ...v2, version: 3, supersedes: { version: 2, digest: v2.digest } })).rejects.toThrow(/does not match its digest/);
    expect((await repo.history(record.model, record.batch)).map((s) => s.version)).toEqual([1, 2]);
  });

  it("keeps a copy: changing what was read never changes what is stored", async () => {
    const repo = new MemoryRepository();
    const record = await recordFor(pack, CLEAN);
    await storeRecord(repo, record);
    const read = (await repo.latest(record.model, record.batch))!;
    read.record.values.length = 0;
    expect((await repo.latest(record.model, record.batch))!.record.values.length).toBeGreaterThan(0);
  });

  it("keeps different models and batches apart and lists them", async () => {
    const repo = new MemoryRepository();
    const a = await recordFor(pack, CLEAN);
    const b = await recordFor(pack, { ...CLEAN, editErp: (csv) => csv.replaceAll("B-2026-0417", "B-2026-0418"), editLab: (d) => (d.product.batch_id = "B-2026-0418") });
    await storeRecord(repo, a);
    await storeRecord(repo, b);
    expect(await repo.records()).toEqual([{ model: a.model, batch: a.batch }, { model: b.model, batch: b.batch }]);
    expect((await repo.history(a.model, a.batch)).length).toBe(1);
  });

  it("applies the same rules over any store (the IndexedDB repository uses this class)", async () => {
    const rows = new Map<string, Snapshot>();
    const store: SnapshotStore = {
      add: async (m, b, v, s) => {
        const k = `${m}|${b}|${v}`;
        if (rows.has(k)) throw new Error("exists");
        rows.set(k, s);
      },
      range: async (m, b) => [...rows.values()].filter((s) => s.model === m && s.batch === b).reverse(),
      keys: async () => [...rows.values()].map((s) => ({ model: s.model, batch: s.batch })),
    };
    const repo = new StoreRepository(store);
    const record = await recordFor(pack, CLEAN);
    await storeRecord(repo, record);
    await storeRecord(repo, await corrected());
    expect((await repo.history(record.model, record.batch)).map((s) => s.version)).toEqual([1, 2]);
  });
});
