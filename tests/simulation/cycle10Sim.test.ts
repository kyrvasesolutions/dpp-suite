/**
 * Layer 2 deterministic contract simulation for Cycle 10 (pre-coding gate).
 *
 * Calibrates Cycle 10 contracts:
 *   1. Backup retention floors, legal-hold protection, and RPO/RTO measurement.
 *   2. AES-256-GCM encrypted off-host backup round-trip and tamper rejection.
 *   3. FUNC-105 migration package reconciliation, no-revocation-replay, and no-evidence-overwrite.
 *   4. Structured fault-class alert evaluation with zero restricted values.
 *   5. Unrounded uncertainty-aware operator thresholds & standing registry hold (synthetic threshold).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

// ── 1. Backup retention & RPO/RTO contract simulation ──

type BackupTier = "15m" | "daily" | "monthly";
const TIER_HOURS: Record<BackupTier, number> = {
  "15m": 48,
  daily: 35 * 24,
  monthly: 365 * 24,
};

const RPO_MAX_SECONDS = 900; // 15 min
const RTO_MAX_SECONDS = 14400; // 4 hours

interface SimBackupManifest {
  backupId: string;
  tier: BackupTier;
  createdAt: string;
  retainUntil: string;
  hasLegalHold: boolean;
  storeChecksum: string;
  lastReceiptAt: string;
}

function computeBackupRetainUntil(createdAt: string, tier: BackupTier, activeRetentionFloorIso: string | null): string {
  const tierMs = Date.parse(createdAt) + TIER_HOURS[tier] * 3600_000;
  const floorMs = activeRetentionFloorIso ? Date.parse(activeRetentionFloorIso) : 0;
  return new Date(Math.max(tierMs, floorMs)).toISOString();
}

function canPruneBackup(m: SimBackupManifest, nowIso: string): boolean {
  if (m.hasLegalHold) return false;
  const retMs = Date.parse(m.retainUntil);
  if (!Number.isFinite(retMs)) return false;
  return Date.parse(nowIso) >= retMs;
}

function evaluateDrillTargets(opts: {
  lastReceiptAt: string;
  backupCreatedAt: string;
  rtoMs: number;
  checksumMatch: boolean;
  evidenceVerified: boolean;
}): { ok: boolean; rpoSeconds: number; rtoSeconds: number; reasons: string[] } {
  const rpoSeconds = Math.max(0, Math.round((Date.parse(opts.lastReceiptAt) - Date.parse(opts.backupCreatedAt)) / 1000));
  const rtoSeconds = opts.rtoMs / 1000;
  const reasons: string[] = [];
  if (rpoSeconds > RPO_MAX_SECONDS) reasons.push(`rpo-exceeded:${rpoSeconds}s`);
  if (rtoSeconds > RTO_MAX_SECONDS) reasons.push(`rto-exceeded:${rtoSeconds}s`);
  if (!opts.checksumMatch) reasons.push("checksum-mismatch");
  if (!opts.evidenceVerified) reasons.push("evidence-verification-failed");
  return { ok: reasons.length === 0, rpoSeconds, rtoSeconds, reasons };
}

// ── 2. AES-256-GCM off-host encryption simulation ──

function encryptOffHost(plaintext: Uint8Array, key: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { iv, ciphertext, authTag };
}

function decryptOffHost(enc: { iv: Buffer; ciphertext: Buffer; authTag: Buffer }, key: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, enc.iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(enc.authTag);
  return Buffer.concat([decipher.update(enc.ciphertext), decipher.final()]);
}

// ── 3. FUNC-105 Migration package simulation ──

interface SimGrantState {
  sub: string;
  roles: string[];
  active: boolean;
  grantEpoch: number;
}

interface SimStore {
  grants: Map<string, SimGrantState>;
  evidence: Map<string, string>;
  snapshots: Map<string, string>;
}

interface SimMigrationPkg {
  format: "dpp-migration-package@1.0.0";
  records: Array<{ key: string; digest: string }>;
  evidence: Array<{ sha256: string; content: string }>;
  includesGrants: false;
}

function replayMigration(store: SimStore, pkg: SimMigrationPkg): { ok: boolean; code?: string; added: number; skipped: number } {
  let added = 0;
  let skipped = 0;
  for (const ev of pkg.evidence) {
    const computed = createHash("sha256").update(ev.content).digest("hex");
    if (computed !== ev.sha256) return { ok: false, code: "evidence-digest-mismatch", added: 0, skipped: 0 };
    const existing = store.evidence.get(ev.sha256);
    if (existing !== undefined) {
      if (existing !== ev.content) return { ok: false, code: "evidence-overwrite-refused", added: 0, skipped: 0 };
      skipped++;
    } else {
      store.evidence.set(ev.sha256, ev.content);
      added++;
    }
  }
  for (const rec of pkg.records) {
    const existing = store.snapshots.get(rec.key);
    if (existing !== undefined) {
      if (existing !== rec.digest) return { ok: false, code: "snapshot-overwrite-refused", added: 0, skipped: 0 };
      skipped++;
    } else {
      store.snapshots.set(rec.key, rec.digest);
      added++;
    }
  }
  return { ok: true, added, skipped };
}

// ── 4. Fault-class alert evaluation simulation ──

const ALLOWED_ALERT_KEYS = new Set([
  "alertId",
  "faultClass",
  "severity",
  "state",
  "raisedAt",
  "count",
  "threshold",
  "serviceOwner",
  "runbookRef",
]);

function evaluateFaultAlerts(counters: {
  errors5xx: number;
  rateLimited: number;
  timeouts: number;
  egressBlocked: number;
  backupAgeSeconds: number;
  integrityFailures: number;
  rssMiB: number;
}) {
  const alerts: Array<Record<string, unknown>> = [];
  const push = (faultClass: string, severity: "warning" | "critical", count: number, threshold: number, runbookRef: string) => {
    alerts.push({
      alertId: `alert:${faultClass}`,
      faultClass,
      severity,
      state: "firing",
      raisedAt: "2026-11-27T11:30:00.000Z",
      count,
      threshold,
      serviceOwner: "platform-ops-owner",
      runbookRef,
    });
  };
  if (counters.errors5xx >= 1) push("server_error_burst", "critical", counters.errors5xx, 1, "operations-runbook#incident-server-errors");
  if (counters.rateLimited >= 5) push("rate_limit_saturation", "warning", counters.rateLimited, 5, "operations-runbook#incident-rate-limit");
  if (counters.timeouts >= 1) push("job_timeout_or_stall", "warning", counters.timeouts, 1, "operations-runbook#incident-job-timeout");
  if (counters.egressBlocked >= 1) push("egress_blocked_attempt", "critical", counters.egressBlocked, 1, "operations-runbook#incident-egress-blocked");
  if (counters.backupAgeSeconds > RPO_MAX_SECONDS) push("backup_overdue", "critical", counters.backupAgeSeconds, RPO_MAX_SECONDS, "operations-runbook#backup-and-restore");
  if (counters.integrityFailures >= 1) push("integrity_or_pack_failure", "critical", counters.integrityFailures, 1, "operations-runbook#incident-integrity");
  if (counters.rssMiB >= 400) push("memory_budget_pressure", "warning", counters.rssMiB, 400, "operations-runbook#incident-memory");
  return alerts;
}

// ── 5. Unrounded uncertainty-aware threshold simulation (synthetic threshold = 80) ──

function evaluateUnroundedUpperBound(measured: number, uncertainty: number, threshold: number): "BELOW_THRESHOLD" | "AT_OR_ABOVE_THRESHOLD" {
  const upperBound = measured + uncertainty;
  return upperBound < threshold ? "BELOW_THRESHOLD" : "AT_OR_ABOVE_THRESHOLD";
}

describe("Cycle 10 Layer 2 deterministic contract simulation", () => {
  it("enforces backup retention horizons, legal holds, and RPO/RTO drill bounds", () => {
    const created = "2026-11-27T10:00:00.000Z";
    const activeFloor = "2036-11-27T10:00:00.000Z";
    const retainUntil = computeBackupRetainUntil(created, "15m", activeFloor);
    expect(retainUntil).toBe(activeFloor);

    const held: SimBackupManifest = {
      backupId: "bk-1",
      tier: "15m",
      createdAt: created,
      retainUntil: "2026-11-29T10:00:00.000Z",
      hasLegalHold: true,
      storeChecksum: "a".repeat(64),
      lastReceiptAt: created,
    };
    expect(canPruneBackup(held, "2040-01-01T00:00:00.000Z")).toBe(false);

    const expiredUnheld: SimBackupManifest = { ...held, hasLegalHold: false };
    expect(canPruneBackup(expiredUnheld, "2026-11-28T00:00:00.000Z")).toBe(false);
    expect(canPruneBackup(expiredUnheld, "2026-11-29T10:00:00.000Z")).toBe(true);

    expect(
      evaluateDrillTargets({
        lastReceiptAt: "2026-11-27T10:12:00.000Z",
        backupCreatedAt: "2026-11-27T10:00:00.000Z",
        rtoMs: 2500,
        checksumMatch: true,
        evidenceVerified: true,
      }),
    ).toMatchObject({ ok: true, rpoSeconds: 720 });

    expect(
      evaluateDrillTargets({
        lastReceiptAt: "2026-11-27T10:16:00.000Z",
        backupCreatedAt: "2026-11-27T10:00:00.000Z",
        rtoMs: 2500,
        checksumMatch: true,
        evidenceVerified: true,
      }).ok,
    ).toBe(false);
  });

  it("authenticates AES-256-GCM off-host backups and rejects tampered ciphertext or wrong AAD", () => {
    const key = randomBytes(32);
    const payload = Buffer.from("synthetic-backup-bytes", "utf8");
    const aad = "bk-1|" + "a".repeat(64);
    const enc = encryptOffHost(payload, key, aad);
    expect(decryptOffHost(enc, key, aad).equals(payload)).toBe(true);

    const tampered = { ...enc, ciphertext: Buffer.from(enc.ciphertext) };
    tampered.ciphertext[0] ^= 0xff;
    expect(() => decryptOffHost(tampered, key, aad)).toThrow();
    expect(() => decryptOffHost(enc, key, "wrong-aad")).toThrow();
  });

  it("enforces FUNC-105 replay invariants: never restores revoked rights and never overwrites issued evidence", () => {
    const evContent = "synthetic-evidence-content";
    const evSha = createHash("sha256").update(evContent).digest("hex");
    const pkg: SimMigrationPkg = {
      format: "dpp-migration-package@1.0.0",
      records: [{ key: "M1|B1|1", digest: "d1" }],
      evidence: [{ sha256: evSha, content: evContent }],
      includesGrants: false,
    };

    const fresh: SimStore = {
      grants: new Map([["revoked-user", { sub: "revoked-user", roles: [], active: false, grantEpoch: 4 }]]),
      evidence: new Map(),
      snapshots: new Map(),
    };
    const first = replayMigration(fresh, pkg);
    expect(first).toEqual({ ok: true, added: 2, skipped: 0 });
    expect(fresh.grants.get("revoked-user")).toEqual({ sub: "revoked-user", roles: [], active: false, grantEpoch: 4 });

    expect(replayMigration(fresh, pkg)).toEqual({ ok: true, added: 0, skipped: 2 });

    const badSnap: SimMigrationPkg = { ...pkg, records: [{ key: "M1|B1|1", digest: "tampered" }] };
    expect(replayMigration(fresh, badSnap)).toMatchObject({ ok: false, code: "snapshot-overwrite-refused" });
  });

  it("raises value-free alerts across all 7 fault classes with strictly allowed schema keys", () => {
    const alerts = evaluateFaultAlerts({
      errors5xx: 2,
      rateLimited: 10,
      timeouts: 1,
      egressBlocked: 1,
      backupAgeSeconds: 1200,
      integrityFailures: 1,
      rssMiB: 450,
    });
    expect(alerts).toHaveLength(7);
    for (const a of alerts) {
      for (const k of Object.keys(a)) expect(ALLOWED_ALERT_KEYS.has(k)).toBe(true);
    }
  });

  it("evaluates unrounded uncertainty-aware thresholds cleanly without rounding-induced false passes", () => {
    const threshold = 80;
    expect(evaluateUnroundedUpperBound(31.4, 1.8, threshold)).toBe("BELOW_THRESHOLD");
    expect(evaluateUnroundedUpperBound(77.4, 2.5, threshold)).toBe("BELOW_THRESHOLD");
    expect(evaluateUnroundedUpperBound(77.5, 2.5, threshold)).toBe("AT_OR_ABOVE_THRESHOLD");
    expect(evaluateUnroundedUpperBound(77.49, 2.52, threshold)).toBe("AT_OR_ABOVE_THRESHOLD");
  });
});
