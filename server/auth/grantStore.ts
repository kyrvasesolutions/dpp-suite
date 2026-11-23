/**
 * Relational user, role-grant, and live grant-epoch store with append-only audit trail
 * (C7-01, C7-02, LEAN-DEF-01, LEAN-DEF-03, EV-4, ADR-0005).
 *
 * Every role assignment, revocation, deactivation, or reactivation increments `users.grant_epoch`
 * atomically inside `BEGIN IMMEDIATE` and appends an immutable `grant_events` audit record so role
 * changes take effect immediately on the very next HTTP request without waiting for token expiry.
 */
import {
  AuthError,
  SERVER_ROLES,
  type GrantAuditEvent,
  type ServerRole,
  type UserGrantSummary,
} from "../../src/model/c7Contracts";
import { DEFAULT_SECURITY_DOMAIN } from "../../src/model/pContracts";
import type { DbAdapter } from "../db/adapter";

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const REASON_MAX = 500;

interface UserRow {
  security_domain: string;
  sub: string;
  display_name: string;
  active: number;
  grant_epoch: number;
  created_at: string;
  updated_at: string;
}

interface UserRoleJoinRow extends UserRow {
  role: ServerRole | null;
}

interface EventRow {
  seq: number;
  security_domain: string;
  target_sub: string;
  actor_sub: string;
  event: GrantAuditEvent["event"];
  role: ServerRole | null;
  grant_epoch: number;
  reason: string;
  recorded_at: string;
}

function validateReason(reason: unknown): string {
  if (typeof reason !== "string") {
    throw Object.assign(new Error(`A single-line reason of 1..${REASON_MAX} characters is required`), {
      statusCode: 400,
      code: "reason-required",
    });
  }
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > REASON_MAX || CONTROL_CHARS.test(trimmed)) {
    throw Object.assign(new Error(`A single-line reason of 1..${REASON_MAX} characters is required`), {
      statusCode: 400,
      code: "reason-required",
    });
  }
  return trimmed;
}

function validateSub(sub: unknown, label = "user subject identifier (sub)"): string {
  if (typeof sub !== "string" || !sub || sub !== sub.trim() || sub.length > 128 || CONTROL_CHARS.test(sub)) {
    throw Object.assign(new Error(`Invalid ${label}`), {
      statusCode: 400,
      code: "invalid-sub",
    });
  }
  return sub;
}

function validateUserSub(sub: unknown): string {
  const valid = validateSub(sub);
  if (valid.startsWith("evidence:")) {
    throw Object.assign(new Error('User subject identifier (sub) cannot start with reserved prefix "evidence:"'), {
      statusCode: 400,
      code: "invalid-sub",
    });
  }
  return valid;
}

function validateDisplayName(displayName: unknown): string {
  if (typeof displayName !== "string") {
    throw Object.assign(new Error("displayName must be 1..128 printable characters"), {
      statusCode: 400,
      code: "invalid-display-name",
    });
  }
  const trimmed = displayName.trim();
  if (!trimmed || trimmed.length > 128 || CONTROL_CHARS.test(trimmed)) {
    throw Object.assign(new Error("displayName must be 1..128 printable characters"), {
      statusCode: 400,
      code: "invalid-display-name",
    });
  }
  return trimmed;
}

function validateRole(role: unknown): ServerRole {
  if (typeof role !== "string" || !(SERVER_ROLES as readonly string[]).includes(role)) {
    throw Object.assign(new Error(`Unknown role "${typeof role === "string" ? role : typeof role}"`), {
      statusCode: 400,
      code: "invalid-role",
    });
  }
  return role as ServerRole;
}

export class GrantStore {
  private readonly now: () => string;

  constructor(
    private readonly db: DbAdapter,
    public readonly securityDomain: string = DEFAULT_SECURITY_DOMAIN,
    options: { now?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private rolesFor(sub: string): ServerRole[] {
    const rows = this.db.query<{ role: ServerRole }>(
      "SELECT role FROM role_grants WHERE security_domain = ? AND sub = ? ORDER BY role ASC",
      this.securityDomain,
      sub,
    );
    return rows.map((r) => r.role);
  }

  private activeAdminCount(excludingSub?: string): number {
    const row = excludingSub
      ? this.db.get<{ n: number }>(
          `SELECT COUNT(DISTINCT rg.sub) AS n
           FROM role_grants rg
           JOIN users u ON u.security_domain = rg.security_domain AND u.sub = rg.sub
           WHERE rg.security_domain = ? AND rg.role = 'ADMIN' AND u.active = 1 AND rg.sub != ?`,
          this.securityDomain,
          excludingSub,
        )
      : this.db.get<{ n: number }>(
          `SELECT COUNT(DISTINCT rg.sub) AS n
           FROM role_grants rg
           JOIN users u ON u.security_domain = rg.security_domain AND u.sub = rg.sub
           WHERE rg.security_domain = ? AND rg.role = 'ADMIN' AND u.active = 1`,
          this.securityDomain,
        );
    return Number(row?.n ?? 0);
  }

  private appendEvent(
    targetSub: string,
    actorSub: string,
    event: GrantAuditEvent["event"],
    role: ServerRole | null,
    grantEpoch: number,
    reason: string,
    recordedAt: string,
  ): void {
    this.db.run(
      `INSERT INTO grant_events (security_domain, target_sub, actor_sub, event, role, grant_epoch, reason, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      this.securityDomain,
      targetSub,
      actorSub,
      event,
      role,
      grantEpoch,
      reason,
      recordedAt,
    );
  }

  /** Atomic single-statement read of a user and all active roles so epoch and roles never split across WAL transactions. */
  getUser(sub: string): UserGrantSummary | undefined {
    const rows = this.db.query<UserRoleJoinRow>(
      `SELECT u.security_domain, u.sub, u.display_name, u.active, u.grant_epoch, u.created_at, u.updated_at, rg.role
       FROM users u
       LEFT JOIN role_grants rg ON rg.security_domain = u.security_domain AND rg.sub = u.sub
       WHERE u.security_domain = ? AND u.sub = ?
       ORDER BY rg.role ASC`,
      this.securityDomain,
      sub,
    );
    if (rows.length === 0) return undefined;
    const first = rows[0]!;
    return {
      sub: first.sub,
      securityDomain: first.security_domain,
      displayName: first.display_name,
      active: Number(first.active) === 1,
      grantEpoch: Number(first.grant_epoch),
      roles: rows.map((r) => r.role).filter((r): r is ServerRole => r !== null),
      createdAt: first.created_at,
      updatedAt: first.updated_at,
    };
  }

  listUsers(): UserGrantSummary[] {
    const rows = this.db.query<UserRoleJoinRow>(
      `SELECT u.security_domain, u.sub, u.display_name, u.active, u.grant_epoch, u.created_at, u.updated_at, rg.role
       FROM users u
       LEFT JOIN role_grants rg ON rg.security_domain = u.security_domain AND rg.sub = u.sub
       WHERE u.security_domain = ?
       ORDER BY u.sub ASC, rg.role ASC`,
      this.securityDomain,
    );
    const bySub = new Map<string, UserGrantSummary>();
    for (const row of rows) {
      let summary = bySub.get(row.sub);
      if (!summary) {
        summary = {
          sub: row.sub,
          securityDomain: row.security_domain,
          displayName: row.display_name,
          active: Number(row.active) === 1,
          grantEpoch: Number(row.grant_epoch),
          roles: [],
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
        bySub.set(row.sub, summary);
      }
      if (row.role !== null) summary.roles.push(row.role);
    }
    return [...bySub.values()];
  }

  /** Creates or reactivates a user and optionally assigns initial roles atomically. */
  upsertUser(input: {
    sub: string;
    displayName: string;
    roles?: ServerRole[];
    actorSub: string;
    reason: string;
  }): UserGrantSummary {
    const sub = validateUserSub(input.sub);
    const actorSub = validateSub(input.actorSub, "actor subject identifier");
    const displayName = validateDisplayName(input.displayName);
    const reason = validateReason(input.reason);
    if (input.roles !== undefined && !Array.isArray(input.roles)) {
      throw Object.assign(new Error("roles must be an array of valid role names"), {
        statusCode: 400,
        code: "invalid-role",
      });
    }
    const roles = [...new Set((input.roles ?? []).map((r) => validateRole(r)))];
    const nowIso = this.now();

    return this.db.transaction(() => {
      const existing = this.db.get<UserRow>(
        "SELECT * FROM users WHERE security_domain = ? AND sub = ?",
        this.securityDomain,
        sub,
      );
      if (!existing) {
        const epoch = 1;
        this.db.run(
          `INSERT INTO users (security_domain, sub, display_name, active, grant_epoch, created_at, updated_at)
           VALUES (?, ?, ?, 1, 1, ?, ?)`,
          this.securityDomain,
          sub,
          displayName,
          nowIso,
          nowIso,
        );
        this.appendEvent(sub, actorSub, "user-created", null, epoch, reason, nowIso);
        for (const role of roles) {
          this.db.run(
            `INSERT OR IGNORE INTO role_grants (security_domain, sub, role, granted_by, granted_at)
             VALUES (?, ?, ?, ?, ?)`,
            this.securityDomain,
            sub,
            role,
            actorSub,
            nowIso,
          );
          this.appendEvent(sub, actorSub, "role-assigned", role, epoch, reason, nowIso);
        }
        return this.getUser(sub)!;
      }

      const wasInactive = Number(existing.active) === 0;
      const addedRoles: ServerRole[] = [];
      for (const role of roles) {
        const res = this.db.run(
          `INSERT OR IGNORE INTO role_grants (security_domain, sub, role, granted_by, granted_at)
           VALUES (?, ?, ?, ?, ?)`,
          this.securityDomain,
          sub,
          role,
          actorSub,
          nowIso,
        );
        if (res.changes > 0) addedRoles.push(role);
      }

      // Only bump grant_epoch when activation state or granted roles actually changed (every bump is audited).
      if (wasInactive || addedRoles.length > 0) {
        const nextEpoch = Number(existing.grant_epoch) + 1;
        this.db.run(
          `UPDATE users SET display_name = ?, active = 1, grant_epoch = ?, updated_at = ?
           WHERE security_domain = ? AND sub = ?`,
          displayName,
          nextEpoch,
          nowIso,
          this.securityDomain,
          sub,
        );
        if (wasInactive) {
          this.appendEvent(sub, actorSub, "user-reactivated", null, nextEpoch, reason, nowIso);
        }
        for (const role of addedRoles) {
          this.appendEvent(sub, actorSub, "role-assigned", role, nextEpoch, reason, nowIso);
        }
      } else if (existing.display_name !== displayName) {
        this.db.run(
          `UPDATE users SET display_name = ?, updated_at = ?
           WHERE security_domain = ? AND sub = ?`,
          displayName,
          nowIso,
          this.securityDomain,
          sub,
        );
      }

      return this.getUser(sub)!;
    });
  }

  assignRole(targetSub: string, roleInput: string, actorSubInput: string, reasonInput: string): UserGrantSummary {
    const sub = validateUserSub(targetSub);
    const actorSub = validateSub(actorSubInput, "actor subject identifier");
    const role = validateRole(roleInput);
    const reason = validateReason(reasonInput);
    const nowIso = this.now();

    return this.db.transaction(() => {
      const existing = this.db.get<UserRow>(
        "SELECT * FROM users WHERE security_domain = ? AND sub = ?",
        this.securityDomain,
        sub,
      );
      if (!existing) {
        throw Object.assign(new Error("User not found"), { statusCode: 404, code: "user-not-found" });
      }
      if (Number(existing.active) !== 1) {
        throw new AuthError("user-inactive", 403, "Cannot assign a role to a deactivated user");
      }
      const nextEpoch = Number(existing.grant_epoch) + 1;
      const inserted = this.db.run(
        `INSERT OR IGNORE INTO role_grants (security_domain, sub, role, granted_by, granted_at)
         VALUES (?, ?, ?, ?, ?)`,
        this.securityDomain,
        sub,
        role,
        actorSub,
        nowIso,
      );
      if (inserted.changes > 0) {
        this.db.run(
          "UPDATE users SET grant_epoch = ?, updated_at = ? WHERE security_domain = ? AND sub = ?",
          nextEpoch,
          nowIso,
          this.securityDomain,
          sub,
        );
        this.appendEvent(sub, actorSub, "role-assigned", role, nextEpoch, reason, nowIso);
      }
      return this.getUser(sub)!;
    });
  }

  revokeRole(targetSub: string, roleInput: string, actorSubInput: string, reasonInput: string): UserGrantSummary {
    const sub = validateUserSub(targetSub);
    const actorSub = validateSub(actorSubInput, "actor subject identifier");
    const role = validateRole(roleInput);
    const reason = validateReason(reasonInput);
    const nowIso = this.now();

    return this.db.transaction(() => {
      const existing = this.db.get<UserRow>(
        "SELECT * FROM users WHERE security_domain = ? AND sub = ?",
        this.securityDomain,
        sub,
      );
      if (!existing) {
        throw Object.assign(new Error("User not found"), { statusCode: 404, code: "user-not-found" });
      }
      const currentRoles = this.rolesFor(sub);
      if (Number(existing.active) === 1 && role === "ADMIN" && currentRoles.includes("ADMIN") && this.activeAdminCount(sub) === 0) {
        throw Object.assign(new Error("Cannot revoke the last active ADMIN role in this domain"), {
          statusCode: 409,
          code: "last-admin-protected",
        });
      }
      const deleted = this.db.run(
        "DELETE FROM role_grants WHERE security_domain = ? AND sub = ? AND role = ?",
        this.securityDomain,
        sub,
        role,
      );
      if (deleted.changes > 0) {
        const nextEpoch = Number(existing.grant_epoch) + 1;
        this.db.run(
          "UPDATE users SET grant_epoch = ?, updated_at = ? WHERE security_domain = ? AND sub = ?",
          nextEpoch,
          nowIso,
          this.securityDomain,
          sub,
        );
        this.appendEvent(sub, actorSub, "role-revoked", role, nextEpoch, reason, nowIso);
      }
      return this.getUser(sub)!;
    });
  }

  deactivateUser(targetSub: string, actorSubInput: string, reasonInput: string): UserGrantSummary {
    const sub = validateUserSub(targetSub);
    const actorSub = validateSub(actorSubInput, "actor subject identifier");
    const reason = validateReason(reasonInput);
    const nowIso = this.now();

    return this.db.transaction(() => {
      const existing = this.db.get<UserRow>(
        "SELECT * FROM users WHERE security_domain = ? AND sub = ?",
        this.securityDomain,
        sub,
      );
      if (!existing) {
        throw Object.assign(new Error("User not found"), { statusCode: 404, code: "user-not-found" });
      }
      if (Number(existing.active) === 0) {
        return this.getUser(sub)!;
      }
      const currentRoles = this.rolesFor(sub);
      if (currentRoles.includes("ADMIN") && this.activeAdminCount(sub) === 0) {
        throw Object.assign(new Error("Cannot deactivate the last active ADMIN user in this domain"), {
          statusCode: 409,
          code: "last-admin-protected",
        });
      }
      const nextEpoch = Number(existing.grant_epoch) + 1;
      this.db.run("DELETE FROM role_grants WHERE security_domain = ? AND sub = ?", this.securityDomain, sub);
      this.db.run(
        "UPDATE users SET active = 0, grant_epoch = ?, updated_at = ? WHERE security_domain = ? AND sub = ?",
        nextEpoch,
        nowIso,
        this.securityDomain,
        sub,
      );
      this.appendEvent(sub, actorSub, "user-deactivated", null, nextEpoch, reason, nowIso);
      return this.getUser(sub)!;
    });
  }

  recordLegalHoldAudit(evidenceSha256: string, actorSubInput: string, placed: boolean, reasonInput: string): void {
    if (typeof evidenceSha256 !== "string" || !SHA256_HEX.test(evidenceSha256)) {
      throw Object.assign(new Error("Invalid evidence SHA-256 digest"), {
        statusCode: 400,
        code: "invalid-sha256",
      });
    }
    const sha = evidenceSha256.toLowerCase();
    const actorSub = validateSub(actorSubInput, "actor subject identifier");
    const reason = validateReason(reasonInput);
    const nowIso = this.now();
    this.db.transaction(() => {
      const actor = this.getUser(actorSub);
      const epoch = actor?.grantEpoch ?? 1;
      this.appendEvent(
        `evidence:${sha}`,
        actorSub,
        placed ? "legal-hold-placed" : "legal-hold-released",
        null,
        epoch,
        reason,
        nowIso,
      );
    });
  }

  listAuditEvents(): GrantAuditEvent[] {
    const rows = this.db.query<EventRow>(
      "SELECT * FROM grant_events WHERE security_domain = ? ORDER BY seq ASC",
      this.securityDomain,
    );
    return rows.map((r) => ({
      seq: Number(r.seq),
      securityDomain: r.security_domain,
      targetSub: r.target_sub,
      actorSub: r.actor_sub,
      event: r.event,
      role: r.role,
      grantEpoch: Number(r.grant_epoch),
      reason: r.reason,
      recordedAt: r.recorded_at,
    }));
  }
}
