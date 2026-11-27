/**
 * Backup, encrypted off-host archival, retention-safe pruning, and timed restore drill manager.
 *
 * Uses SQLite `VACUUM INTO` via `DbAdapter.backup()` for hot consistent point-in-time snapshots,
 * verifies every evidence blob SHA-256 and byte length before sealing and after restoring,
 * authenticates off-host archives with AES-256-GCM bound to `backupId|storeChecksum`, and enforces
 * `config/egress-allowlist.json` + `decideEgress` on any remote off-host URL target.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decideEgress } from "../../src/model/c8Contracts";
import {
  BACKUP_TIER_RETENTION_HOURS,
  BackupManifestSchema,
  D9_06_TARGETS,
  OpsError,
  type BackupManifest,
  type BackupTier,
  type EncryptedOffHostMetadata,
  type RestoreDrillResult,
} from "../../src/model/c10Contracts";
import { canonical } from "../../src/model/canonical";
import { canonicalUtcIso, DEFAULT_SECURITY_DOMAIN } from "../../src/model/pContracts";
import { SqliteAdapter, type DbAdapter } from "../db/adapter";
import { appliedMigrations, computeStoreChecksum, MIGRATIONS, migrationChecksum } from "../db/migrations";
import { allowlistHosts } from "../security/egressGuard";

const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/;
const BACKUP_DB_FILENAME = "store.sqlite" as const;
const BACKUP_MANIFEST_FILENAME = "manifest.json" as const;

function sha256Buffer(buf: Uint8Array | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function manifestDigestOf(body: Omit<BackupManifest, "manifestDigest">): string {
  return sha256Buffer(canonical(body));
}

function parseAes256Key(keyHex: string): Buffer {
  const trimmed = keyHex.trim();
  if (!HEX_KEY_RE.test(trimmed)) {
    throw new OpsError("backup-invalid", 400, "Off-host encryption key must be a 64-character hex-encoded 256-bit key");
  }
  return Buffer.from(trimmed, "hex");
}

function expectedAadFor(backupId: string, storeChecksum: string): string {
  return `${backupId}|${storeChecksum}`;
}

/**
 * Validates an optional remote off-host backup target URL against `config/egress-allowlist.json`
 * and `decideEgress`. Rejects embedded credentials, non-HTTPS remote origins, mismatched ports,
 * link-local/unspecified addresses, and any origin not explicitly listed in `allowlistConnect`.
 */
export function validateOffHostTargetUrl(targetUrl: string, allowlistConnect: readonly string[]): { allowed: true; origin: string } {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new OpsError("egress-target-refused", 400, "Off-host backup target URL is malformed");
  }
  if (parsed.username || parsed.password) {
    throw new OpsError("egress-target-refused", 403, "Off-host backup target URL must not contain embedded credentials");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new OpsError("egress-target-refused", 403, "Off-host backup URL protocol is refused");
  }
  const strippedHost = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const hosts = allowlistHosts(allowlistConnect);
  if (decideEgress(strippedHost, hosts) !== "allow") {
    throw new OpsError(
      "egress-target-refused",
      403,
      "Off-host backup target is outside the declared egress allow-list; record a dated owner decision before enabling remote backup egress",
    );
  }
  if (decideEgress(strippedHost, []) === "allow") {
    return { allowed: true, origin: parsed.origin };
  }
  if (parsed.protocol !== "https:") {
    throw new OpsError("egress-target-refused", 403, "Remote off-host backup target must use HTTPS");
  }
  const normalizedAllowedOrigins = new Set(
    allowlistConnect
      .map((entry) => {
        try {
          return new URL(entry).origin.toLowerCase();
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  );
  if (!normalizedAllowedOrigins.has(parsed.origin.toLowerCase())) {
    throw new OpsError(
      "egress-target-refused",
      403,
      "Off-host backup target origin (scheme/host/port) does not match any entry in the declared egress allow-list",
    );
  }
  return { allowed: true, origin: parsed.origin };
}

export interface VerifiedEvidenceEntry {
  securityDomain: string;
  sha256: string;
  sizeBytes: number;
  legalHold: boolean;
  retentionUntil: string;
}

/** Verifies every evidence blob in `evidence_store` matches both its recorded SHA-256 digest and byte length. */
export function verifyAllEvidenceBlobs(db: DbAdapter, securityDomain?: string): VerifiedEvidenceEntry[] {
  const sql = securityDomain
    ? `SELECT security_domain, sha256, size_bytes, legal_hold, retention_until, content_blob
       FROM evidence_store WHERE security_domain = ? ORDER BY security_domain ASC, sha256 ASC`
    : `SELECT security_domain, sha256, size_bytes, legal_hold, retention_until, content_blob
       FROM evidence_store ORDER BY security_domain ASC, sha256 ASC`;
  const rows = securityDomain
    ? db.query<{
        security_domain: string;
        sha256: string;
        size_bytes: number;
        legal_hold: number;
        retention_until: string;
        content_blob: Uint8Array;
      }>(sql, securityDomain)
    : db.query<{
        security_domain: string;
        sha256: string;
        size_bytes: number;
        legal_hold: number;
        retention_until: string;
        content_blob: Uint8Array;
      }>(sql);

  const out: VerifiedEvidenceEntry[] = [];
  for (const r of rows) {
    const bytes = new Uint8Array(r.content_blob);
    const actual = sha256Buffer(bytes);
    if (actual !== r.sha256 || bytes.byteLength !== Number(r.size_bytes)) {
      throw new OpsError("restore-evidence-mismatch", 500, "Evidence integrity verification failed");
    }
    out.push({
      securityDomain: String(r.security_domain),
      sha256: r.sha256,
      sizeBytes: Number(r.size_bytes),
      legalHold: Number(r.legal_hold) === 1,
      retentionUntil: String(r.retention_until),
    });
  }
  return out;
}

/** Read-only verification that all applied migration checksums in `db` match the frozen migration registry. */
function verifyAppliedMigrationChecksumsReadOnly(db: DbAdapter): number {
  const applied = appliedMigrations(db);
  const byVersion = new Map(MIGRATIONS.map((m) => [m.version, m]));
  for (const row of applied) {
    const def = byVersion.get(row.version);
    if (!def) {
      throw new OpsError("backup-tampered", 422, "Restored database contains an unknown migration version");
    }
    if (row.name !== def.name || row.checksum !== migrationChecksum(def)) {
      throw new OpsError("backup-tampered", 422, "Restored database migration checksum mismatch");
    }
  }
  return applied.length ? applied[applied.length - 1]!.version : 0;
}

export interface CreateBackupOptions {
  destDir: string;
  tier?: BackupTier;
  securityDomain?: string;
  recordedBy?: string;
  nowIso?: string;
  /** Optional encrypted off-host archive output file path + key (never stored in manifest/logs). */
  offHostEncrypt?: {
    outPath: string;
    keyHex: string;
    keyId: string;
    targetLabel?: string;
  };
  /** Optional remote target URL checked against egress allow-list. */
  offHostTargetUrl?: string;
  egressAllowlistConnect?: readonly string[];
  /** Persist backup record to append-only `backup_records` table (default true when v9 table exists). */
  recordAudit?: boolean;
}

export interface CreatedBackup {
  backupDir: string;
  dbPath: string;
  manifestPath: string;
  manifest: BackupManifest;
  encryptedArchivePath?: string;
}

/**
 * Creates a hot consistent point-in-time backup using SQLite `VACUUM INTO`, verifies every evidence
 * blob SHA-256 and byte length, computes `computeStoreChecksum`, enforces retention floors across
 * evidence/snapshots/receipts, and optionally writes an AES-256-GCM authenticated encrypted off-host archive.
 */
export function createBackup(db: DbAdapter, options: CreateBackupOptions): CreatedBackup {
  if (options.offHostTargetUrl) {
    validateOffHostTargetUrl(options.offHostTargetUrl, options.egressAllowlistConnect ?? []);
  }

  const tier: BackupTier = options.tier ?? "15m";
  const domain = options.securityDomain?.trim() || DEFAULT_SECURITY_DOMAIN;
  let createdAt: string;
  try {
    createdAt = canonicalUtcIso(options.nowIso ?? new Date().toISOString());
  } catch {
    throw new OpsError("backup-invalid", 400, "Invalid backup timestamp");
  }
  const createdMs = Date.parse(createdAt);

  const backupId = `BK-${createdAt.replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const backupDir = resolve(options.destDir, backupId);
  mkdirSync(backupDir, { recursive: true });

  const dbPath = join(backupDir, BACKUP_DB_FILENAME);
  if (existsSync(dbPath)) {
    rmSync(dbPath, { force: true });
  }
  // Hot consistent point-in-time snapshot via VACUUM INTO (safe while WAL writers are active)
  db.backup(dbPath);

  const snapDb = new SqliteAdapter({ path: dbPath });
  let schemaVersion = 0;
  let storeChecksum = "";
  let evidenceDigests: VerifiedEvidenceEntry[] = [];
  let lastReceiptId: string | null = null;
  let lastReceiptRecordedAt: string | null = null;
  let maxRetentionUntilMs = 0;
  let hasLegalHold = false;

  try {
    schemaVersion = verifyAppliedMigrationChecksumsReadOnly(snapDb);
    storeChecksum = computeStoreChecksum(snapDb);
    evidenceDigests = verifyAllEvidenceBlobs(snapDb);
    for (const ev of evidenceDigests) {
      if (ev.legalHold) hasLegalHold = true;
      const ms = Date.parse(ev.retentionUntil);
      if (Number.isFinite(ms) && ms > maxRetentionUntilMs) maxRetentionUntilMs = ms;
    }
    for (const table of ["snapshots", "update_receipts"] as const) {
      const maxRow = snapDb.get<{ max_ret: string | null }>(`SELECT MAX(retention_until) AS max_ret FROM ${table}`);
      if (maxRow?.max_ret) {
        const ms = Date.parse(maxRow.max_ret);
        if (Number.isFinite(ms) && ms > maxRetentionUntilMs) maxRetentionUntilMs = ms;
      }
    }
    const lastReceipt = snapDb.get<{ receipt_id: string; recorded_at: string }>(
      "SELECT receipt_id, recorded_at FROM update_receipts ORDER BY recorded_at DESC, receipt_id DESC LIMIT 1",
    );
    if (lastReceipt) {
      lastReceiptId = String(lastReceipt.receipt_id);
      lastReceiptRecordedAt = canonicalUtcIso(String(lastReceipt.recorded_at));
    }
  } finally {
    snapDb.close();
  }

  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });

  const dbBytes = readFileSync(dbPath);
  const dbFileSha256 = sha256Buffer(dbBytes);
  const dbSizeBytes = dbBytes.byteLength;

  // retainUntil = max(tierHorizon, maxActiveRetentionUntil across evidence, snapshots, and update_receipts)
  const tierHorizonMs = createdMs + BACKUP_TIER_RETENTION_HOURS[tier] * 3600_000;
  const retainUntil = new Date(Math.max(tierHorizonMs, maxRetentionUntilMs)).toISOString();

  let encryptedOffHost: EncryptedOffHostMetadata | undefined;
  let encryptedArchivePath: string | undefined;

  if (options.offHostEncrypt) {
    encryptedArchivePath = resolve(options.offHostEncrypt.outPath);
    encryptedOffHost = createEncryptedOffHostCopy(dbPath, encryptedArchivePath, {
      backupId,
      storeChecksum,
      keyHex: options.offHostEncrypt.keyHex,
      keyId: options.offHostEncrypt.keyId,
      targetLabel: options.offHostEncrypt.targetLabel ?? "offhost-encrypted-volume",
    });
  }

  const body: Omit<BackupManifest, "manifestDigest"> = {
    format: "dpp-backup-manifest@1.0.0",
    backupId,
    createdAt,
    securityDomain: domain,
    schemaVersion,
    storeChecksum,
    tier,
    retainUntil,
    hasLegalHold,
    rpoTargetSeconds: D9_06_TARGETS.rpoMaxSeconds,
    rtoTargetSeconds: D9_06_TARGETS.rtoMaxSeconds,
    lastReceiptId,
    lastReceiptRecordedAt,
    dbFileName: BACKUP_DB_FILENAME,
    dbFileSha256,
    dbSizeBytes,
    evidenceCount: evidenceDigests.length,
    evidenceDigests,
    ...(encryptedOffHost ? { encryptedOffHost } : {}),
  };

  const manifest: BackupManifest = {
    ...body,
    manifestDigest: manifestDigestOf(body),
  };

  const manifestPath = join(backupDir, BACKUP_MANIFEST_FILENAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if (options.recordAudit !== false) {
    const hasTable = db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backup_records'");
    if (hasTable) {
      db.run(
        `INSERT INTO backup_records (
          backup_id, security_domain, tier, created_at, retain_until, has_legal_hold,
          schema_version, store_checksum, manifest_digest, evidence_count, encrypted_offhost, recorded_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        manifest.backupId,
        manifest.securityDomain,
        manifest.tier,
        manifest.createdAt,
        manifest.retainUntil,
        manifest.hasLegalHold ? 1 : 0,
        manifest.schemaVersion,
        manifest.storeChecksum,
        manifest.manifestDigest,
        manifest.evidenceCount,
        manifest.encryptedOffHost ? 1 : 0,
        options.recordedBy ?? "ACT-19",
      );
    }
  }

  return { backupDir, dbPath, manifestPath, manifest, encryptedArchivePath };
}

/**
 * Encrypts a backup database file into an authenticated AES-256-GCM archive.
 * Binary layout: `[magic "DPPBK1" (6B)][iv (12B)][authTag (16B)][ciphertext (...)]`.
 * AAD binds `backupId|storeChecksum` so swapping manifests or ciphertexts fails decryption.
 */
export function createEncryptedOffHostCopy(
  dbFilePath: string,
  outPath: string,
  opts: { backupId: string; storeChecksum: string; keyHex: string; keyId: string; targetLabel: string },
): EncryptedOffHostMetadata {
  const key = parseAes256Key(opts.keyHex);
  const plaintext = readFileSync(dbFilePath);
  const iv = randomBytes(12);
  const aad = expectedAadFor(opts.backupId, opts.storeChecksum);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const magic = Buffer.from("DPPBK1", "ascii");
  const archive = Buffer.concat([magic, iv, authTag, ciphertext]);
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, archive);

  return {
    algorithm: "aes-256-gcm",
    keyId: opts.keyId,
    ivHex: iv.toString("hex"),
    authTagHex: authTag.toString("hex"),
    ciphertextSha256: sha256Buffer(archive),
    ciphertextBytes: archive.byteLength,
    aad,
    targetLabel: opts.targetLabel,
  };
}

/** Decrypts and authenticates an AES-256-GCM off-host backup archive back to a SQLite DB file. */
export function decryptOffHostCopy(
  archivePath: string,
  manifest: BackupManifest,
  destDbPath: string,
  keyHex: string,
): void {
  if (!manifest.encryptedOffHost) {
    throw new OpsError("backup-invalid", 400, "Backup manifest has no encrypted off-host metadata");
  }
  const expectedAad = expectedAadFor(manifest.backupId, manifest.storeChecksum);
  if (manifest.encryptedOffHost.aad !== expectedAad) {
    throw new OpsError("backup-tampered", 422, "Encrypted off-host AAD does not match backupId|storeChecksum");
  }
  const key = parseAes256Key(keyHex);
  const archive = readFileSync(archivePath);
  const actualSha = sha256Buffer(archive);
  if (actualSha !== manifest.encryptedOffHost.ciphertextSha256) {
    throw new OpsError("backup-tampered", 422, "Encrypted off-host archive SHA-256 does not match manifest");
  }
  if (archive.byteLength < 6 + 12 + 16 || archive.subarray(0, 6).toString("ascii") !== "DPPBK1") {
    throw new OpsError("backup-tampered", 422, "Encrypted off-host archive header is invalid");
  }
  const iv = archive.subarray(6, 18);
  const authTag = archive.subarray(18, 34);
  const ciphertext = archive.subarray(34);
  if (iv.toString("hex") !== manifest.encryptedOffHost.ivHex || authTag.toString("hex") !== manifest.encryptedOffHost.authTagHex) {
    throw new OpsError("backup-tampered", 422, "Encrypted off-host archive IV/authTag does not match manifest");
  }

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(expectedAad, "utf8"));
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new OpsError("backup-tampered", 422, "Encrypted off-host archive failed AES-256-GCM authentication (wrong key or tampered data)");
  }

  if (sha256Buffer(plaintext) !== manifest.dbFileSha256) {
    throw new OpsError("backup-tampered", 422, "Decrypted backup database SHA-256 does not match manifest");
  }
  mkdirSync(resolve(destDbPath, ".."), { recursive: true });
  writeFileSync(destDbPath, plaintext);
}

/** Verifies a backup directory's manifest schema, canonical digest, AAD binding, and database file SHA-256. */
export function verifyBackup(backupDir: string, options: { requireDbFile?: boolean } = {}): BackupManifest {
  const manifestPath = join(backupDir, BACKUP_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new OpsError("backup-invalid", 400, "Backup manifest.json is missing");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new OpsError("backup-invalid", 400, "Backup manifest.json is not valid JSON");
  }
  const parsed = BackupManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OpsError("backup-invalid", 400, "Backup manifest schema is invalid");
  }
  const manifest = parsed.data;
  const { manifestDigest, ...body } = manifest;
  if (manifestDigestOf(body) !== manifestDigest) {
    throw new OpsError("backup-tampered", 422, "Backup manifest digest mismatch");
  }
  if (manifest.encryptedOffHost && manifest.encryptedOffHost.aad !== expectedAadFor(manifest.backupId, manifest.storeChecksum)) {
    throw new OpsError("backup-tampered", 422, "Backup manifest encryptedOffHost AAD does not match backupId|storeChecksum");
  }
  if (manifest.evidenceDigests.length !== manifest.evidenceCount) {
    throw new OpsError("backup-tampered", 422, "Backup manifest evidenceCount disagrees with evidenceDigests");
  }
  if (options.requireDbFile !== false) {
    const dbPath = join(backupDir, BACKUP_DB_FILENAME);
    if (!existsSync(dbPath)) {
      throw new OpsError("backup-invalid", 400, "Backup SQLite database file is missing");
    }
    const actualDbSha = sha256Buffer(readFileSync(dbPath));
    if (actualDbSha !== manifest.dbFileSha256) {
      throw new OpsError("backup-tampered", 422, "Backup SQLite database SHA-256 does not match manifest");
    }
  }
  return manifest;
}

export interface RestoreBackupOptions {
  backupDir: string;
  targetDbPath: string;
  /** Optional encrypted archive + key to restore from an off-host encrypted copy instead of plaintext DB file. */
  fromEncryptedArchive?: {
    archivePath: string;
    keyHex: string;
  };
  /** Optional timestamp of the last committed receipt before the simulated incident, for RPO measurement. */
  incidentLastReceiptAt?: string | null;
  nowIso?: string;
}

function cleanupTargetDb(targetDbPath: string): void {
  rmSync(targetDbPath, { force: true });
  rmSync(`${targetDbPath}-wal`, { force: true });
  rmSync(`${targetDbPath}-shm`, { force: true });
}

/**
 * Restores a backup into a clean target SQLite path, verifies migration checksums read-only
 * (never mutating the restored DB), checks exact schema version equality, compares `computeStoreChecksum`,
 * re-verifies every evidence blob (domain, SHA-256, byte length, legalHold, retentionUntil), cleans up
 * the target path on any failure, and reports timed RPO/RTO compliance against owner-set targets.
 */
export function restoreBackup(options: RestoreBackupOptions): RestoreDrillResult {
  const startedAtMs = performance.now();
  const targetDbPath = resolve(options.targetDbPath);
  if (existsSync(targetDbPath)) {
    throw new OpsError(
      "backup-invalid",
      409,
      "Refusing to overwrite an existing database path during restore; restore into a clean target path first",
    );
  }

  const manifest = verifyBackup(options.backupDir, { requireDbFile: !options.fromEncryptedArchive });
  mkdirSync(resolve(targetDbPath, ".."), { recursive: true });

  let restoredChecksum = "";
  let evidenceChecked = 0;
  let evidenceVerified = false;
  let schemaVersion = 0;
  const reasons: string[] = [];

  try {
    if (options.fromEncryptedArchive) {
      decryptOffHostCopy(options.fromEncryptedArchive.archivePath, manifest, targetDbPath, options.fromEncryptedArchive.keyHex);
    } else {
      const srcDbPath = join(options.backupDir, BACKUP_DB_FILENAME);
      copyFileSync(srcDbPath, targetDbPath);
    }

    const restoredDb = new SqliteAdapter({ path: targetDbPath });
    try {
      // Read-only verification: never mutate the restored database forward during restore verification.
      schemaVersion = verifyAppliedMigrationChecksumsReadOnly(restoredDb);
      if (schemaVersion !== manifest.schemaVersion) {
        reasons.push("schema-version-mismatch");
      }
      restoredChecksum = computeStoreChecksum(restoredDb);
      if (restoredChecksum !== manifest.storeChecksum) {
        reasons.push("store-checksum-mismatch");
      }

      const blobs = verifyAllEvidenceBlobs(restoredDb);
      evidenceChecked = blobs.length;
      const entryKey = (e: VerifiedEvidenceEntry) =>
        `${e.securityDomain}|${e.sha256}|${e.sizeBytes}|${e.legalHold ? 1 : 0}|${e.retentionUntil}`;
      const expectedKeys = manifest.evidenceDigests.map(entryKey).sort();
      const actualKeys = blobs.map(entryKey).sort();
      evidenceVerified =
        blobs.length === manifest.evidenceCount &&
        expectedKeys.length === actualKeys.length &&
        expectedKeys.every((k, idx) => k === actualKeys[idx]);
      if (!evidenceVerified) {
        reasons.push("evidence-set-mismatch");
      }
    } finally {
      restoredDb.close();
    }
  } catch (err) {
    cleanupTargetDb(targetDbPath);
    throw err;
  }

  const rtoMs = Math.round(performance.now() - startedAtMs);
  const referenceLastReceipt = options.incidentLastReceiptAt ?? manifest.lastReceiptRecordedAt ?? manifest.createdAt;
  const rpoSeconds = Math.max(0, Math.round((Date.parse(referenceLastReceipt) - Date.parse(manifest.createdAt)) / 1000));
  // Cap targets by hardcoded D9_06_TARGETS so a tampered manifest can never relax RPO/RTO checks.
  const effectiveRpoTarget = Math.min(manifest.rpoTargetSeconds, D9_06_TARGETS.rpoMaxSeconds);
  const effectiveRtoTarget = Math.min(manifest.rtoTargetSeconds, D9_06_TARGETS.rtoMaxSeconds);
  const rpoWithinTarget = Number.isFinite(rpoSeconds) && rpoSeconds <= effectiveRpoTarget;
  const rtoWithinTarget = rtoMs <= effectiveRtoTarget * 1000;
  if (!rpoWithinTarget) reasons.push(`rpo-exceeded:${rpoSeconds}s`);
  if (!rtoWithinTarget) reasons.push(`rto-exceeded:${Math.ceil(rtoMs / 1000)}s`);

  const checksumMatch = restoredChecksum === manifest.storeChecksum;
  const passed = reasons.length === 0 && checksumMatch && evidenceVerified && rpoWithinTarget && rtoWithinTarget;
  if (!passed) {
    cleanupTargetDb(targetDbPath);
  }

  return {
    backupId: manifest.backupId,
    restoredAt: options.nowIso ?? new Date().toISOString(),
    rpoSeconds,
    rtoMs,
    rpoTargetSeconds: effectiveRpoTarget,
    rtoTargetSeconds: effectiveRtoTarget,
    rpoWithinTarget,
    rtoWithinTarget,
    expectedChecksum: manifest.storeChecksum,
    restoredChecksum,
    checksumMatch,
    evidenceChecked,
    evidenceVerified,
    schemaVersion,
    passed,
    reasons,
  };
}

/**
 * Enforces backup retention pruning (fail closed): deletes only backups whose effective retention
 * horizon `max(retainUntil, createdAt + tierHours, ...evidenceDigests.retentionUntil)` has passed
 * AND neither `hasLegalHold` nor any evidence entry carries a legal hold.
 */
export function pruneExpiredBackups(
  backupRoot: string,
  nowIso: string = new Date().toISOString(),
): { deleted: string[]; retained: Array<{ backupId: string; reason: "legal-hold" | "within-retention" }> } {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) throw new OpsError("backup-invalid", 400, "Invalid prune timestamp");
  if (!existsSync(backupRoot)) return { deleted: [], retained: [] };

  const deleted: string[] = [];
  const retained: Array<{ backupId: string; reason: "legal-hold" | "within-retention" }> = [];

  for (const entry of readdirSync(backupRoot).sort()) {
    const dir = join(backupRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    if (!existsSync(join(dir, BACKUP_MANIFEST_FILENAME))) continue;
    const manifest = verifyBackup(dir, { requireDbFile: false });
    if (manifest.hasLegalHold || manifest.evidenceDigests.some((e) => e.legalHold)) {
      retained.push({ backupId: manifest.backupId, reason: "legal-hold" });
      continue;
    }
    const createdMs = Date.parse(manifest.createdAt);
    const retainUntilMs = Date.parse(manifest.retainUntil);
    if (!Number.isFinite(createdMs) || !Number.isFinite(retainUntilMs)) {
      retained.push({ backupId: manifest.backupId, reason: "within-retention" });
      continue;
    }
    let effectiveRetainMs = Math.max(retainUntilMs, createdMs + BACKUP_TIER_RETENTION_HOURS[manifest.tier] * 3600_000);
    for (const ev of manifest.evidenceDigests) {
      const evMs = Date.parse(ev.retentionUntil);
      if (!Number.isFinite(evMs)) {
        effectiveRetainMs = Number.POSITIVE_INFINITY;
        break;
      }
      if (evMs > effectiveRetainMs) effectiveRetainMs = evMs;
    }
    if (nowMs < effectiveRetainMs) {
      retained.push({ backupId: manifest.backupId, reason: "within-retention" });
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
    deleted.push(manifest.backupId);
  }
  return { deleted, retained };
}

export interface StoredBackupAuditRow {
  backupId: string;
  securityDomain: string;
  tier: BackupTier;
  createdAt: string;
  retainUntil: string;
  hasLegalHold: boolean;
  schemaVersion: number;
  storeChecksum: string;
  manifestDigest: string;
  evidenceCount: number;
  encryptedOffHost: boolean;
  recordedBy: string;
}

export function listBackupRecords(db: DbAdapter, securityDomain?: string): StoredBackupAuditRow[] {
  const hasTable = db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backup_records'");
  if (!hasTable) return [];
  const sql = securityDomain
    ? `SELECT backup_id, security_domain, tier, created_at, retain_until, has_legal_hold,
              schema_version, store_checksum, manifest_digest, evidence_count, encrypted_offhost, recorded_by
       FROM backup_records WHERE security_domain = ? ORDER BY created_at DESC`
    : `SELECT backup_id, security_domain, tier, created_at, retain_until, has_legal_hold,
              schema_version, store_checksum, manifest_digest, evidence_count, encrypted_offhost, recorded_by
       FROM backup_records ORDER BY created_at DESC`;
  const rows = securityDomain
    ? db.query<Record<string, unknown>>(sql, securityDomain)
    : db.query<Record<string, unknown>>(sql);
  return rows.map((r) => ({
    backupId: String(r.backup_id),
    securityDomain: String(r.security_domain),
    tier: r.tier as BackupTier,
    createdAt: String(r.created_at),
    retainUntil: String(r.retain_until),
    hasLegalHold: Number(r.has_legal_hold) === 1,
    schemaVersion: Number(r.schema_version),
    storeChecksum: String(r.store_checksum),
    manifestDigest: String(r.manifest_digest),
    evidenceCount: Number(r.evidence_count),
    encryptedOffHost: Number(r.encrypted_offhost) === 1,
    recordedBy: String(r.recorded_by),
  }));
}
