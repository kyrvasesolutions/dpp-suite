/**
 * Relational user, role-grant, and live grant-epoch store with append-only audit trail
 * (C7-01, C7-02, LEAN-DEF-01, LEAN-DEF-03, EV-4, ADR-0005).
 *
 * Every role assignment, revocation, or user deactivation increments `users.grant_epoch` atomically
 * inside `BEGIN IMMEDIATE` and appends an immutable `grant_events` audit record so role changes take
 * effect immediately on the very next HTTP request without waiting for token expiry.
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

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
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

function validateReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > REASON_MAX || CONTROL_CHARS.test(trimmed)) {
    throw Object.assign(new Error(`A single-line reason of 1..${REASON_MAX} characters is required`), {
      statusCode: 400,
      code: "reason-required",
    });
  }
  return trimmed;
}

function validateSub(sub: string): string {
  const trimmed = sub.trim();
  if (!trimmed || trimmed.length > 128 || CONTROL_CHARS.test(trimmed)) {
    throw Object.assign(new Error("Invalid user subject identifier (sub)"), {
      statusCode: 400,
      code: "invalid-sub",
    });
  }
  return trimmed;
}

function validateRole(role: string): ServerRole {
  if (!(SERVER_ROLES as readonly string[]).includes(role)) {
    throw Object.assign(new Error(`Unknown role "${role}"`), { statusCode: 400, code: "invalid-role" });
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

  getUser(sub: string): UserGrantSummary | undefined {
    const row = this.db.get<UserRow>(
      "SELECT * FROM users WHERE security_domain = ? AND sub = ?",
      this.securityDomain,
      sub,
    );
    if (!row) return undefined;
    return {
      sub: row.sub,
      securityDomain: row.security_domain,
      displayName: row.display_name,
      active: Number(row.active) === 1,
      grantEpoch: Number(row.grant_epoch),
      roles: this.rolesFor(row.sub),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listUsers(): UserGrantSummary[] {
    const rows = this.db.query<UserRow>(
      "SELECT * FROM users WHERE security_domain = ? ORDER BY sub ASC",
      this.securityDomain,
    );
    return rows.map((row) => ({
      sub: row.sub,
      securityDomain: row.security_domain,
      displayName: row.display_name,
      active: Number(row.active) === 1,
      grantEpoch: Number(row.grant_epoch),
      roles: this.rolesFor(row.sub),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** Creates or reactivates a user and optionally assigns initial roles atomically. */
  upsertUser(input: {
    sub: string;
    displayName: string;
    roles?: ServerRole[];
    actorSub: string;
    reason: string;
  }): UserGrantSummary {
    const sub = validateSub(input.sub);
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > 128 || CONTROL_CHARS.test(displayName)) {
      throw Object.assign(new Error("displayName must be 1..128 printable characters"), {
        statusCode: 400,
        code: "invalid-display-name",
      });
    }
    const reason = validateReason(input.reason);
    const roles = [...new Set((input.roles ?? []).map((r) => validateRole(r)))];
    const nowIso = this.now();

    return this.db.transaction(() => {
      const existing = this.db.get<UserRow>(
        "SELECT * FROM users WHERE security_domain = ? AND sub = ?",
        this.securityDomain,
        sub,
      );
      let epoch: number;
      if (!existing) {
        epoch = 1;
        this.db.run(
          `INSERT INTO users (security_domain, sub, display_name, active, grant_epoch, created_at, updated_at)
           VALUES (?, ?, ?, 1, 1, ?, ?)`,
          this.securityDomain,
          sub,
          displayName,
          nowIso,
          nowIso,
        );
        this.appendEvent(sub, input.actorSub, "user-created", null, epoch, reason, nowIso);
      } else {
        epoch = Number(existing.grant_epoch) + 1;
        this.db.run(
          `UPDATE users SET display_name = ?, active = 1, grant_epoch = ?, updated_at = ?
           WHERE security_domain = ? AND sub = ?`,
          displayName,
          epoch,
          nowIso,
          this.securityDomain,
          sub,
        );
        if (Number(existing.active) === 0) {
          this.appendEvent(sub, input.actorSub, "user-reactivated", null, epoch, reason, nowIso);
        }
      }

      for (const role of roles) {
        const res = this.db.run(
          `INSERT OR IGNORE INTO role_grants (security_domain, sub, role, granted_by, granted_at)
           VALUES (?, ?, ?, ?, ?)`,
          this.securityDomain,
          sub,
          role,
          input.actorSub,
          nowIso,
        );
        if (res.changes > 0) {
          this.appendEvent(sub, input.actorSub, "role-assigned", role, epoch, reason, nowIso);
        }
      }
      return this.getUser(sub)!;
    });
  }

  assignRole(targetSub: string, roleInput: string, actorSub: string, reasonInput: string): UserGrantSummary {
    const sub = validateSub(targetSub);
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
        throw Object.assign(new Error(`User "${sub}" not found`), { statusCode: 404, code: "user-not-found" });
      }
      if (Number(existing.active) !== 1) {
        throw new AuthError("user-inactive", 403, `Cannot assign role to deactivated user "${sub}"`);
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

  revokeRole(targetSub: string, roleInput: string, actorSub: string, reasonInput: string): UserGrantSummary {
    const sub = validateSub(targetSub);
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
        throw Object.assign(new Error(`User "${sub}" not found`), { statusCode: 404, code: "user-not-found" });
      }
      if (role === "ADMIN" && this.activeAdminCount(sub) === 0) {
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

  deactivateUser(targetSub: string, actorSub: string, reasonInput: string): UserGrantSummary {
    const sub = validateSub(targetSub);
    const reason = validateReason(reasonInput);
    const nowIso = this.now();

    return this.db.transaction(() => {
      const existing = this.db.get<UserRow>(
        "SELECT * FROM users WHERE security_domain = ? AND sub = ?",
        this.securityDomain,
        sub,
      );
      if (!existing) {
        throw Object.assign(new Error(`User "${sub}" not found`), { statusCode: 404, code: "user-not-found" });
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

  recordLegalHoldAudit(evidenceSha256: string, actorSub: string, placed: boolean, reasonInput: string): void {
    const reason = validateReason(reasonInput);
    const nowIso = this.now();
    this.db.transaction(() => {
      const actor = this.getUser(actorSub);
      const epoch = actor?.grantEpoch ?? 1;
      this.appendEvent(
        `evidence:${evidenceSha256}`,
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
