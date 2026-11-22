/**
 * Versioned forward (`up`) and backward (`down`) SQL migrations for the durable relational store
 * (ADR-0004; LEAN-DEF-05 / EV-5 schema with six distinct time fields, half-open validity interval,
 * and security-domain scoping).
 */
import { createHash } from "node:crypto";
import type { DbAdapter } from "./adapter";

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "0001_initial_p02",
    up: `
      CREATE TABLE IF NOT EXISTS retention_policies (
        policy_pin TEXT PRIMARY KEY,
        policy_json TEXT NOT NULL,
        loaded_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        security_domain TEXT NOT NULL,
        model TEXT NOT NULL,
        batch TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        supersedes_version INTEGER,
        supersedes_digest TEXT,
        record_digest TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        origin TEXT,
        classification TEXT NOT NULL CHECK (classification IN ('public', 'internal', 'restricted')),
        retention_policy_pin TEXT NOT NULL,
        retention_until TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        observed_at TEXT,
        declared_at TEXT,
        published_at TEXT,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (security_domain, model, batch, version),
        CHECK (valid_to IS NULL OR valid_to > valid_from)
      );

      CREATE TRIGGER IF NOT EXISTS trg_snapshots_no_delete
      BEFORE DELETE ON snapshots
      BEGIN
        SELECT RAISE(ABORT, 'snapshots are append-only and cannot be deleted');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_snapshots_immutable_content
      BEFORE UPDATE ON snapshots
      WHEN
        NEW.security_domain != OLD.security_domain OR
        NEW.model != OLD.model OR
        NEW.batch != OLD.batch OR
        NEW.version != OLD.version OR
        NEW.supersedes_version IS NOT OLD.supersedes_version OR
        NEW.supersedes_digest IS NOT OLD.supersedes_digest OR
        NEW.record_digest != OLD.record_digest OR
        NEW.snapshot_digest != OLD.snapshot_digest OR
        NEW.actor != OLD.actor OR
        NEW.reason != OLD.reason OR
        NEW.origin IS NOT OLD.origin OR
        NEW.classification != OLD.classification OR
        NEW.retention_policy_pin != OLD.retention_policy_pin OR
        NEW.retention_until != OLD.retention_until OR
        NEW.recorded_at != OLD.recorded_at OR
        NEW.observed_at IS NOT OLD.observed_at OR
        NEW.declared_at IS NOT OLD.declared_at OR
        NEW.published_at IS NOT OLD.published_at OR
        NEW.valid_from != OLD.valid_from OR
        NEW.payload_json != OLD.payload_json OR
        OLD.valid_to IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'snapshots are append-only; only closing an open valid_to interval is permitted');
      END;

      CREATE TABLE IF NOT EXISTS import_jobs (
        job_id TEXT PRIMARY KEY,
        security_domain TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        actor TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('running', 'committed', 'rolled_back', 'failed')),
        stage TEXT NOT NULL CHECK (stage IN ('received', 'classified', 'validated', 'staged', 'committed', 'rolled_back', 'failed')),
        classification TEXT NOT NULL CHECK (classification IN ('public', 'internal', 'restricted')),
        retention_policy_pin TEXT NOT NULL,
        erp_sha256 TEXT,
        lab_sha256 TEXT,
        model TEXT,
        batch TEXT,
        expected_version INTEGER,
        result_version INTEGER,
        result_snapshot_digest TEXT,
        staged_payload_json TEXT,
        error_code TEXT,
        error_stage TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        committed_at TEXT,
        UNIQUE (security_domain, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS job_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES import_jobs(job_id) ON DELETE CASCADE,
        security_domain TEXT NOT NULL,
        stage TEXT NOT NULL CHECK (stage IN ('received', 'classified', 'validated', 'staged', 'committed', 'rolled_back', 'failed')),
        outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'recovered', 'rolled_back')),
        code TEXT,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evidence_store (
        security_domain TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        issuer TEXT NOT NULL,
        revision TEXT NOT NULL,
        record_kind TEXT NOT NULL,
        dataset TEXT NOT NULL,
        classification TEXT NOT NULL CHECK (classification IN ('public', 'internal', 'restricted')),
        policy_pin TEXT NOT NULL,
        retention_days INTEGER NOT NULL CHECK (retention_days > 0),
        stored_at TEXT NOT NULL,
        retention_until TEXT NOT NULL,
        legal_hold INTEGER NOT NULL DEFAULT 0 CHECK (legal_hold IN (0, 1)),
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        media_type TEXT NOT NULL,
        content_blob BLOB NOT NULL,
        PRIMARY KEY (security_domain, sha256)
      );

      CREATE TABLE IF NOT EXISTS execution_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        security_domain TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        recorded_at TEXT NOT NULL,
        event TEXT NOT NULL,
        stage TEXT,
        code TEXT,
        route TEXT,
        rule_id TEXT,
        step_id TEXT,
        record_model_sha TEXT,
        record_batch_sha TEXT,
        version INTEGER,
        file_role TEXT,
        file_sha256 TEXT,
        outcome TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS update_receipts (
        receipt_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES import_jobs(job_id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        security_domain TEXT NOT NULL,
        model TEXT NOT NULL,
        batch TEXT NOT NULL,
        version INTEGER NOT NULL,
        record_digest TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        stored INTEGER NOT NULL CHECK (stored IN (0, 1)),
        classification TEXT NOT NULL CHECK (classification IN ('public', 'internal', 'restricted')),
        retention_until TEXT NOT NULL,
        policy_pin TEXT NOT NULL
      );
    `,
    down: `
      DROP TABLE IF EXISTS update_receipts;
      DROP TABLE IF EXISTS execution_log;
      DROP TABLE IF EXISTS evidence_store;
      DROP TABLE IF EXISTS job_events;
      DROP TABLE IF EXISTS import_jobs;
      DROP TRIGGER IF EXISTS trg_snapshots_immutable_content;
      DROP TRIGGER IF EXISTS trg_snapshots_no_delete;
      DROP TABLE IF EXISTS snapshots;
      DROP TABLE IF EXISTS retention_policies;
    `,
  },
  {
    version: 2,
    name: "0002_operational_indexes",
    up: `
      CREATE INDEX IF NOT EXISTS idx_snapshots_domain_model_batch
        ON snapshots (security_domain, model, batch, version);
      CREATE INDEX IF NOT EXISTS idx_snapshots_valid_window
        ON snapshots (security_domain, model, batch, valid_from, valid_to);
      CREATE INDEX IF NOT EXISTS idx_jobs_domain_state
        ON import_jobs (security_domain, state, updated_at);
      CREATE INDEX IF NOT EXISTS idx_job_events_job
        ON job_events (job_id, seq);
      CREATE INDEX IF NOT EXISTS idx_evidence_retention
        ON evidence_store (security_domain, retention_until, legal_hold);
      CREATE INDEX IF NOT EXISTS idx_log_domain_seq
        ON execution_log (security_domain, seq);
      CREATE INDEX IF NOT EXISTS idx_receipts_domain_record
        ON update_receipts (security_domain, model, batch, version);
    `,
    down: `
      DROP INDEX IF EXISTS idx_receipts_domain_record;
      DROP INDEX IF EXISTS idx_log_domain_seq;
      DROP INDEX IF EXISTS idx_evidence_retention;
      DROP INDEX IF EXISTS idx_job_events_job;
      DROP INDEX IF EXISTS idx_jobs_domain_state;
      DROP INDEX IF EXISTS idx_snapshots_valid_window;
      DROP INDEX IF EXISTS idx_snapshots_domain_model_batch;
    `,
  },
];

export function migrationChecksum(m: Migration): string {
  return createHash("sha256").update(`${m.version}|${m.name}|${m.up.trim()}|${m.down.trim()}`).digest("hex");
}

function ensureMigrationsTable(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function appliedMigrations(db: DbAdapter): AppliedMigration[] {
  ensureMigrationsTable(db);
  const rows = db.query<{ version: number; name: string; checksum: string; applied_at: string }>(
    "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC",
  );
  return rows.map((r) => ({
    version: Number(r.version),
    name: String(r.name),
    checksum: String(r.checksum),
    appliedAt: String(r.applied_at),
  }));
}

export function currentMigrationVersion(db: DbAdapter): number {
  const applied = appliedMigrations(db);
  return applied.length ? applied[applied.length - 1]!.version : 0;
}

/**
 * Applies all pending migrations up to `targetVersion` (default: latest), verifying checksums of
 * already-applied migrations so altered migration history fails loudly.
 */
export function migrateUp(db: DbAdapter, targetVersion: number = MIGRATIONS[MIGRATIONS.length - 1]!.version): AppliedMigration[] {
  ensureMigrationsTable(db);
  const existing = new Map(appliedMigrations(db).map((m) => [m.version, m]));

  for (const m of MIGRATIONS) {
    const expectedSum = migrationChecksum(m);
    const found = existing.get(m.version);
    if (found) {
      if (found.checksum !== expectedSum || found.name !== m.name) {
        throw new Error(`Migration v${m.version} (${m.name}) checksum mismatch: expected ${expectedSum}, database has ${found.checksum}`);
      }
      continue;
    }
    if (m.version > targetVersion) continue;
    db.transaction(() => {
      db.exec(m.up);
      db.run(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        m.version,
        m.name,
        expectedSum,
        new Date().toISOString(),
      );
    });
  }
  return appliedMigrations(db);
}

/**
 * Rolls back applied migrations down to `targetVersion` (inclusive: `targetVersion = 1` keeps v1 and rolls back v2;
 * `targetVersion = 0` rolls back all migrations).
 */
export function migrateDown(db: DbAdapter, targetVersion: number): AppliedMigration[] {
  ensureMigrationsTable(db);
  const applied = appliedMigrations(db).sort((a, b) => b.version - a.version);
  const byVersion = new Map(MIGRATIONS.map((m) => [m.version, m]));

  for (const row of applied) {
    if (row.version <= targetVersion) continue;
    const def = byVersion.get(row.version);
    if (!def) throw new Error(`Cannot roll back unknown migration version ${row.version}`);
    db.transaction(() => {
      db.exec(def.down);
      db.run("DELETE FROM schema_migrations WHERE version = ?", row.version);
    });
  }
  return appliedMigrations(db);
}

/**
 * Computes a deterministic SHA-256 checksum over all durable domain state (snapshots, evidence metadata+hashes,
 * receipts, and execution log rows) to verify zero data loss across forward/backward migrations and restore drills.
 */
export function computeStoreChecksum(db: DbAdapter): string {
  const hash = createHash("sha256");
  const snapshots = db.query<{
    security_domain: string;
    model: string;
    batch: string;
    version: number;
    record_digest: string;
    snapshot_digest: string;
    recorded_at: string;
    observed_at: string | null;
    declared_at: string | null;
    published_at: string | null;
    valid_from: string;
    valid_to: string | null;
  }>(
    `SELECT security_domain, model, batch, version, record_digest, snapshot_digest,
            recorded_at, observed_at, declared_at, published_at, valid_from, valid_to
     FROM snapshots
     ORDER BY security_domain, model, batch, version`,
  );
  hash.update(`snapshots:${JSON.stringify(snapshots)}\n`);

  const evidence = db.query<{
    security_domain: string;
    sha256: string;
    classification: string;
    retention_until: string;
    legal_hold: number;
    size_bytes: number;
  }>(
    `SELECT security_domain, sha256, classification, retention_until, legal_hold, size_bytes
     FROM evidence_store
     ORDER BY security_domain, sha256`,
  );
  hash.update(`evidence:${JSON.stringify(evidence)}\n`);

  const log = db.query<{
    seq: number;
    security_domain: string;
    event_id: string;
    event: string;
    outcome: string;
  }>(
    `SELECT seq, security_domain, event_id, event, outcome
     FROM execution_log
     ORDER BY seq`,
  );
  hash.update(`log:${JSON.stringify(log)}\n`);

  return hash.digest("hex");
}
