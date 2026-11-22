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
  computeStoreChecksum,
  currentMigrationVersion,
  MIGRATIONS,
  migrationChecksum,
  migrateDown,
  migrateUp,
} from "../../server/db/migrations";
import { ImportJobRunner } from "../../server/jobs/importJobRunner";
import { PolicyStore } from "../../server/store/policyStore";
import { SqlEvidenceStore } from "../../server/store/sqlEvidenceStore";
import { createHash } from "node:crypto";
import type { ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, loadPack } from "../support/records";

const tmpDirs: string[] = [];
const mkTmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "dpp-c6-mig-"));
  tmpDirs.push(dir);
  return dir;
};

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("Cycle 6 relational migrations, EV-5 schema, and append-only triggers", () => {
  it("runs forward/backward migrations (0 -> latest -> 1 -> latest) while preserving exact store checksum", async () => {
    const dir = mkTmpDir();
    const db = new SqliteAdapter({ path: join(dir, "store.sqlite") });
    try {
      expect(currentMigrationVersion(db)).toBe(0);
      const up = migrateUp(db);
      expect(up.map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version));
      expect(currentMigrationVersion(db)).toBe(MIGRATIONS.length);

      new PolicyStore(db).activate(pack.policy.retention);
      // stored when the server clock read 2000-01-01: every horizon has ended, so a rollback may drop the tables
      const runner = new ImportJobRunner(db, pack, undefined, { now: () => "2000-01-01T00:00:00.000Z" });
      const outcome = await runner.runImportJob({
        idempotencyKey: "mig-seed-1",
        erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
        lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
        timeEnvelope: {
          observedAt: "2000-01-01T00:00:00Z",
          declaredAt: "2000-01-01T00:00:00Z",
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

      // Roll back everything after v1 (indexes, retention guards, job input key) -> v1: data & checksum identical
      migrateDown(db, 1);
      expect(currentMigrationVersion(db)).toBe(1);
      expect(computeStoreChecksum(db)).toBe(beforeChecksum);

      // Re-apply -> latest: checksum still identical
      migrateUp(db);
      expect(currentMigrationVersion(db)).toBe(MIGRATIONS.length);
      expect(computeStoreChecksum(db)).toBe(beforeChecksum);

      // Hot WAL backup produces a standalone DB with identical checksum
      const backupPath = join(dir, "backup.sqlite");
      db.backup(backupPath);
      const restored = new SqliteAdapter({ path: backupPath });
      try {
        expect(currentMigrationVersion(restored)).toBe(MIGRATIONS.length);
        expect(computeStoreChecksum(restored)).toBe(beforeChecksum);
      } finally {
        restored.close();
      }

      // Nothing is retained any more (every horizon ended), so a full rollback is allowed and the schema comes back
      migrateDown(db, 0);
      expect(currentMigrationVersion(db)).toBe(0);
      migrateUp(db);
      expect(currentMigrationVersion(db)).toBe(MIGRATIONS.length);
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
      const runner = new ImportJobRunner(db, pack, undefined, { now: () => "2026-11-22T10:00:00.000Z" });
      const v1 = await runner.runImportJob({
        idempotencyKey: "ev5-v1",
        erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
        lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
        // recordedAt, publishedAt and validTo are server business: a caller's values for them are ignored
        timeEnvelope: {
          recordedAt: "1990-01-01T00:00:00Z",
          observedAt: "2026-11-18T08:00:00Z",
          declaredAt: "2026-11-19T09:00:00Z",
          publishedAt: "2026-11-22T10:05:00Z",
          validFrom: "2026-11-22T10:00:00Z",
          validTo: null,
        } as never,
      });
      expect(v1.ok).toBe(true);
      const { model, batch } = v1.snapshot!;

      // Distinct EV-5 time fields preserved without collapsing observation into recording time
      const meta1 = runner.repository.getSnapshotMeta(model, batch, 1)!;
      expect(meta1.timeEnvelope.recordedAt).toBe("2026-11-22T10:00:00.000Z");
      expect(meta1.timeEnvelope.observedAt).toBe("2026-11-18T08:00:00.000Z");
      expect(meta1.timeEnvelope.declaredAt).toBe("2026-11-19T09:00:00.000Z");
      expect(meta1.timeEnvelope.publishedAt).toBeNull();
      expect(meta1.timeEnvelope.validFrom).toBe("2026-11-22T10:00:00.000Z");
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
      expect(meta1Closed.timeEnvelope.validTo).toBe("2026-11-22T11:00:00.000Z");
      expect(meta2.timeEnvelope.validFrom).toBe("2026-11-22T11:00:00.000Z");
      expect(meta2.timeEnvelope.validTo).toBeNull();

      // Attempting to mutate an already-closed valid_to is also blocked by trigger
      expect(() =>
        db.run("UPDATE snapshots SET valid_to = '2026-11-22T12:00:00Z' WHERE version = 1"),
      ).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  // A database that has applied v1 or v2 holds that checksum in schema_migrations. Editing the SQL of an applied
  // migration would strand every such database, so a change must be a new migration, never an edit.
  it("freezes migrations v1 and v2: their SQL must never change", () => {
    const frozen: Record<number, string> = {
      1: "8fe3f2abe50340fcfd9578a5e5519422bbbcf4943737af500a9b8dc56e4336a2",
      2: "4f39dbe025dc2da815fb0f3442fa52c63cb2a5bd34e47258c2c992f05c4e8c46",
    };
    for (const [version, checksum] of Object.entries(frozen)) {
      const m = MIGRATIONS.find((x) => x.version === Number(version))!;
      expect(migrationChecksum(m), `migration v${version} was edited`).toBe(checksum);
    }
  });

  it("keeps job data through a migration that changes it (v4 backfills the input key, down drops it, up restores it)", async () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db, 3);
      expect(currentMigrationVersion(db)).toBe(3);
      const insertJob = (id: string, erp: string, lab: string | null) =>
        db.run(
          `INSERT INTO import_jobs (job_id, security_domain, idempotency_key, actor, state, stage, classification,
             retention_policy_pin, erp_sha256, lab_sha256, created_at, updated_at)
           VALUES (?, 'default', ?, 'ACT-01', 'committed', 'committed', 'restricted', 'RETENTION@1.0.0', ?, ?, ?, ?)`,
          id,
          `key-${id}`,
          erp,
          lab,
          "2026-11-22T10:00:00.000Z",
          "2026-11-22T10:00:00.000Z",
        );
      insertJob("J-ERP", "e".repeat(64), null);
      insertJob("J-BOTH", "a".repeat(64), "b".repeat(64));
      const jobs = () =>
        db.query<Record<string, unknown>>("SELECT job_id, idempotency_key, state, erp_sha256, lab_sha256, created_at FROM import_jobs ORDER BY job_id");
      const before = JSON.stringify(jobs());

      migrateUp(db);
      const keys = db.query<{ job_id: string; input_key: string }>("SELECT job_id, input_key FROM import_jobs ORDER BY job_id");
      expect(keys).toEqual([
        { job_id: "J-BOTH", input_key: `${"a".repeat(64)}:${"b".repeat(64)}:lab-assessment` },
        { job_id: "J-ERP", input_key: `${"e".repeat(64)}:-:erp-extract` },
      ]);
      expect(JSON.stringify(jobs())).toBe(before);

      migrateDown(db, 3);
      expect(() => db.query("SELECT input_key FROM import_jobs")).toThrow(/no such column/);
      expect(JSON.stringify(jobs())).toBe(before);

      migrateUp(db);
      expect(db.query("SELECT job_id, input_key FROM import_jobs ORDER BY job_id")).toEqual(keys);
    } finally {
      db.close();
    }
  });

  it("refuses to roll back over retained or legal-hold evidence, and allows it over expired, unheld rows or none", () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      new PolicyStore(db).activate(pack.policy.retention);
      const bytes = new TextEncoder().encode("held-evidence");
      // stored when the clock read 2000-01-01: the horizon ended in 2010, but the hold keeps it retained
      new SqlEvidenceStore(db, undefined, { now: () => "2000-01-01T00:00:00.000Z" }).put({
        evidenceId: "EV-HELD",
        issuer: "Lab",
        revision: "1",
        recordKind: "report",
        contentBytes: bytes,
        legalHold: true,
      });
      expect(() => migrateDown(db, 0)).toThrow(/evidence_store still holds 1 retained or legal-hold row/);
      expect(db.get("SELECT COUNT(*) AS n FROM evidence_store")).toEqual({ n: 1 });
      // released and past its horizon: nothing is retained any more, so the rollback may drop the table
      new SqlEvidenceStore(db).setLegalHold(sha(bytes), false);
      migrateDown(db, 0);
      expect(currentMigrationVersion(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("refuses every rollback that drops tables or their guard triggers while snapshots or evidence are still retained", async () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      new PolicyStore(db).activate(pack.policy.retention);
      const out = await new ImportJobRunner(db, pack).runImportJob({
        idempotencyKey: "retained-rollback",
        erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
        lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
        evidence: [{ evidenceId: "EV-R", issuer: "Lab", revision: "1", recordKind: "report", contentBytes: new TextEncoder().encode("retained") }],
      });
      expect(out.ok).toBe(true);
      const before = computeStoreChecksum(db);
      // v5 would drop the no-replace guards, v3 the evidence guards, v1 the tables: each is refused, nothing changes
      for (const target of [4, 2, 0]) {
        expect(() => migrateDown(db, target), `down to ${target}`).toThrow(/refused: .* still holds/);
        expect(computeStoreChecksum(db)).toBe(before);
      }
      expect(currentMigrationVersion(db)).toBe(MIGRATIONS.length);
      expect(() => db.run("INSERT OR REPLACE INTO evidence_store SELECT * FROM evidence_store")).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  it("refuses INSERT OR REPLACE, INSERT OR IGNORE and upserts over existing rows of every append-only table and of the retention policy", async () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      new PolicyStore(db).activate(pack.policy.retention);
      const out = await new ImportJobRunner(db, pack).runImportJob({
        idempotencyKey: "replace-guard",
        erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
        lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
        evidence: [{ evidenceId: "EV-G", issuer: "Lab", revision: "1", recordKind: "report", contentBytes: new TextEncoder().encode("guarded") }],
      });
      expect(out.ok).toBe(true);
      const before = computeStoreChecksum(db);
      const keyCols: Record<string, string> = {
        snapshots: "security_domain, model, batch, version",
        evidence_store: "security_domain, sha256",
        update_receipts: "receipt_id",
        execution_log: "seq",
        retention_policies: "policy_pin",
      };
      for (const table of Object.keys(keyCols)) {
        // each statement re-inserts the table's own first row, which collides on its key
        for (const verb of ["INSERT OR REPLACE", "INSERT OR IGNORE", "REPLACE", "INSERT OR ABORT"]) {
          expect(() => db.run(`${verb} INTO ${table} SELECT * FROM ${table} LIMIT 1`), `${verb} ${table}`).toThrow(/append-only|immutable|cannot be replaced/);
        }
        const cols = db.query<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
        const upsert = `INSERT INTO ${table} SELECT * FROM ${table} LIMIT 1 ON CONFLICT (${keyCols[table]}) DO UPDATE SET ${cols.find((c) => !keyCols[table]!.includes(c))} = excluded.${cols.find((c) => !keyCols[table]!.includes(c))}`;
        expect(() => db.run(upsert), `upsert ${table}`).toThrow(/append-only|immutable|cannot be replaced/);
      }
      // job events: the same, by sequence
      expect(() => db.run("INSERT OR REPLACE INTO job_events SELECT * FROM job_events LIMIT 1")).toThrow(/append-only/);
      // a retention policy cannot be rewritten or deleted with raw SQL, but its active flag can change
      expect(() => db.run("UPDATE retention_policies SET policy_json = '{}'")).toThrow(/immutable/);
      expect(() => db.run("DELETE FROM retention_policies")).toThrow(/cannot be deleted/);
      expect(() => db.run("UPDATE retention_policies SET active = 0")).not.toThrow();
      db.run("UPDATE retention_policies SET active = 1");
      expect(computeStoreChecksum(db)).toBe(before);
    } finally {
      db.close();
    }
  });
});
