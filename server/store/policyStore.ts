/**
 * Active classification and retention policy registry stored in the relational database (C6-02, C6-05, C7-04).
 *
 * Refuses ingest and evidence storage until a valid pinned `RETENTION@x.y.z` policy has been loaded
 * and activated in the store (`require_policy_before_ingest: true`). Supports domain-scoped active
 * pins via `domain_retention_policies` (migration v6+) while preserving v1–v5 compatibility.
 */
import { createHash } from "node:crypto";
import { canonical } from "../../src/model/canonical";
import { CLASSIFICATIONS } from "../../src/model/classification";
import {
  DEFAULT_SECURITY_DOMAIN,
  EVIDENCE_FLOOR,
  RetentionPolicySchema,
  RetentionViolationError,
  type RetentionPolicy,
} from "../../src/model/pContracts";
import { loadedRetentionDigest } from "../../src/model/profile";
import type { DbAdapter } from "../db/adapter";

const sha256Sync = (text: string): string => createHash("sha256").update(text).digest("hex");

export const GOVERNED_DATASET_FLOORS: ReadonlyArray<{
  dataset: string;
  minClassification: (typeof CLASSIFICATIONS)[number];
  minRetentionDays: number;
  requireLegalHoldPermitted: boolean;
}> = [
  { dataset: "erp-extract", minClassification: "internal", minRetentionDays: EVIDENCE_FLOOR.retentionDays, requireLegalHoldPermitted: false },
  { dataset: "lab-assessment", minClassification: "restricted", minRetentionDays: EVIDENCE_FLOOR.retentionDays, requireLegalHoldPermitted: false },
  { dataset: "central-record-snapshot", minClassification: "restricted", minRetentionDays: EVIDENCE_FLOOR.retentionDays, requireLegalHoldPermitted: true },
  { dataset: "evidence-object", minClassification: EVIDENCE_FLOOR.classification, minRetentionDays: EVIDENCE_FLOOR.retentionDays, requireLegalHoldPermitted: true },
  { dataset: "release-manifest", minClassification: "internal", minRetentionDays: EVIDENCE_FLOOR.retentionDays, requireLegalHoldPermitted: false },
  { dataset: "execution-log", minClassification: "public", minRetentionDays: EVIDENCE_FLOOR.retentionDays, requireLegalHoldPermitted: false },
];

/**
 * Validates that a retention policy has unique dataset names and meets all minimum classification,
 * retention-horizon, and legal-hold floors across every governed dataset.
 */
export function validateRetentionFloors(policy: RetentionPolicy): string | null {
  if (policy.default_classification !== "restricted") {
    return "Retention policy default_classification must remain restricted";
  }
  if (policy.default_retention_days < EVIDENCE_FLOOR.retentionDays) {
    return `Retention policy default_retention_days must be at least ${EVIDENCE_FLOOR.retentionDays} days`;
  }
  const seen = new Set<string>();
  for (const d of policy.datasets) {
    if (seen.has(d.dataset)) {
      return `Retention policy contains duplicate dataset rule "${d.dataset}"`;
    }
    seen.add(d.dataset);
  }
  for (const floor of GOVERNED_DATASET_FLOORS) {
    const rule = policy.datasets.find((d) => d.dataset === floor.dataset);
    if (!rule) {
      return `Retention policy is missing required dataset rule "${floor.dataset}"`;
    }
    if (CLASSIFICATIONS.indexOf(rule.classification) < CLASSIFICATIONS.indexOf(floor.minClassification)) {
      return `Dataset "${floor.dataset}" must be classified at least "${floor.minClassification}"`;
    }
    if (rule.retention_days < floor.minRetentionDays) {
      return `Dataset "${floor.dataset}" must be retained for at least ${floor.minRetentionDays} days`;
    }
    if (floor.requireLegalHoldPermitted && !rule.legal_hold_permitted) {
      return `Dataset "${floor.dataset}" must keep legal_hold_permitted enabled`;
    }
  }
  return null;
}

export interface StoredPolicy {
  policyPin: string;
  policy: RetentionPolicy;
  loadedAt: string;
  active: boolean;
}

export class PolicyStore {
  constructor(
    private readonly db: DbAdapter,
    public readonly securityDomain: string = DEFAULT_SECURITY_DOMAIN,
  ) {}

  private hasDomainPolicyTable(): boolean {
    const row = this.db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'domain_retention_policies'",
    );
    return Boolean(row);
  }

  /**
   * Checks whether `policy` conflicts with an already-held immutable pin of the same `id@version`.
   * Returns a conflict message if different canonical content is already stored under that pin, else null.
   */
  checkPinConflict(policy: RetentionPolicy): string | null {
    const pin = `${policy.id}@${policy.version}`;
    const held = this.db.get<{ policy_json: string }>(
      "SELECT policy_json FROM retention_policies WHERE policy_pin = ?",
      pin,
    );
    if (held && canonical(JSON.parse(held.policy_json)) !== canonical(policy)) {
      return `Retention policy ${pin} is already held with different content; a pin is immutable`;
    }
    return null;
  }

  /**
   * Activates a pinned retention policy atomically for `this.securityDomain`.
   *
   * Only a policy exactly as loaded from a verified, owner-digest-approved contract pack is accepted: the object must come out of
   * `loadProfilePack` and still have the canonical content digest recorded then. Different content under a pin the
   * database already holds is refused, so a weaker policy can never replace the approved one (C6-02).
   */
  activate(policy: RetentionPolicy, loadedAt: string = new Date().toISOString()): StoredPolicy {
    const parsed = RetentionPolicySchema.safeParse(policy);
    if (!parsed.success) {
      throw new RetentionViolationError(
        "policy-invalid",
        `Invalid retention policy: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
      );
    }
    const pinnedDigest = loadedRetentionDigest(policy);
    if (!pinnedDigest) {
      throw new RetentionViolationError(
        "policy-untrusted",
        "A retention policy can be activated only as loaded from a verified contract pack",
      );
    }
    if (sha256Sync(canonical(policy)) !== pinnedDigest) {
      throw new RetentionViolationError(
        "policy-untrusted",
        "The retention policy no longer matches the content of the owner-digest-approved contract pack",
      );
    }
    const pin = `${parsed.data.id}@${parsed.data.version}`;
    const serialized = JSON.stringify(parsed.data);
    const hasDomainTable = this.hasDomainPolicyTable();

    this.db.transaction(() => {
      const held = this.db.get<{ policy_json: string }>(
        "SELECT policy_json FROM retention_policies WHERE policy_pin = ?",
        pin,
      );
      if (held && canonical(JSON.parse(held.policy_json)) !== canonical(parsed.data)) {
        throw new RetentionViolationError(
          "policy-conflict",
          `Retention policy ${pin} is already held with different content; a pin is immutable`,
        );
      }
      const floorErr = validateRetentionFloors(parsed.data);
      if (floorErr) {
        throw new RetentionViolationError("policy-invalid", floorErr);
      }

      if (!hasDomainTable || this.securityDomain === DEFAULT_SECURITY_DOMAIN) {
        this.db.run("UPDATE retention_policies SET active = 0 WHERE active = 1");
        if (held) {
          this.db.run("UPDATE retention_policies SET active = 1 WHERE policy_pin = ?", pin);
        } else {
          this.db.run(
            "INSERT INTO retention_policies (policy_pin, policy_json, loaded_at, active) VALUES (?, ?, ?, 1)",
            pin,
            serialized,
            loadedAt,
          );
        }
      } else if (!held) {
        this.db.run(
          "INSERT INTO retention_policies (policy_pin, policy_json, loaded_at, active) VALUES (?, ?, ?, 0)",
          pin,
          serialized,
          loadedAt,
        );
      }

      if (hasDomainTable) {
        this.db.run(
          `INSERT INTO domain_retention_policies (security_domain, policy_pin, activated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(security_domain) DO UPDATE SET policy_pin = excluded.policy_pin, activated_at = excluded.activated_at`,
          this.securityDomain,
          pin,
          loadedAt,
        );
      }
    });
    return this.requireActive();
  }

  /** Returns the currently active pinned retention policy for `this.securityDomain`, or null if none is active. */
  getActive(): StoredPolicy | null {
    let row: { policy_pin: string; policy_json: string; loaded_at: string; active: number } | undefined;
    if (this.hasDomainPolicyTable()) {
      row = this.db.get<{ policy_pin: string; policy_json: string; loaded_at: string; active: number }>(
        `SELECT rp.policy_pin, rp.policy_json, rp.loaded_at, 1 AS active
         FROM domain_retention_policies drp
         JOIN retention_policies rp ON rp.policy_pin = drp.policy_pin
         WHERE drp.security_domain = ?
         LIMIT 1`,
        this.securityDomain,
      );
    }
    if (!row) {
      row = this.db.get<{ policy_pin: string; policy_json: string; loaded_at: string; active: number }>(
        "SELECT policy_pin, policy_json, loaded_at, active FROM retention_policies WHERE active = 1 LIMIT 1",
      );
    }
    if (!row) return null;
    const parsed = RetentionPolicySchema.safeParse(JSON.parse(row.policy_json));
    if (!parsed.success) {
      throw new RetentionViolationError("policy-invalid", `Stored retention policy ${row.policy_pin} failed validation`);
    }
    return {
      policyPin: row.policy_pin,
      policy: parsed.data,
      loadedAt: row.loaded_at,
      active: row.active === 1,
    };
  }

  /** Returns the active policy or throws `RetentionViolationError("policy-missing")` (C6-02). */
  requireActive(): StoredPolicy {
    const active = this.getActive();
    if (!active) {
      throw new RetentionViolationError(
        "policy-missing",
        "No active classification and retention policy is loaded; data cannot be accepted until RETENTION policy is activated",
      );
    }
    return active;
  }
}
