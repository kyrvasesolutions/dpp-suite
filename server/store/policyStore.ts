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
import { canonical } from "../../src/model/canonical";
import { loadedRetentionDigest } from "../../src/model/profile";
import type { DbAdapter } from "../db/adapter";
import { createHash } from "node:crypto";

const sha256Sync = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface StoredPolicy {
  policyPin: string;
  policy: RetentionPolicy;
  loadedAt: string;
  active: boolean;
}

export class PolicyStore {
  constructor(private readonly db: DbAdapter) {}

  /**
   * Activates a pinned retention policy atomically (deactivating any earlier pin).
   *
   * Only a policy exactly as loaded from a verified, signed contract pack is accepted: the object must come out of
   * `loadProfilePack` and still have the canonical content digest recorded then. Different content under a pin the
   * database already holds is refused, so a weaker policy can never replace the signed one (C6-02).
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
        "The retention policy no longer matches the content of the signed contract pack",
      );
    }
    const pin = `${parsed.data.id}@${parsed.data.version}`;
    const serialized = JSON.stringify(parsed.data);
    this.db.transaction(() => {
      const held = this.db.get<{ policy_json: string }>("SELECT policy_json FROM retention_policies WHERE policy_pin = ?", pin);
      if (held && canonical(JSON.parse(held.policy_json)) !== canonical(parsed.data)) {
        throw new RetentionViolationError(
          "policy-conflict",
          `Retention policy ${pin} is already held with different content; a pin is immutable`,
        );
      }
      this.db.run("UPDATE retention_policies SET active = 0 WHERE active = 1");
      this.db.run(
        `INSERT INTO retention_policies (policy_pin, policy_json, loaded_at, active)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(policy_pin) DO UPDATE SET active = 1`,
        pin,
        serialized,
        loadedAt,
      );
    });
    return this.requireActive();
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
