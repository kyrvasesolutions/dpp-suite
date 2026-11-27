/**
 * Typed domain contracts for Cycle 10 (operations, backup/restore, migration, alerts, content checks):
 *   - Backup, restore drill, retention floors, and encrypted off-host archival
 *   - Portable migration & customer exit package (`FUNC-105`)
 *   - Value-free structured fault-class monitoring alerts (`FUNC-132`)
 *   - Production content acceptance & standing registry hold verification
 *
 * Pure TypeScript + Zod only (zero DOM, zero Node built-ins) so browser and server share one contract set.
 */
import { z } from "zod";
import { CLASSIFICATIONS } from "./classification";

// ── 1. Backup & Restore Contracts ──

export const BACKUP_TIERS = ["15m", "daily", "monthly"] as const;
export type BackupTier = (typeof BACKUP_TIERS)[number];

/** Minimum retention durations in hours (15m: 48h, daily: 35d, monthly: 12m). */
export const BACKUP_TIER_RETENTION_HOURS: Record<BackupTier, number> = {
  "15m": 48,
  daily: 35 * 24,
  monthly: 365 * 24,
};

/** Owner-set recovery and availability targets for the bounded service. */
export const D9_06_TARGETS = {
  rpoMaxSeconds: 15 * 60, // 900 s (15 minutes)
  rtoMaxSeconds: 4 * 3600, // 14,400 s (4 hours)
  availabilityPercent: 99.5,
  serviceHours: "Mon-Fri 07:00-19:00 Europe/Berlin",
  announcedMaintenanceMaxHoursPerMonth: 4,
} as const;

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export const BackupEvidenceEntrySchema = z
  .object({
    securityDomain: z.string().min(1).max(64),
    sha256: z.string().regex(SHA256_RE),
    sizeBytes: z.number().int().nonnegative(),
    legalHold: z.boolean(),
    retentionUntil: z.string().regex(ISO_UTC_RE),
  })
  .strict();

export const EncryptedOffHostMetadataSchema = z
  .object({
    algorithm: z.literal("aes-256-gcm"),
    keyId: z.string().min(1).max(128),
    ivHex: z.string().regex(/^[0-9a-f]{24}$/),
    authTagHex: z.string().regex(/^[0-9a-f]{32}$/),
    ciphertextSha256: z.string().regex(SHA256_RE),
    ciphertextBytes: z.number().int().positive(),
    aad: z.string().min(1),
    targetLabel: z.string().min(1).max(128),
  })
  .strict();

export type EncryptedOffHostMetadata = z.infer<typeof EncryptedOffHostMetadataSchema>;

export const BackupManifestSchema = z
  .object({
    format: z.literal("dpp-backup-manifest@1.0.0"),
    backupId: z.string().regex(/^BK-\d{8}T\d{6}-[0-9a-f]{8}$/),
    createdAt: z.string().regex(ISO_UTC_RE),
    securityDomain: z.string().min(1).max(64),
    schemaVersion: z.number().int().positive(),
    storeChecksum: z.string().regex(SHA256_RE),
    tier: z.enum(BACKUP_TIERS),
    retainUntil: z.string().regex(ISO_UTC_RE),
    hasLegalHold: z.boolean(),
    rpoTargetSeconds: z.number().int().positive().max(D9_06_TARGETS.rpoMaxSeconds),
    rtoTargetSeconds: z.number().int().positive().max(D9_06_TARGETS.rtoMaxSeconds),
    lastReceiptId: z.string().nullable(),
    lastReceiptRecordedAt: z.string().regex(ISO_UTC_RE).nullable(),
    dbFileName: z.literal("store.sqlite"),
    dbFileSha256: z.string().regex(SHA256_RE),
    dbSizeBytes: z.number().int().positive(),
    evidenceCount: z.number().int().nonnegative(),
    evidenceDigests: z.array(BackupEvidenceEntrySchema),
    encryptedOffHost: EncryptedOffHostMetadataSchema.optional(),
    manifestDigest: z.string().regex(SHA256_RE),
  })
  .strict();

export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export interface RestoreDrillResult {
  backupId: string;
  restoredAt: string;
  rpoSeconds: number;
  rtoMs: number;
  rpoTargetSeconds: number;
  rtoTargetSeconds: number;
  rpoWithinTarget: boolean;
  rtoWithinTarget: boolean;
  expectedChecksum: string;
  restoredChecksum: string;
  checksumMatch: boolean;
  evidenceChecked: number;
  evidenceVerified: boolean;
  schemaVersion: number;
  passed: boolean;
  reasons: string[];
}

// ── 2. Portable Migration & Customer Exit Package (FUNC-105) ──

export const MIGRATION_PACKAGE_FORMAT = "dpp-migration-package@1.0.0" as const;

export const MigrationEvidenceItemSchema = z
  .object({
    sha256: z.string().regex(SHA256_RE),
    securityDomain: z.string().min(1).max(64),
    evidenceId: z.string().min(1).max(128),
    issuer: z.string().min(1).max(200),
    revision: z.string().min(1).max(128),
    recordKind: z.string().min(1).max(128),
    dataset: z.string().min(1).max(128),
    classification: z.enum(CLASSIFICATIONS),
    policyPin: z.string().min(1).max(128),
    retentionDays: z.number().int().positive(),
    storedAt: z.string().regex(ISO_UTC_RE),
    retentionUntil: z.string().regex(ISO_UTC_RE),
    legalHold: z.boolean(),
    sizeBytes: z.number().int().nonnegative(),
    mediaType: z.string().min(1).max(128),
    contentBase64: z.string(),
  })
  .strict();

export type MigrationEvidenceItem = z.infer<typeof MigrationEvidenceItemSchema>;

export const MigrationReceiptItemSchema = z
  .object({
    receiptId: z.string().min(1),
    jobId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    securityDomain: z.string().min(1),
    model: z.string().min(1),
    batch: z.string().min(1),
    version: z.number().int().positive(),
    recordDigest: z.string().regex(SHA256_RE),
    snapshotDigest: z.string().regex(SHA256_RE),
    recordedAt: z.string().regex(ISO_UTC_RE),
    stored: z.boolean(),
    classification: z.enum(CLASSIFICATIONS),
    retentionUntil: z.string().regex(ISO_UTC_RE),
    policyPin: z.string().min(1),
  })
  .strict();

export type MigrationReceiptItem = z.infer<typeof MigrationReceiptItemSchema>;

export const MigrationSnapshotItemSchema = z
  .object({
    model: z.string().min(1),
    batch: z.string().min(1),
    version: z.number().int().positive(),
    supersedesVersion: z.number().int().positive().nullable(),
    supersedesDigest: z.string().regex(SHA256_RE).nullable(),
    recordDigest: z.string().regex(SHA256_RE),
    snapshotDigest: z.string().regex(SHA256_RE),
    actor: z.string().min(1),
    reason: z.string().min(1),
    origin: z.string().nullable(),
    classification: z.enum(CLASSIFICATIONS),
    retentionPolicyPin: z.string().min(1),
    retentionUntil: z.string().regex(ISO_UTC_RE),
    recordedAt: z.string().regex(ISO_UTC_RE),
    observedAt: z.string().regex(ISO_UTC_RE).nullable(),
    declaredAt: z.string().regex(ISO_UTC_RE).nullable(),
    publishedAt: z.string().regex(ISO_UTC_RE).nullable(),
    validFrom: z.string().regex(ISO_UTC_RE),
    validTo: z.string().regex(ISO_UTC_RE).nullable(),
    payloadJson: z.string().min(2),
  })
  .strict();

export type MigrationSnapshotItem = z.infer<typeof MigrationSnapshotItemSchema>;

export const MigrationRecordBundleSchema = z
  .object({
    model: z.string().min(1),
    batch: z.string().min(1),
    latestVersion: z.number().int().positive(),
    dppPayload: z.record(z.string(), z.unknown()),
    snapshots: z.array(MigrationSnapshotItemSchema).min(1),
    receipts: z.array(MigrationReceiptItemSchema),
  })
  .strict();

export type MigrationRecordBundle = z.infer<typeof MigrationRecordBundleSchema>;

export const MigrationPackageSchema = z
  .object({
    format: z.literal(MIGRATION_PACKAGE_FORMAT),
    packageId: z.string().min(1).max(128),
    exportedAt: z.string().regex(ISO_UTC_RE),
    securityDomain: z.string().min(1).max(64),
    exportedBy: z.string().min(1).max(128),
    reason: z.string().min(1).max(500),
    interpretation: z
      .object({
        profileId: z.string().min(1),
        profileVersion: z.string().min(1),
        manifestSha256: z.string().regex(SHA256_RE),
        activeReleaseId: z.string().nullable(),
        packFiles: z.record(z.string(), z.string()),
      })
      .strict(),
    records: z.array(MigrationRecordBundleSchema),
    evidence: z.array(MigrationEvidenceItemSchema),
    reconciliation: z
      .object({
        recordCount: z.number().int().nonnegative(),
        snapshotCount: z.number().int().nonnegative(),
        evidenceCount: z.number().int().nonnegative(),
        receiptCount: z.number().int().nonnegative(),
        sourceStoreChecksum: z.string().regex(SHA256_RE),
      })
      .strict(),
    restrictions: z
      .object({
        excludesIdentityGrants: z.literal(true),
        excludesCredentialsAndKeys: z.literal(true),
        replayNeverRestoresRevokedRights: z.literal(true),
        replayNeverOverwritesIssuedEvidence: z.literal(true),
        thirdPartyAndIpNotice: z.string().min(1),
      })
      .strict(),
    substantiveDigest: z.string().regex(SHA256_RE),
  })
  .strict();

export type MigrationPackage = z.infer<typeof MigrationPackageSchema>;

export interface MigrationImportResult {
  packageId: string;
  importedAt: string;
  reconciledRecords: number;
  addedSnapshots: number;
  skippedSnapshots: number;
  addedEvidence: number;
  skippedEvidence: number;
  addedReceipts: number;
  skippedReceipts: number;
  grantsTouched: false;
  mismatches: string[];
}

export class OpsError extends Error {
  override name = "OpsError";
  constructor(
    public readonly code:
      | "backup-invalid"
      | "backup-tampered"
      | "backup-retention-protected"
      | "restore-checksum-mismatch"
      | "restore-evidence-mismatch"
      | "egress-target-refused"
      | "migration-invalid"
      | "migration-digest-mismatch"
      | "migration-conflict-overwrite"
      | "migration-evidence-mismatch"
      | "reconstruction-mismatch"
      | "reason-required",
    public readonly statusCode: 400 | 403 | 404 | 409 | 422 | 500,
    message: string,
  ) {
    super(message);
  }
}

// ── 3. Structured Fault-Class Monitoring Alerts (FUNC-132) ──

export const ALERT_FAULT_CLASSES = [
  "server_error_burst",
  "rate_limit_saturation",
  "job_timeout_or_stall",
  "egress_blocked_attempt",
  "backup_overdue",
  "integrity_or_pack_failure",
  "memory_budget_pressure",
] as const;
export type AlertFaultClass = (typeof ALERT_FAULT_CLASSES)[number];

export const ALERT_SEVERITIES = ["warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** Strictly value-free alert record: never carries input values, model/batch IDs, filenames, or subjects. */
export const AlertRecordSchema = z
  .object({
    alertId: z.string().min(1).max(128),
    faultClass: z.enum(ALERT_FAULT_CLASSES),
    severity: z.enum(ALERT_SEVERITIES),
    state: z.enum(["firing", "resolved"]),
    raisedAt: z.string().min(1),
    resolvedAt: z.string().nullable(),
    count: z.number().nonnegative(),
    threshold: z.number().positive(),
    serviceOwner: z.string().min(1).max(128),
    runbookRef: z.string().min(1).max(128),
  })
  .strict();

export type AlertRecord = z.infer<typeof AlertRecordSchema>;

export interface AlertThresholds {
  serverError5xxCount: number;
  rateLimitCount: number;
  jobTimeoutCount: number;
  egressBlockedCount: number;
  backupMaxAgeSeconds: number;
  integrityFailureCount: number;
  memoryRssMiB: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  serverError5xxCount: 1,
  rateLimitCount: 5,
  jobTimeoutCount: 1,
  egressBlockedCount: 1,
  backupMaxAgeSeconds: D9_06_TARGETS.rpoMaxSeconds,
  integrityFailureCount: 1,
  memoryRssMiB: 400,
};

// ── 4. Content Acceptance Verification Report ──

export type ContentAcceptanceCategory = "catalogue" | "governance" | "operators" | "terminology" | "registry-hold";

export interface ContentAcceptanceCheck {
  id: string;
  category: ContentAcceptanceCategory;
  description: string;
  passed: boolean;
  detail: string;
}

export interface ContentAcceptanceReport {
  profileId: string;
  profileVersion: string;
  manifestDigest: string;
  propertyCount: number;
  registryProfileConfirmed: boolean;
  registrySubmission: string | null;
  registryHoldReason: string | null;
  checks: ContentAcceptanceCheck[];
  passed: boolean;
}
