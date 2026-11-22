/**
 * Active classification and retention policy registry stored in the relational database (C6-02, C6-05).
 *
 * Refuses ingest and evidence storage until a valid pinned `RETENTION@x.y.z` policy has been loaded
 * and activated in the store (`require_policy_before_ingest: true`).
 */
import {
  RetentionPolicySchema,
  RetentionViolationError,
  type RetentionPolicy,
} from "../../src/model/pContracts";
import type { DbAdapter } from "../db/adapter";

export interface StoredPolicy {
  policyPin: string;
  policy: RetentionPolicy;
  loadedAt: string;
  active: boolean;
}

export class PolicyStore {
  constructor(private readonly db: DbAdapter) {}

  /** Validates and activates a pinned retention policy atomically (deactivating any earlier pin). */
  activate(policy: RetentionPolicy, loadedAt: string = new Date().toISOString()): StoredPolicy {
    const parsed = RetentionPolicySchema.safeParse(policy);
    if (!parsed.success) {
      throw new RetentionViolationError(
        "policy-invalid",
        `Invalid retention policy: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
      );
    }
    const pin = `${parsed.data.id}@${parsed.data.version}`;
    const serialized = JSON.stringify(parsed.data);
    this.db.transaction(() => {
      this.db.run("UPDATE retention_policies SET active = 0 WHERE active = 1");
      this.db.run(
        `INSERT INTO retention_policies (policy_pin, policy_json, loaded_at, active)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(policy_pin) DO UPDATE SET policy_json = excluded.policy_json, loaded_at = excluded.loaded_at, active = 1`,
        pin,
        serialized,
        loadedAt,
      );
    });
    return { policyPin: pin, policy: parsed.data, loadedAt, active: true };
  }

  /** Returns the currently active pinned retention policy, or null if none has been activated yet. */
  getActive(): StoredPolicy | null {
    const row = this.db.get<{ policy_pin: string; policy_json: string; loaded_at: string; active: number }>(
      "SELECT policy_pin, policy_json, loaded_at, active FROM retention_policies WHERE active = 1 LIMIT 1",
    );
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
