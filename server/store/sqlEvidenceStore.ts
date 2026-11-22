/**
 * Content-addressed evidence store enforcing classification, SHA-256 digest integrity, retention
 * horizons, and legal-hold deletion blocks (C6-02, C6-05, FUNC-064, LEAN-DEF-06, LEAN-DEF-12).
 */
import { createHash } from "node:crypto";
import {
  computeRetentionUntil,
  DEFAULT_SECURITY_DOMAIN,
  resolveDatasetRetention,
  RetentionViolationError,
  type EvidenceRetentionMetadata,
} from "../../src/model/pContracts";
import type { DbAdapter } from "../db/adapter";
import { PolicyStore } from "./policyStore";

export interface PutEvidenceRequest {
  evidenceId: string;
  issuer: string;
  revision: string;
  recordKind: string;
  dataset?: string;
  statedClassification?: string | null;
  declaredSha256?: string;
  mediaType?: string;
  contentBytes: Uint8Array;
  legalHold?: boolean;
  storedAt?: string;
}

export interface StoredEvidence extends EvidenceRetentionMetadata {
  contentBytes: Uint8Array;
}

interface EvidenceRow {
  security_domain: string;
  sha256: string;
  evidence_id: string;
  issuer: string;
  revision: string;
  record_kind: string;
  dataset: string;
  classification: EvidenceRetentionMetadata["classification"];
  policy_pin: string;
  retention_days: number;
  stored_at: string;
  retention_until: string;
  legal_hold: number;
  size_bytes: number;
  media_type: string;
  content_blob: Uint8Array;
}

function rowToMeta(row: Omit<EvidenceRow, "content_blob">): EvidenceRetentionMetadata {
  return {
    sha256: row.sha256,
    securityDomain: row.security_domain,
    evidenceId: row.evidence_id,
    issuer: row.issuer,
    revision: row.revision,
    recordKind: row.record_kind,
    dataset: row.dataset,
    classification: row.classification,
    policyPin: row.policy_pin,
    retentionDays: Number(row.retention_days),
    storedAt: row.stored_at,
    retentionUntil: row.retention_until,
    legalHold: Number(row.legal_hold) === 1,
    sizeBytes: Number(row.size_bytes),
    mediaType: row.media_type,
  };
}

export class SqlEvidenceStore {
  private readonly policies: PolicyStore;

  constructor(
    private readonly db: DbAdapter,
    public readonly securityDomain: string = DEFAULT_SECURITY_DOMAIN,
  ) {
    if (!securityDomain.trim()) {
      throw new RetentionViolationError("domain-missing", "securityDomain is required for evidence storage");
    }
    this.policies = new PolicyStore(db);
  }

  /**
   * Stores an evidence artefact content-addressed by SHA-256 under the active retention policy.
   * Refuses if no retention policy is active, or if `declaredSha256` does not match `contentBytes`.
   */
  put(req: PutEvidenceRequest): { stored: boolean; metadata: EvidenceRetentionMetadata } {
    const active = this.policies.requireActive();
    const actualSha = createHash("sha256").update(req.contentBytes).digest("hex");
    if (req.declaredSha256 !== undefined) {
      const normalized = req.declaredSha256.replace(/^sha256:/i, "").toLowerCase();
      if (normalized !== actualSha) {
        throw new RetentionViolationError(
          "digest-mismatch",
          `Evidence ${req.evidenceId}: declared sha256 ${normalized} does not match computed ${actualSha}`,
        );
      }
    }

    const dataset = req.dataset ?? "evidence-object";
    const resolved = resolveDatasetRetention(active.policy, dataset, req.statedClassification);
    const storedAt = req.storedAt ?? new Date().toISOString();
    const retentionUntil = computeRetentionUntil(storedAt, resolved.retentionDays);

    return this.db.transaction(() => {
      const existing = this.db.get<Omit<EvidenceRow, "content_blob">>(
        `SELECT security_domain, sha256, evidence_id, issuer, revision, record_kind, dataset,
                classification, policy_pin, retention_days, stored_at, retention_until,
                legal_hold, size_bytes, media_type
         FROM evidence_store
         WHERE security_domain = ? AND sha256 = ?`,
        this.securityDomain,
        actualSha,
      );
      if (existing) {
        // Idempotent: if legalHold is newly requested, tighten (never silently clear) legalHold.
        if (req.legalHold && Number(existing.legal_hold) === 0) {
          this.db.run(
            "UPDATE evidence_store SET legal_hold = 1 WHERE security_domain = ? AND sha256 = ?",
            this.securityDomain,
            actualSha,
          );
          existing.legal_hold = 1;
        }
        return { stored: false, metadata: rowToMeta(existing) };
      }

      this.db.run(
        `INSERT INTO evidence_store (
          security_domain, sha256, evidence_id, issuer, revision, record_kind, dataset,
          classification, policy_pin, retention_days, stored_at, retention_until,
          legal_hold, size_bytes, media_type, content_blob
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        this.securityDomain,
        actualSha,
        req.evidenceId,
        req.issuer,
        req.revision,
        req.recordKind,
        dataset,
        resolved.classification,
        resolved.policyPin,
        resolved.retentionDays,
        storedAt,
        retentionUntil,
        req.legalHold ? 1 : 0,
        req.contentBytes.byteLength,
        req.mediaType ?? "application/octet-stream",
        new Uint8Array(req.contentBytes),
      );

      return {
        stored: true,
        metadata: {
          sha256: actualSha,
          securityDomain: this.securityDomain,
          evidenceId: req.evidenceId,
          issuer: req.issuer,
          revision: req.revision,
          recordKind: req.recordKind,
          dataset,
          classification: resolved.classification,
          policyPin: resolved.policyPin,
          retentionDays: resolved.retentionDays,
          storedAt,
          retentionUntil,
          legalHold: !!req.legalHold,
          sizeBytes: req.contentBytes.byteLength,
          mediaType: req.mediaType ?? "application/octet-stream",
        },
      };
    });
  }

  get(sha256: string): StoredEvidence | undefined {
    const normalized = sha256.replace(/^sha256:/i, "").toLowerCase();
    const row = this.db.get<EvidenceRow>(
      "SELECT * FROM evidence_store WHERE security_domain = ? AND sha256 = ?",
      this.securityDomain,
      normalized,
    );
    if (!row) return undefined;
    const bytes = new Uint8Array(row.content_blob);
    // Verify integrity on read as well
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== row.sha256) {
      throw new RetentionViolationError("digest-mismatch", `Stored evidence ${row.sha256} failed integrity verification`);
    }
    return { ...rowToMeta(row), contentBytes: bytes };
  }

  list(): EvidenceRetentionMetadata[] {
    const rows = this.db.query<Omit<EvidenceRow, "content_blob">>(
      `SELECT security_domain, sha256, evidence_id, issuer, revision, record_kind, dataset,
              classification, policy_pin, retention_days, stored_at, retention_until,
              legal_hold, size_bytes, media_type
       FROM evidence_store
       WHERE security_domain = ?
       ORDER BY stored_at ASC, sha256 ASC`,
      this.securityDomain,
    );
    return rows.map(rowToMeta);
  }

  setLegalHold(sha256: string, hold: boolean): EvidenceRetentionMetadata | undefined {
    const normalized = sha256.replace(/^sha256:/i, "").toLowerCase();
    return this.db.transaction(() => {
      const res = this.db.run(
        "UPDATE evidence_store SET legal_hold = ? WHERE security_domain = ? AND sha256 = ?",
        hold ? 1 : 0,
        this.securityDomain,
        normalized,
      );
      if (res.changes === 0) return undefined;
      const row = this.db.get<Omit<EvidenceRow, "content_blob">>(
        `SELECT security_domain, sha256, evidence_id, issuer, revision, record_kind, dataset,
                classification, policy_pin, retention_days, stored_at, retention_until,
                legal_hold, size_bytes, media_type
         FROM evidence_store
         WHERE security_domain = ? AND sha256 = ?`,
        this.securityDomain,
        normalized,
      );
      return row ? rowToMeta(row) : undefined;
    });
  }

  /**
   * Deletes an evidence object ONLY if its retention horizon has elapsed (`nowIso >= retentionUntil`)
   * AND no legal hold is active (C6-05). Throws `RetentionViolationError` otherwise.
   */
  delete(sha256: string, nowIso: string = new Date().toISOString()): boolean {
    const normalized = sha256.replace(/^sha256:/i, "").toLowerCase();
    return this.db.transaction(() => {
      const row = this.db.get<{ retention_until: string; legal_hold: number }>(
        "SELECT retention_until, legal_hold FROM evidence_store WHERE security_domain = ? AND sha256 = ?",
        this.securityDomain,
        normalized,
      );
      if (!row) return false;
      if (Number(row.legal_hold) === 1) {
        throw new RetentionViolationError("legal-hold-active", `Evidence ${normalized} is under legal hold and cannot be deleted`);
      }
      if (Date.parse(nowIso) < Date.parse(row.retention_until)) {
        throw new RetentionViolationError(
          "retention-active",
          `Evidence ${normalized} must be retained until ${row.retention_until}`,
        );
      }
      const res = this.db.run(
        "DELETE FROM evidence_store WHERE security_domain = ? AND sha256 = ?",
        this.securityDomain,
        normalized,
      );
      return res.changes > 0;
    });
  }
}
