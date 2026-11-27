/**
 * Portable Backup & DPPSP Migration / Customer Exit Package (`FUNC-105`).
 *
 * Exports the authorised `DPPPayload` (inline `@context`), versioned snapshots, receipts,
 * authorised evidence objects, and pinned interpretation pack needed to reconcile and reconstruct
 * every route output independently on a fresh deployment.
 *
 * Security invariants:
 *   1. Identity grants (`users`, `role_grants`, `grant_events`), OIDC keys, and credentials are NEVER
 *      exported or modified on import — replay can NEVER restore revoked rights.
 *   2. Issued evidence blobs and snapshot versions are NEVER overwritten on replay: identical items
 *      are skipped idempotently (tightening `legal_hold = 1` if newly asserted), while differing
 *      content for an existing digest or version is refused with a 409 conflict.
 *   3. Imported evidence, snapshots, and receipts are always floored against the active pinned
 *      `RETENTION@1.0.0` policy and EV-5 time envelope validation — crafted packages can never
 *      downgrade classification, shorten retention horizons, or clear legal holds.
 */
import { createHash, randomUUID } from "node:crypto";
import { CLASSIFICATIONS } from "../../src/model/classification";
import {
  MIGRATION_PACKAGE_FORMAT,
  MigrationPackageSchema,
  OpsError,
  type MigrationEvidenceItem,
  type MigrationImportResult,
  type MigrationPackage,
  type MigrationReceiptItem,
  type MigrationRecordBundle,
  type MigrationSnapshotItem,
} from "../../src/model/c10Contracts";
import { canonical } from "../../src/model/canonical";
import { dispatchExchangeEnvelope } from "../../src/model/context";
import { generateRelease } from "../../src/model/outputs/release";
import type { SoftwareInfo } from "../../src/model/outputs/software";
import {
  canonicalUtcIso,
  computeRetentionUntil,
  DEFAULT_SECURITY_DOMAIN,
  resolveDatasetRetention,
  validateEv5TimeEnvelope,
} from "../../src/model/pContracts";
import type { ProfilePack } from "../../src/model/profile";
import type { Snapshot } from "../../src/model/recordRepository";
import { checkBoundedSchema } from "../../src/model/recordSchemaCheck";
import { parseStrictJson, toPlain } from "../../src/model/strictJson";
import type { DbAdapter } from "../db/adapter";
import { computeStoreChecksum } from "../db/migrations";
import { ConfigReleaseStore } from "../releases/configReleaseStore";
import { PolicyStore } from "../store/policyStore";
import { SqlRecordRepository, verifySnapshotSync } from "../store/sqlRepository";

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const MAX_MIGRATION_DEPTH = 24;
const MAX_MIGRATION_NODES = 200_000;

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function migrationSubstantiveDigest(pkg: Omit<MigrationPackage, "exportedAt" | "substantiveDigest">): string {
  return sha256(canonical(pkg));
}

function stricterClassification(
  a: MigrationEvidenceItem["classification"],
  b: MigrationEvidenceItem["classification"],
): MigrationEvidenceItem["classification"] {
  return CLASSIFICATIONS.indexOf(a) >= CLASSIFICATIONS.indexOf(b) ? a : b;
}

function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** Bounds depth and node count on pre-parsed JS values so direct object callers cannot trigger stack overflow. */
function assertBoundedValue(root: unknown, maxDepth = MAX_MIGRATION_DEPTH, maxNodes = MAX_MIGRATION_NODES): void {
  let nodes = 0;
  const stack: Array<{ val: unknown; depth: number }> = [{ val: root, depth: 1 }];
  while (stack.length > 0) {
    const { val, depth } = stack.pop()!;
    if (depth > maxDepth) {
      throw new OpsError("migration-invalid", 400, "Migration package exceeds maximum nesting depth");
    }
    if (++nodes > maxNodes) {
      throw new OpsError("migration-invalid", 400, "Migration package exceeds maximum node count");
    }
    if (Array.isArray(val)) {
      for (const item of val) stack.push({ val: item, depth: depth + 1 });
    } else if (val && typeof val === "object") {
      for (const k of Object.keys(val as Record<string, unknown>)) {
        stack.push({ val: (val as Record<string, unknown>)[k], depth: depth + 1 });
      }
    }
  }
}

function loadActivePackFiles(db: DbAdapter, securityDomain: string, fallbackPack: ProfilePack): {
  activeReleaseId: string | null;
  packFiles: Record<string, string>;
} {
  const row = db.get<{ release_id: string; bundle_json: string }>(
    "SELECT release_id, bundle_json FROM config_packages WHERE security_domain = ? AND state = 'active' LIMIT 1",
    securityDomain,
  );
  if (row) {
    try {
      const parsed = JSON.parse(row.bundle_json) as { files?: Record<string, string> };
      if (parsed && typeof parsed.files === "object" && parsed.files) {
        return { activeReleaseId: row.release_id, packFiles: parsed.files };
      }
    } catch {
      // fall through to minimal pinned manifest files
    }
  }
  return {
    activeReleaseId: null,
    packFiles: {
      "contracts/context.jsonld": JSON.stringify(fallbackPack.contracts.contextLd),
      "contracts/profile_policy.json": JSON.stringify(fallbackPack.contracts.profilePolicy),
      "contracts/record.schema.json": JSON.stringify(fallbackPack.contracts.recordSchema),
    },
  };
}

export interface ExportMigrationOptions {
  securityDomain?: string;
  exportedBy: string;
  reason: string;
  nowIso?: string;
}

/**
 * Exports a portable, self-verifying `dpp-migration-package@1.0.0` for customer exit or DPPSP
 * migration (`FUNC-105`). Never includes identity grants or credentials.
 */
export function exportMigrationPackage(
  db: DbAdapter,
  pack: ProfilePack,
  options: ExportMigrationOptions,
): MigrationPackage {
  const reason = options.reason.trim();
  if (!reason || reason.length > 500 || CONTROL_CHARS.test(reason)) {
    throw new OpsError("reason-required", 400, "A single-line export reason (1..500 chars) is required");
  }
  const domain = options.securityDomain?.trim() || DEFAULT_SECURITY_DOMAIN;
  const exportedAt = canonicalUtcIso(options.nowIso ?? new Date().toISOString());

  const snapshotRows = db.query<{
    model: string;
    batch: string;
    version: number;
    supersedes_version: number | null;
    supersedes_digest: string | null;
    record_digest: string;
    snapshot_digest: string;
    actor: string;
    reason: string;
    origin: string | null;
    classification: MigrationSnapshotItem["classification"];
    retention_policy_pin: string;
    retention_until: string;
    recorded_at: string;
    observed_at: string | null;
    declared_at: string | null;
    published_at: string | null;
    valid_from: string;
    valid_to: string | null;
    payload_json: string;
  }>(
    `SELECT model, batch, version, supersedes_version, supersedes_digest, record_digest, snapshot_digest,
            actor, reason, origin, classification, retention_policy_pin, retention_until,
            recorded_at, observed_at, declared_at, published_at, valid_from, valid_to, payload_json
     FROM snapshots
     WHERE security_domain = ?
     ORDER BY model ASC, batch ASC, version ASC`,
    domain,
  );

  const receiptRows = db.query<{
    receipt_id: string;
    job_id: string;
    idempotency_key: string;
    security_domain: string;
    model: string;
    batch: string;
    version: number;
    record_digest: string;
    snapshot_digest: string;
    recorded_at: string;
    stored: number;
    classification: MigrationReceiptItem["classification"];
    retention_until: string;
    policy_pin: string;
  }>(
    `SELECT receipt_id, job_id, idempotency_key, security_domain, model, batch, version,
            record_digest, snapshot_digest, recorded_at, stored, classification, retention_until, policy_pin
     FROM update_receipts
     WHERE security_domain = ?
     ORDER BY model ASC, batch ASC, version ASC, receipt_id ASC`,
    domain,
  );

  const evidenceRows = db.query<{
    sha256: string;
    security_domain: string;
    evidence_id: string;
    issuer: string;
    revision: string;
    record_kind: string;
    dataset: string;
    classification: MigrationEvidenceItem["classification"];
    policy_pin: string;
    retention_days: number;
    stored_at: string;
    retention_until: string;
    legal_hold: number;
    size_bytes: number;
    media_type: string;
    content_blob: Uint8Array;
  }>(
    `SELECT sha256, security_domain, evidence_id, issuer, revision, record_kind, dataset,
            classification, policy_pin, retention_days, stored_at, retention_until,
            legal_hold, size_bytes, media_type, content_blob
     FROM evidence_store
     WHERE security_domain = ?
     ORDER BY sha256 ASC`,
    domain,
  );

  const evidence: MigrationEvidenceItem[] = evidenceRows.map((r) => {
    const bytes = new Uint8Array(r.content_blob);
    const actualSha = sha256(bytes);
    if (actualSha !== r.sha256 || bytes.byteLength !== Number(r.size_bytes)) {
      throw new OpsError("migration-evidence-mismatch", 500, "Refusing to export corrupted evidence blob");
    }
    return {
      sha256: r.sha256,
      securityDomain: r.security_domain,
      evidenceId: r.evidence_id,
      issuer: r.issuer,
      revision: r.revision,
      recordKind: r.record_kind,
      dataset: r.dataset,
      classification: r.classification,
      policyPin: r.policy_pin,
      retentionDays: Number(r.retention_days),
      storedAt: canonicalUtcIso(r.stored_at),
      retentionUntil: canonicalUtcIso(r.retention_until),
      legalHold: Number(r.legal_hold) === 1,
      sizeBytes: Number(r.size_bytes),
      mediaType: r.media_type,
      contentBase64: Buffer.from(bytes).toString("base64"),
    };
  });

  const receiptsByKey = new Map<string, MigrationReceiptItem[]>();
  for (const r of receiptRows) {
    const key = `${r.model}\u0000${r.batch}`;
    const list = receiptsByKey.get(key) ?? [];
    list.push({
      receiptId: r.receipt_id,
      jobId: r.job_id,
      idempotencyKey: r.idempotency_key,
      securityDomain: r.security_domain,
      model: r.model,
      batch: r.batch,
      version: Number(r.version),
      recordDigest: r.record_digest,
      snapshotDigest: r.snapshot_digest,
      recordedAt: canonicalUtcIso(r.recorded_at),
      stored: Number(r.stored) === 1,
      classification: r.classification,
      retentionUntil: canonicalUtcIso(r.retention_until),
      policyPin: r.policy_pin,
    });
    receiptsByKey.set(key, list);
  }

  const snapsByKey = new Map<string, MigrationSnapshotItem[]>();
  for (const r of snapshotRows) {
    const key = `${r.model}\u0000${r.batch}`;
    const list = snapsByKey.get(key) ?? [];
    list.push({
      model: r.model,
      batch: r.batch,
      version: Number(r.version),
      supersedesVersion: r.supersedes_version === null ? null : Number(r.supersedes_version),
      supersedesDigest: r.supersedes_digest,
      recordDigest: r.record_digest,
      snapshotDigest: r.snapshot_digest,
      actor: r.actor,
      reason: r.reason,
      origin: r.origin,
      classification: r.classification,
      retentionPolicyPin: r.retention_policy_pin,
      retentionUntil: canonicalUtcIso(r.retention_until),
      recordedAt: canonicalUtcIso(r.recorded_at),
      observedAt: r.observed_at ? canonicalUtcIso(r.observed_at) : null,
      declaredAt: r.declared_at ? canonicalUtcIso(r.declared_at) : null,
      publishedAt: r.published_at ? canonicalUtcIso(r.published_at) : null,
      validFrom: canonicalUtcIso(r.valid_from),
      validTo: r.valid_to ? canonicalUtcIso(r.valid_to) : null,
      payloadJson: r.payload_json,
    });
    snapsByKey.set(key, list);
  }

  const records: MigrationRecordBundle[] = [];
  for (const [key, snaps] of snapsByKey.entries()) {
    const latestSnap = snaps[snaps.length - 1]!;
    const parsedLatest = toPlain(parseStrictJson(latestSnap.payloadJson, { maxDepth: MAX_MIGRATION_DEPTH, maxNodes: 100_000 })) as Snapshot;
    verifySnapshotSync(parsedLatest);
    const dppPayload = (parsedLatest.record.dppPayload ?? {
      "@context": pack.contracts.contextLd["@context"],
      profile_id: pack.id,
      profile_version: pack.version,
      record_contract: "REC-ALU-24-01",
      model: parsedLatest.model,
      batch: parsedLatest.batch,
    }) as Record<string, unknown>;

    if (parsedLatest.record.dppPayload) {
      const dispatch = dispatchExchangeEnvelope("DPPPayload", parsedLatest.record.dppPayload);
      if (!dispatch.ok) {
        throw new OpsError("migration-invalid", 422, "Record DPPPayload dispatch failed");
      }
      const shapeErrs = checkBoundedSchema(parsedLatest.record.dppPayload, pack.contracts.recordSchema);
      if (shapeErrs.length > 0) {
        throw new OpsError("migration-invalid", 422, "Record DPPPayload failed pinned schema validation");
      }
    }

    records.push({
      model: latestSnap.model,
      batch: latestSnap.batch,
      latestVersion: latestSnap.version,
      dppPayload,
      snapshots: snaps,
      receipts: receiptsByKey.get(key) ?? [],
    });
  }

  const { activeReleaseId, packFiles } = loadActivePackFiles(db, domain, pack);
  const sourceStoreChecksum = computeStoreChecksum(db);
  const packageId = `MIG-${exportedAt.replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;

  const substantive: Omit<MigrationPackage, "exportedAt" | "substantiveDigest"> = {
    format: MIGRATION_PACKAGE_FORMAT,
    packageId,
    securityDomain: domain,
    exportedBy: options.exportedBy,
    reason,
    interpretation: {
      profileId: pack.id,
      profileVersion: pack.version,
      manifestSha256: pack.manifestDigest,
      activeReleaseId,
      packFiles,
    },
    records,
    evidence,
    reconciliation: {
      recordCount: records.length,
      snapshotCount: snapshotRows.length,
      evidenceCount: evidence.length,
      receiptCount: receiptRows.length,
      sourceStoreChecksum,
    },
    restrictions: {
      excludesIdentityGrants: true,
      excludesCredentialsAndKeys: true,
      replayNeverRestoresRevokedRights: true,
      replayNeverOverwritesIssuedEvidence: true,
      thirdPartyAndIpNotice:
        "Exported for authorised customer exit / DPPSP continuity only. Third-party standard definitions, ontology IRIs, and confidential supplier/evidence artefacts remain subject to their issuer licences and retention policies.",
    },
  };

  return {
    ...substantive,
    exportedAt,
    substantiveDigest: migrationSubstantiveDigest(substantive),
  };
}

/**
 * Validates and imports a `dpp-migration-package@1.0.0` into a fresh or existing deployment
 * (`FUNC-105`).
 *
 * Enforces:
 *   - Strict JSON parsing (`parseStrictJson`) with depth/node bounds on both outer payload and `payloadJson`;
 *   - Canonical `substantiveDigest`, pack pin, reconciliation count, and full snapshot wrapper-vs-payload cross-checks;
 *   - Active `RETENTION@1.0.0` classification/horizon floors + EV-5 time envelope validation on all imported rows;
 *   - `grantsTouched: false` — identity tables (`users`, `role_grants`, `grant_events`) are NEVER read or written;
 *   - Existing evidence blobs and snapshots are NEVER overwritten (identical -> skip + tighten `legal_hold = 1`; differing -> 409 conflict).
 */
export function importMigrationPackage(
  db: DbAdapter,
  pack: ProfilePack,
  rawInput: string | MigrationPackage,
  options: { securityDomain?: string; nowIso?: string } = {},
): MigrationImportResult {
  let obj: unknown = rawInput;
  if (typeof rawInput === "string") {
    try {
      obj = toPlain(parseStrictJson(rawInput, { maxDepth: MAX_MIGRATION_DEPTH, maxNodes: MAX_MIGRATION_NODES }));
    } catch {
      throw new OpsError("migration-invalid", 400, "Migration package JSON rejected");
    }
  } else {
    assertBoundedValue(obj);
  }

  // Allow envelope `{ package: MigrationPackage }` when submitted from HTTP after strict parsing
  if (obj && typeof obj === "object" && !Array.isArray(obj) && Object.hasOwn(obj, "package") && !Object.hasOwn(obj, "format")) {
    obj = (obj as Record<string, unknown>).package;
  }

  const parsed = MigrationPackageSchema.safeParse(obj);
  if (!parsed.success) {
    throw new OpsError("migration-invalid", 400, "Migration package schema is invalid");
  }
  const pkg = parsed.data;

  const { exportedAt: _exp, substantiveDigest, ...substantive } = pkg;
  if (migrationSubstantiveDigest(substantive) !== substantiveDigest) {
    throw new OpsError("migration-digest-mismatch", 422, "Migration package substantiveDigest does not match content");
  }

  if (pkg.interpretation.profileId !== pack.id || pkg.interpretation.manifestSha256 !== pack.manifestDigest) {
    throw new OpsError("migration-invalid", 422, "Migration package interpretation profile or manifest digest does not match active pack");
  }

  const totalSnapshots = pkg.records.reduce((n, r) => n + r.snapshots.length, 0);
  const totalReceipts = pkg.records.reduce((n, r) => n + r.receipts.length, 0);
  if (
    pkg.reconciliation.recordCount !== pkg.records.length ||
    pkg.reconciliation.snapshotCount !== totalSnapshots ||
    pkg.reconciliation.evidenceCount !== pkg.evidence.length ||
    pkg.reconciliation.receiptCount !== totalReceipts
  ) {
    throw new OpsError("migration-invalid", 422, "Migration package reconciliation counts do not match payload arrays");
  }

  const domain = options.securityDomain?.trim() || pkg.securityDomain || DEFAULT_SECURITY_DOMAIN;
  const importedAt = canonicalUtcIso(options.nowIso ?? new Date().toISOString());
  const activePolicy = pack.policy.retention;
  const activePolicyPin = `${activePolicy.id}@${activePolicy.version}`;

  // Pre-validate & floor every evidence item before touching DB
  const evidenceFloor = resolveDatasetRetention(activePolicy, "evidence-object");
  const decodedEvidence = pkg.evidence.map((ev) => {
    const bytes = Buffer.from(ev.contentBase64, "base64");
    const actualSha = sha256(bytes);
    if (actualSha !== ev.sha256 || bytes.byteLength !== ev.sizeBytes) {
      throw new OpsError("migration-evidence-mismatch", 422, "Migration evidence failed SHA-256 or byte-length verification");
    }
    const storedAt = canonicalUtcIso(ev.storedAt);
    const importedRetUntil = canonicalUtcIso(ev.retentionUntil);
    const datasetRule = resolveDatasetRetention(activePolicy, ev.dataset, ev.classification);
    const flooredClass = stricterClassification(stricterClassification(ev.classification, datasetRule.classification), evidenceFloor.classification);
    const flooredDays = Math.max(ev.retentionDays, datasetRule.retentionDays, evidenceFloor.retentionDays);
    // Floor horizon from max(storedAt, importedAt) or imported retentionUntil so backdating cannot bypass retention
    const minRetUntilFromStored = computeRetentionUntil(maxIso(storedAt, importedAt), flooredDays);
    const flooredRetUntil = maxIso(importedRetUntil, minRetUntilFromStored);
    return {
      meta: {
        ...ev,
        classification: flooredClass,
        retentionDays: flooredDays,
        policyPin: activePolicyPin,
        storedAt,
        retentionUntil: flooredRetUntil,
      },
      bytes,
    };
  });

  // Pre-validate & floor every snapshot and receipt before touching DB
  const snapshotFloor = resolveDatasetRetention(activePolicy, "central-record");
  const receiptFloor = resolveDatasetRetention(activePolicy, "update-receipt");

  const preparedRecords = pkg.records.map((bundle) => {
    let prev: MigrationSnapshotItem | null = null;
    const byVersion = new Map<number, MigrationSnapshotItem>();
    let latestParsedSnap: Snapshot | null = null;

    const flooredSnaps = bundle.snapshots.map((s) => {
      if (s.model !== bundle.model || s.batch !== bundle.batch) {
        throw new OpsError("migration-invalid", 422, "Snapshot model/batch does not match record bundle");
      }
      let parsedSnap: Snapshot;
      try {
        parsedSnap = toPlain(parseStrictJson(s.payloadJson, { maxDepth: MAX_MIGRATION_DEPTH, maxNodes: 100_000 })) as Snapshot;
        verifySnapshotSync(parsedSnap);
      } catch {
        throw new OpsError("migration-invalid", 422, "Snapshot payloadJson failed strict parsing or integrity verification");
      }

      // Cross-check EVERY wrapper column against parsedSnap (prevents wrapper spoofing)
      const expectedSupVer = parsedSnap.supersedes?.version ?? null;
      const expectedSupDig = parsedSnap.supersedes?.digest ?? null;
      const expectedOrigin = parsedSnap.origin ?? null;
      if (
        parsedSnap.model !== s.model ||
        parsedSnap.batch !== s.batch ||
        parsedSnap.version !== s.version ||
        parsedSnap.actor !== s.actor ||
        parsedSnap.reason !== s.reason ||
        expectedOrigin !== s.origin ||
        expectedSupVer !== s.supersedesVersion ||
        expectedSupDig !== s.supersedesDigest ||
        parsedSnap.digest !== s.snapshotDigest ||
        parsedSnap.record.digest !== s.recordDigest
      ) {
        throw new OpsError("migration-invalid", 422, "Snapshot wrapper metadata disagrees with payloadJson");
      }

      if (prev) {
        if (s.version !== prev.version + 1 || s.supersedesVersion !== prev.version || s.supersedesDigest !== prev.snapshotDigest) {
          throw new OpsError("migration-invalid", 422, "Snapshot predecessor chain is broken");
        }
      } else if (s.version !== 1 || s.supersedesVersion !== null || s.supersedesDigest !== null) {
        throw new OpsError("migration-invalid", 422, "First snapshot must be version 1 with no predecessor");
      }

      // Enforce EV-5 time envelope & retention floor
      const envelope = validateEv5TimeEnvelope({
        recordedAt: s.recordedAt,
        observedAt: s.observedAt,
        declaredAt: s.declaredAt,
        publishedAt: s.publishedAt,
        validFrom: s.validFrom,
        validTo: s.validTo,
      });
      const flooredClass = stricterClassification(s.classification, snapshotFloor.classification);
      const flooredRetUntil = maxIso(
        canonicalUtcIso(s.retentionUntil),
        computeRetentionUntil(envelope.recordedAt, snapshotFloor.retentionDays),
      );

      const cleanSnap: MigrationSnapshotItem = {
        ...s,
        classification: flooredClass,
        retentionPolicyPin: activePolicyPin,
        retentionUntil: flooredRetUntil,
        recordedAt: envelope.recordedAt,
        observedAt: envelope.observedAt,
        declaredAt: envelope.declaredAt,
        publishedAt: envelope.publishedAt,
        validFrom: envelope.validFrom,
        validTo: envelope.validTo,
      };
      prev = cleanSnap;
      latestParsedSnap = parsedSnap;
      byVersion.set(s.version, cleanSnap);
      return cleanSnap;
    });

    const lastSnap = flooredSnaps[flooredSnaps.length - 1]!;
    if (bundle.latestVersion !== lastSnap.version) {
      throw new OpsError("migration-invalid", 422, "Record bundle latestVersion disagrees with snapshots");
    }
    if (latestParsedSnap && (latestParsedSnap as Snapshot).record.dppPayload) {
      if (canonical(bundle.dppPayload) !== canonical((latestParsedSnap as Snapshot).record.dppPayload)) {
        throw new OpsError("migration-invalid", 422, "Record bundle dppPayload disagrees with latest snapshot payload");
      }
    }

    const flooredReceipts = bundle.receipts.map((r) => {
      const targetSnap = byVersion.get(r.version);
      if (!targetSnap || r.model !== bundle.model || r.batch !== bundle.batch || r.snapshotDigest !== targetSnap.snapshotDigest || r.recordDigest !== targetSnap.recordDigest) {
        throw new OpsError("migration-invalid", 422, "Migration receipt does not match any snapshot in its record bundle");
      }
      const recAt = canonicalUtcIso(r.recordedAt);
      const flooredClass = stricterClassification(r.classification, receiptFloor.classification);
      const flooredRetUntil = maxIso(
        canonicalUtcIso(r.retentionUntil),
        computeRetentionUntil(recAt, receiptFloor.retentionDays),
      );
      return {
        ...r,
        recordedAt: recAt,
        classification: flooredClass,
        retentionUntil: flooredRetUntil,
        policyPin: activePolicyPin,
      };
    });

    return { bundle, snapshots: flooredSnaps, receipts: flooredReceipts };
  });

  // Ensure active retention policy exists before inserting retained rows
  new PolicyStore(db, domain).activate(activePolicy, importedAt);

  let addedSnapshots = 0;
  let skippedSnapshots = 0;
  let addedEvidence = 0;
  let skippedEvidence = 0;
  let addedReceipts = 0;
  let skippedReceipts = 0;

  db.transaction(() => {
    // 1. Evidence (never overwrite existing SHA-256; tighten legal_hold = 1 on replay if asserted)
    for (const { meta, bytes } of decodedEvidence) {
      const existing = db.get<{ content_blob: Uint8Array; sha256: string; legal_hold: number }>(
        "SELECT sha256, content_blob, legal_hold FROM evidence_store WHERE security_domain = ? AND sha256 = ?",
        domain,
        meta.sha256,
      );
      if (existing) {
        const existingBytes = Buffer.from(existing.content_blob);
        if (!existingBytes.equals(bytes)) {
          throw new OpsError("migration-conflict-overwrite", 409, "Refusing to overwrite existing issued evidence blob");
        }
        if (meta.legalHold && Number(existing.legal_hold) === 0) {
          db.run(
            "UPDATE evidence_store SET legal_hold = 1 WHERE security_domain = ? AND sha256 = ?",
            domain,
            meta.sha256,
          );
        }
        skippedEvidence++;
        continue;
      }
      db.run(
        `INSERT INTO evidence_store (
          security_domain, sha256, evidence_id, issuer, revision, record_kind, dataset,
          classification, policy_pin, retention_days, stored_at, retention_until,
          legal_hold, size_bytes, media_type, content_blob
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        domain,
        meta.sha256,
        meta.evidenceId,
        meta.issuer,
        meta.revision,
        meta.recordKind,
        meta.dataset,
        meta.classification,
        meta.policyPin,
        meta.retentionDays,
        meta.storedAt,
        meta.retentionUntil,
        meta.legalHold ? 1 : 0,
        meta.sizeBytes,
        meta.mediaType,
        bytes,
      );
      addedEvidence++;
    }

    // 2. Snapshots & receipts (never overwrite existing versions; close prior open valid_to on append)
    for (const { snapshots, receipts } of preparedRecords) {
      for (const s of snapshots) {
        const existing = db.get<{ snapshot_digest: string }>(
          "SELECT snapshot_digest FROM snapshots WHERE security_domain = ? AND model = ? AND batch = ? AND version = ?",
          domain,
          s.model,
          s.batch,
          s.version,
        );
        if (existing) {
          if (existing.snapshot_digest !== s.snapshotDigest) {
            throw new OpsError(
              "migration-conflict-overwrite",
              409,
              "Refusing to overwrite existing snapshot version with conflicting digest",
            );
          }
          skippedSnapshots++;
          continue;
        }
        // Close prior open snapshot's valid_to to preserve half-open [valid_from, valid_to) non-overlap
        if (s.supersedesVersion !== null) {
          db.run(
            `UPDATE snapshots SET valid_to = ?
             WHERE security_domain = ? AND model = ? AND batch = ? AND version = ? AND valid_to IS NULL`,
            s.validFrom,
            domain,
            s.model,
            s.batch,
            s.supersedesVersion,
          );
        }
        db.run(
          `INSERT INTO snapshots (
            security_domain, model, batch, version, supersedes_version, supersedes_digest,
            record_digest, snapshot_digest, actor, reason, origin,
            classification, retention_policy_pin, retention_until,
            recorded_at, observed_at, declared_at, published_at, valid_from, valid_to,
            payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          domain,
          s.model,
          s.batch,
          s.version,
          s.supersedesVersion,
          s.supersedesDigest,
          s.recordDigest,
          s.snapshotDigest,
          s.actor,
          s.reason,
          s.origin,
          s.classification,
          s.retentionPolicyPin,
          s.retentionUntil,
          s.recordedAt,
          s.observedAt,
          s.declaredAt,
          s.publishedAt,
          s.validFrom,
          s.validTo,
          s.payloadJson,
        );
        addedSnapshots++;
      }

      for (const r of receipts) {
        const existing = db.get<{ snapshot_digest: string; security_domain: string }>(
          "SELECT snapshot_digest, security_domain FROM update_receipts WHERE receipt_id = ?",
          r.receiptId,
        );
        if (existing) {
          if (existing.security_domain !== domain || existing.snapshot_digest !== r.snapshotDigest) {
            throw new OpsError("migration-conflict-overwrite", 409, "Refusing to overwrite existing update receipt");
          }
          skippedReceipts++;
          continue;
        }
        const existingJob = db.get<{ job_id: string; security_domain: string }>(
          "SELECT job_id, security_domain FROM import_jobs WHERE job_id = ?",
          r.jobId,
        );
        if (existingJob && existingJob.security_domain !== domain) {
          throw new OpsError("migration-conflict-overwrite", 409, "Receipt job identifier collides with another security domain");
        }
        if (!existingJob) {
          db.run(
            `INSERT INTO import_jobs (
              job_id, security_domain, idempotency_key, actor, state, stage,
              classification, retention_policy_pin, model, batch, result_version,
              result_snapshot_digest, created_at, updated_at, committed_at
            ) VALUES (?, ?, ?, 'ACT-19', 'committed', 'committed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            r.jobId,
            domain,
            r.idempotencyKey,
            r.classification,
            r.policyPin,
            r.model,
            r.batch,
            r.version,
            r.snapshotDigest,
            r.recordedAt,
            r.recordedAt,
            r.recordedAt,
          );
        }
        db.run(
          `INSERT INTO update_receipts (
            receipt_id, job_id, idempotency_key, security_domain, model, batch, version,
            record_digest, snapshot_digest, recorded_at, stored, classification, retention_until, policy_pin
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          r.receiptId,
          r.jobId,
          r.idempotencyKey,
          domain,
          r.model,
          r.batch,
          r.version,
          r.recordDigest,
          r.snapshotDigest,
          r.recordedAt,
          r.stored ? 1 : 0,
          r.classification,
          r.retentionUntil,
          r.policyPin,
        );
        addedReceipts++;
      }
    }
  });

  const mismatches: string[] = [];
  for (const bundle of pkg.records) {
    const row = db.get<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM snapshots WHERE security_domain = ? AND model = ? AND batch = ?",
      domain,
      bundle.model,
      bundle.batch,
    );
    if (Number(row?.cnt ?? 0) < bundle.snapshots.length) {
      mismatches.push(`record-snapshot-count-mismatch:${bundle.model}:${bundle.batch}`);
    }
  }

  return {
    packageId: pkg.packageId,
    importedAt,
    reconciledRecords: pkg.records.length,
    addedSnapshots,
    skippedSnapshots,
    addedEvidence,
    skippedEvidence,
    addedReceipts,
    skippedReceipts,
    grantsTouched: false,
    mismatches,
  };
}

/**
 * Reconstructs all route outputs and the release manifest purely from retained snapshots and
 * active/pinned configuration dependencies in SQLite, optionally comparing against an expected
 * `substantiveDigest`.
 */
export async function reconstructReleaseFromRetained(
  db: DbAdapter,
  fallbackPack: ProfilePack,
  opts: {
    securityDomain?: string;
    model: string;
    batch: string;
    version: number;
    software?: SoftwareInfo;
    expectedSubstantiveDigest?: string;
  },
): Promise<{
  substantiveDigest: string;
  fileDigests: Record<string, string>;
  matchesExpected: boolean;
}> {
  const domain = opts.securityDomain?.trim() || DEFAULT_SECURITY_DOMAIN;
  const configStore = new ConfigReleaseStore(db, domain);
  const activeRel = configStore.getActive();
  const pack = activeRel ? ((await configStore.loadPackByReleaseId(activeRel.releaseId)) ?? fallbackPack) : fallbackPack;

  const repo = new SqlRecordRepository(db, domain);
  const history = await repo.history(opts.model, opts.batch);
  const snap = history.find((s) => s.version === opts.version);
  if (!snap) {
    throw new OpsError("reconstruction-mismatch", 404, "Retained snapshot version not found for reconstruction");
  }

  const release = await generateRelease(pack, snap, { software: opts.software });
  const fileDigests: Record<string, string> = {};
  for (const o of release.outcomes) {
    if ("file" in o) fileDigests[o.route] = sha256(o.file.bytes);
  }
  const substantiveDigest = release.manifestFile.substantiveDigest;
  const matchesExpected =
    opts.expectedSubstantiveDigest === undefined ? true : substantiveDigest === opts.expectedSubstantiveDigest;
  if (!matchesExpected) {
    throw new OpsError("reconstruction-mismatch", 422, "Reconstructed release manifest digest does not match expected digest");
  }
  return { substantiveDigest, fileDigests, matchesExpected };
}
