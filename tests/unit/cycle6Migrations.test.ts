// @vitest-environment node
/**
 * Cycle 6 Layer 3: forward/backward SQL migrations, append-only DB triggers, EV-5 six time fields,
 * half-open validity intervals, and WAL hot backup checksum integrity (LEAN-DEF-05, EV-5, C7-05 prep).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../server/db/adapter";
import {
  appliedMigrations,
  computeStoreChecksum,
  currentMigrationVersion,
  MIGRATIONS,
  migrateDown,
  migrateUp,
} from "../../server/db/migrations";
import { ImportJobRunner } from "../../server/jobs/importJobRunner";
import { PolicyStore } from "../../server/store/policyStore";
import type { ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, loadPack } from "../support/records";

const tmpDirs: string[] = [];
const mkTmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "dpp-c6-mig-"));
  tmpDirs.push(dir);
  return dir;
};

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("Cycle 6 relational migrations, EV-5 schema, and append-only triggers", () => {
  it("runs forward/backward migrations (0 -> 2 -> 1 -> 2) while preserving exact store checksum", async () => {
    const dir = mkTmpDir();
    const db = new SqliteAdapter({ path: join(dir, "store.sqlite") });
    try {
      expect(currentMigrationVersion(db)).toBe(0);
      const up = migrateUp(db);
      expect(up.map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version));
      expect(currentMigrationVersion(db)).toBe(2);

      new PolicyStore(db).activate(pack.policy.retention);
      const runner = new ImportJobRunner(db, pack);
      const outcome = await runner.runImportJob({
        idempotencyKey: "mig-seed-1",
        erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
        lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
        timeEnvelope: {
          recordedAt: "2026-11-22T10:00:00Z",
          observedAt: "2026-11-18T08:30:00Z",
          declaredAt: "2026-11-19T14:00:00Z",
          publishedAt: null,
          validFrom: "2026-11-22T10:00:00Z",
          validTo: null,
        },
        evidence: [
          {
            evidenceId: "EV-MIG-1",
            issuer: "Demo Lab",
            revision: "1",
            recordKind: "test-report",
            contentBytes: new TextEncoder().encode("evidence-content-for-migration-check"),
          },
        ],
      });
      expect(outcome.ok).toBe(true);
      const beforeChecksum = computeStoreChecksum(db);

      // Roll back v2 (indexes) -> v1: data & checksum must be byte-for-byte identical
      migrateDown(db, 1);
      expect(currentMigrationVersion(db)).toBe(1);
      expect(computeStoreChecksum(db)).toBe(beforeChecksum);

      // Re-apply v1 -> v2: checksum still identical
      migrateUp(db);
      expect(currentMigrationVersion(db)).toBe(2);
      expect(computeStoreChecksum(db)).toBe(beforeChecksum);

      // Hot WAL backup produces a standalone DB with identical checksum
      const backupPath = join(dir, "backup.sqlite");
      db.backup(backupPath);
      const restored = new SqliteAdapter({ path: backupPath });
      try {
        expect(currentMigrationVersion(restored)).toBe(2);
        expect(computeStoreChecksum(restored)).toBe(beforeChecksum);
      } finally {
        restored.close();
      }

      // Full rollback to v0 drops all domain tables cleanly, and migrateUp restores empty schema cleanly
      migrateDown(db, 0);
      expect(currentMigrationVersion(db)).toBe(0);
      expect(appliedMigrations(db)).toHaveLength(0);
      migrateUp(db);
      expect(currentMigrationVersion(db)).toBe(2);
    } finally {
      db.close();
    }
  });

  it("refuses to run migrations if an applied migration checksum was tampered with", () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      db.run("UPDATE schema_migrations SET checksum = ? WHERE version = 1", "0".repeat(64));
      expect(() => migrateUp(db)).toThrow(/checksum mismatch/);
    } finally {
      db.close();
    }
  });

  it("enforces append-only snapshots and half-open [valid_from, valid_to) intervals at the SQL engine level", async () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      new PolicyStore(db).activate(pack.policy.retention);
      const runner = new ImportJobRunner(db, pack);
      const v1 = await runner.runImportJob({
        idempotencyKey: "ev5-v1",
        erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
        lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
        timeEnvelope: {
          recordedAt: "2026-11-22T10:00:00Z",
          observedAt: "2026-11-18T08:00:00Z",
          declaredAt: "2026-11-19T09:00:00Z",
          publishedAt: "2026-11-22T10:05:00Z",
          validFrom: "2026-11-22T10:00:00Z",
          validTo: null,
        },
      });
      expect(v1.ok).toBe(true);
      const { model, batch } = v1.snapshot!;

      // Distinct EV-5 time fields preserved without collapsing observation into recording time
      const meta1 = runner.repository.getSnapshotMeta(model, batch, 1)!;
      expect(meta1.timeEnvelope.recordedAt).toBe("2026-11-22T10:00:00Z");
      expect(meta1.timeEnvelope.observedAt).toBe("2026-11-18T08:00:00Z");
      expect(meta1.timeEnvelope.declaredAt).toBe("2026-11-19T09:00:00Z");
      expect(meta1.timeEnvelope.publishedAt).toBe("2026-11-22T10:05:00Z");
      expect(meta1.timeEnvelope.validFrom).toBe("2026-11-22T10:00:00Z");
      expect(meta1.timeEnvelope.validTo).toBeNull();

      // Direct SQL DELETE or content UPDATE is blocked by SQLite triggers
      expect(() => db.run("DELETE FROM snapshots WHERE version = 1")).toThrow(/append-only/);
      expect(() => db.run("UPDATE snapshots SET reason = 'tampered' WHERE version = 1")).toThrow(/append-only/);

      // Superseding v1 with a correction closes v1's half-open interval [valid_from, valid_to)
      const prop = pack.properties.find((p) => p.definitionRef.endsWith(":recycled-content"))!;
      runner.repository.correctRecordAtomic(
        pack,
        { model, batch, property: prop.id, raw: "45", reason: "Verified recycled share" },
        {
          expectedVersion: 1,
          timeEnvelope: {
            recordedAt: "2026-11-22T11:00:00Z",
            observedAt: null,
            declaredAt: "2026-11-22T10:55:00Z",
            publishedAt: null,
            validFrom: "2026-11-22T11:00:00Z",
            validTo: null,
          },
        },
      );

      const meta1Closed = runner.repository.getSnapshotMeta(model, batch, 1)!;
      const meta2 = runner.repository.getSnapshotMeta(model, batch, 2)!;
      expect(meta1Closed.timeEnvelope.validTo).toBe("2026-11-22T11:00:00Z");
      expect(meta2.timeEnvelope.validFrom).toBe("2026-11-22T11:00:00Z");
      expect(meta2.timeEnvelope.validTo).toBeNull();

      // Attempting to mutate an already-closed valid_to is also blocked by trigger
      expect(() =>
        db.run("UPDATE snapshots SET valid_to = '2026-11-22T12:00:00Z' WHERE version = 1"),
      ).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });
});
