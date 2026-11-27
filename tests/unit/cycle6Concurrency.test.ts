// @vitest-environment node
/**
 * Cycle 6 Layer 3: transactional updates, idempotent imports, and multi-operator concurrency across
 * two independent SQLite WAL connections on the same on-disk database (C6-03).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../server/db/adapter";
import { migrateUp } from "../../server/db/migrations";
import { ImportJobRunner } from "../../server/jobs/importJobRunner";
import { PolicyStore } from "../../server/store/policyStore";
import { ConcurrencyConflictError } from "../../src/model/pContracts";
import type { ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, loadPack, propertyBySlug, text } from "../support/records";

const tmpDirs: string[] = [];
const mkDbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "dpp-c6-conc-"));
  tmpDirs.push(dir);
  return join(dir, "concurrent.sqlite");
};

const enc = (s: string) => new TextEncoder().encode(s);

function erpWithRecycled(pct: string): Uint8Array {
  const base = text(CLEAN.erp);
  const mutated = base.replace(",1.50,", `,${pct},`);
  expect(mutated).not.toBe(base);
  return enc(mutated);
}

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("Cycle 6 multi-operator concurrency and idempotency (C6-03)", () => {
  it("serializes two independent operators racing on the same record with optimistic expectedVersion=0", async () => {
    const dbPath = mkDbPath();
    const dbA = new SqliteAdapter({ path: dbPath });
    const dbB = new SqliteAdapter({ path: dbPath });
    try {
      migrateUp(dbA);
      new PolicyStore(dbA).activate(pack.policy.retention);

      const opA = new ImportJobRunner(dbA, pack);
      const opB = new ImportJobRunner(dbB, pack);

      const erpClean = fixtureBytes("n", CLEAN.erp);
      const labClean = fixtureBytes("n", CLEAN.lab);
      // Distinct second version (different recycled content) so both would change the record
      const erpAlt = erpWithRecycled("68.5");

      const [resA, resB] = await Promise.allSettled([
        opA.runImportJob({
          idempotencyKey: "op-a-v1",
          expectedVersion: 0,
          erp: { bytes: erpClean, name: CLEAN.erp, type: "text/csv" },
          lab: { bytes: labClean, name: CLEAN.lab, type: "application/json" },
        }),
        opB.runImportJob({
          idempotencyKey: "op-b-v1",
          expectedVersion: 0,
          erp: { bytes: erpAlt, name: "erp-alt.csv", type: "text/csv" },
          lab: { bytes: labClean, name: CLEAN.lab, type: "application/json" },
        }),
      ]);

      const fulfilled = [resA, resB].filter((r) => r.status === "fulfilled");
      const rejected = [resA, resB].filter((r): r is PromiseRejectedResult => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(ConcurrencyConflictError);

      // Exactly 1 snapshot persisted, zero duplicate or corrupted assertions
      const recs = opA.repository.recordsSync();
      expect(recs).toHaveLength(1);
      const hist = opA.repository.historySync(recs[0]!.model, recs[0]!.batch);
      expect(hist).toHaveLength(1);
      expect(hist[0]!.version).toBe(1);
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  it("auto-serializes two operators submitting distinct updates concurrently without losing assertions", async () => {
    const dbPath = mkDbPath();
    const dbA = new SqliteAdapter({ path: dbPath });
    const dbB = new SqliteAdapter({ path: dbPath });
    try {
      migrateUp(dbA);
      new PolicyStore(dbA).activate(pack.policy.retention);

      const opA = new ImportJobRunner(dbA, pack);
      const opB = new ImportJobRunner(dbB, pack);

      const erpV1 = fixtureBytes("n", CLEAN.erp);
      const erpV2 = erpWithRecycled("67.5");
      const lab = fixtureBytes("n", CLEAN.lab);

      const [outA, outB] = await Promise.all([
        opA.runImportJob({
          idempotencyKey: "auto-ser-a",
          erp: { bytes: erpV1, name: CLEAN.erp, type: "text/csv" },
          lab: { bytes: lab, name: CLEAN.lab, type: "application/json" },
        }),
        opB.runImportJob({
          idempotencyKey: "auto-ser-b",
          erp: { bytes: erpV2, name: "erp-42.csv", type: "text/csv" },
          lab: { bytes: lab, name: CLEAN.lab, type: "application/json" },
        }),
      ]);

      expect(outA.ok && outB.ok).toBe(true);
      const versions = [outA.receipt!.version, outB.receipt!.version].sort((a, b) => a - b);
      expect(versions).toEqual([1, 2]);

      const { model, batch } = outA.snapshot!;
      const hist = opA.repository.historySync(model, batch);
      expect(hist).toHaveLength(2);
      expect(hist[1]!.supersedes).toEqual({ version: 1, digest: hist[0]!.digest });
      // Every assertion count intact, nothing duplicated
      expect(hist[0]!.record.values.length).toBe(hist[1]!.record.values.length);
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  it("imports two distinct batches concurrently across two connections with zero cross-talk", async () => {
    const dbPath = mkDbPath();
    const dbA = new SqliteAdapter({ path: dbPath });
    const dbB = new SqliteAdapter({ path: dbPath });
    try {
      migrateUp(dbA);
      new PolicyStore(dbA).activate(pack.policy.retention);
      const opA = new ImportJobRunner(dbA, pack);
      const opB = new ImportJobRunner(dbB, pack);

      const erpA = fixtureBytes("n", CLEAN.erp);
      const labA = fixtureBytes("n", CLEAN.lab);
      const origBatch = JSON.parse(text(CLEAN.lab)).batch_id as string;
      const batchB = "B-2026-CONC-2";
      const erpB = enc(text(CLEAN.erp).replace(origBatch, batchB));
      const labB = enc(text(CLEAN.lab).replaceAll(origBatch, batchB));

      const [outA, outB] = await Promise.all([
        opA.runImportJob({
          idempotencyKey: "batch-a",
          erp: { bytes: erpA, name: "batch-a.csv", type: "text/csv" },
          lab: { bytes: labA, name: "batch-a.json", type: "application/json" },
        }),
        opB.runImportJob({
          idempotencyKey: "batch-b",
          erp: { bytes: erpB, name: "batch-b.csv", type: "text/csv" },
          lab: { bytes: labB, name: "batch-b.json", type: "application/json" },
        }),
      ]);

      expect(outA.ok && outB.ok).toBe(true);
      expect(opA.repository.recordsSync()).toHaveLength(2);
      expect(outA.snapshot!.batch).toBe(origBatch);
      expect(outB.snapshot!.batch).toBe(batchB);
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  it("enforces idempotency on replay and rejects reused idempotency keys with mismatched payloads", async () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      new PolicyStore(db).activate(pack.policy.retention);
      const runner = new ImportJobRunner(db, pack);

      const erp = fixtureBytes("n", CLEAN.erp);
      const lab = fixtureBytes("n", CLEAN.lab);
      const first = await runner.runImportJob({
        idempotencyKey: "idem-key-01",
        erp: { bytes: erp, name: CLEAN.erp, type: "text/csv" },
        lab: { bytes: lab, name: CLEAN.lab, type: "application/json" },
      });
      expect(first.receipt?.stored).toBe(true);
      expect(first.receipt?.version).toBe(1);

      // Identical replay returns stored=false and writes no new snapshot
      const replay = await runner.runImportJob({
        idempotencyKey: "idem-key-01",
        erp: { bytes: erp, name: CLEAN.erp, type: "text/csv" },
        lab: { bytes: lab, name: CLEAN.lab, type: "application/json" },
      });
      expect(replay.receipt?.stored).toBe(false);
      expect(replay.receipt?.version).toBe(1);
      expect(runner.repository.historySync(first.snapshot!.model, first.snapshot!.batch)).toHaveLength(1);

      // Same idempotencyKey with different file bytes throws idempotency-conflict
      const changedErp = erpWithRecycled("71.0");
      await expect(
        runner.runImportJob({
          idempotencyKey: "idem-key-01",
          erp: { bytes: changedErp, name: CLEAN.erp, type: "text/csv" },
          lab: { bytes: lab, name: CLEAN.lab, type: "application/json" },
        }),
      ).rejects.toMatchObject({ name: "ConcurrencyConflictError", code: "idempotency-conflict" });

      // Stale correction rejected under optimistic locking while fresh expectedVersion succeeds
      const propId = propertyBySlug(pack, "recycled-content");
      const corr1 = runner.repository.correctRecordAtomic(
        pack,
        { model: first.snapshot!.model, batch: first.snapshot!.batch, property: propId, raw: "45", reason: "Operator A correction" },
        { expectedVersion: 1 },
      );
      expect(corr1.snapshot.version).toBe(2);

      expect(() =>
        runner.repository.correctRecordAtomic(
          pack,
          { model: first.snapshot!.model, batch: first.snapshot!.batch, property: propId, raw: "48", reason: "Operator B stale correction" },
          { expectedVersion: 1 },
        ),
      ).toThrow(ConcurrencyConflictError);

      const corr2 = runner.repository.correctRecordAtomic(
        pack,
        { model: first.snapshot!.model, batch: first.snapshot!.batch, property: propId, raw: "48", reason: "Operator B refreshed correction" },
        { expectedVersion: 2 },
      );
      expect(corr2.snapshot.version).toBe(3);
      expect(runner.repository.historySync(first.snapshot!.model, first.snapshot!.batch)).toHaveLength(3);
    } finally {
      db.close();
    }
  });
});
