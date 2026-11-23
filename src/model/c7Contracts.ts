/**
 * Typed domain contracts for Cycle 7 (P03 + P04): OIDC identity, server-side RBAC with live grant
 * epochs, internal/customer surface separation, and controlled configuration package releases with
 * four-eyes approval and rollback (ADR-0005; LEAN-DEF-01, 03, 14; EV-4, EV-6).
 *
 * Pure TypeScript + Zod only (zero DOM, zero Node built-ins) so browser and server share one contract set.
 */
import { z } from "zod";

export const AUTH_MODES = ["local-dev", "oidc"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const DEPLOYMENT_SURFACES = ["all", "internal", "customer"] as const;
export type DeploymentSurface = (typeof DEPLOYMENT_SURFACES)[number];

/**
 * Explicit server-side roles (EV-4: manufacturer operator and business customer are distinct principals,
 * separated from identity admin, configuration curator, and read-only auditor).
 */
export const SERVER_ROLES = ["ACT-01", "ACT-06", "ADMIN", "CURATOR", "AUDITOR"] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];

export const SERVER_ACTIONS = [
  "import-submit",
  "record-correct",
  "record-read-internal",
  "record-read-customer",
  "release-internal",
  "release-customer",
  "evidence-read",
  "evidence-legal-hold-place",
  "evidence-legal-hold-release",
  "evidence-delete",
  "job-read",
  "job-recover",
  "log-read",
  "role-read",
  "role-manage",
  "config-read",
  "config-propose",
  "config-approve",
  "config-activate",
  "config-rollback",
  /** Cycle 8: the submitter (ACT-01, own jobs only) or an ADMIN cancels a running import job. */
  "job:cancel",
  /** Cycle 8: counters only. */
  "metrics:read",
] as const;
export type ServerAction = (typeof SERVER_ACTIONS)[number];

export const ROLE_ACTION_MATRIX: Record<ServerRole, readonly ServerAction[]> = {
  "ACT-01": [
    "import-submit",
    "record-correct",
    "record-read-internal",
    "record-read-customer",
    "release-internal",
    "release-customer",
    "evidence-read",
    "evidence-legal-hold-place",
    "job-read",
    "job-recover",
    "log-read",
    "config-read",
    "job:cancel",
  ],
  "ACT-06": ["record-read-customer", "release-customer"],
  ADMIN: [
    "record-read-internal",
    "record-read-customer",
    "evidence-read",
    "evidence-legal-hold-place",
    "evidence-legal-hold-release",
    "evidence-delete",
    "job-read",
    "job-recover",
    "log-read",
    "role-read",
    "role-manage",
    "config-read",
    "config-approve",
    "config-activate",
    "config-rollback",
    "job:cancel",
    "metrics:read",
  ],
  CURATOR: [
    "record-read-internal",
    "log-read",
    "config-read",
    "config-propose",
    "config-approve",
    "config-activate",
    "config-rollback",
  ],
  AUDITOR: ["record-read-internal", "record-read-customer", "evidence-read", "job-read", "log-read", "role-read", "config-read", "metrics:read"],
};

export interface AuthContext {
  sub: string;
  issuer: string;
  roles: ServerRole[];
  grantEpoch: number;
  securityDomain: string;
  authMode: AuthMode;
  /** Distinct principal dimensions preserved per EV-4 (`productGroup`, `legalAct`, `surface`). */
  productGroup: string;
  legalAct: string;
  surface: DeploymentSurface;
  tokenIssuedAt?: number;
  tokenExpiresAt?: number;
}

export interface AuthorizationDecision {
  permitted: boolean;
  action: ServerAction;
  roleMatched: ServerRole | null;
  deniedBy?: "surface" | "role";
  reason: string;
}

export interface UserGrantSummary {
  sub: string;
  securityDomain: string;
  displayName: string;
  active: boolean;
  grantEpoch: number;
  roles: ServerRole[];
  createdAt: string;
  updatedAt: string;
}

export interface GrantAuditEvent {
  seq: number;
  securityDomain: string;
  targetSub: string;
  actorSub: string;
  event:
    | "user-created"
    | "user-reactivated"
    | "user-deactivated"
    | "role-assigned"
    | "role-revoked"
    | "legal-hold-placed"
    | "legal-hold-released";
  role: ServerRole | null;
  grantEpoch: number;
  reason: string;
  recordedAt: string;
}

export const CONFIG_RELEASE_STATES = ["validated", "approved", "active", "superseded", "rolled_back", "rejected"] as const;
export type ConfigReleaseState = (typeof CONFIG_RELEASE_STATES)[number];

export interface ConfigPackageRelease {
  releaseId: string;
  packageId: string;
  version: string;
  securityDomain: string;
  manifestSha256: string;
  digestAlgorithm: "sha256";
  predecessorReleaseId: string | null;
  state: ConfigReleaseState;
  proposedBy: string;
  proposedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  activatedBy: string | null;
  activatedAt: string | null;
  note: string;
}

export interface ConfigPackageEvent {
  seq: number;
  releaseId: string;
  packageId: string;
  securityDomain: string;
  event: "proposed" | "approved" | "rejected" | "activated" | "superseded" | "rolled-back";
  actorSub: string;
  reason: string;
  recordedAt: string;
}

export const ProposePackageSchema = z
  .object({
    packageId: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{1,63}$/, "packageId must be a stable identifier"),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/, "version must be exact semver, never latest"),
    predecessorReleaseId: z.string().min(1).nullable().optional(),
    note: z.string().trim().min(1).max(500),
    manifest: z.object({
      pack: z.string().min(1),
      profile: z.string().min(1),
      files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
    }),
    files: z.record(z.string(), z.string()),
  })
  .strict();

export type ProposePackageInput = z.infer<typeof ProposePackageSchema>;

export class AuthError extends Error {
  override name = "AuthError";
  constructor(
    public readonly code:
      | "unauthenticated"
      | "token-malformed"
      | "token-algorithm-rejected"
      | "token-signature-invalid"
      | "token-expired"
      | "token-not-yet-valid"
      | "token-issuer-mismatch"
      | "token-audience-mismatch"
      | "user-unknown"
      | "user-inactive"
      | "grant-revoked"
      | "forbidden"
      | "surface-forbidden"
      | "self-approval-forbidden",
    public readonly statusCode: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

export class ConfigReleaseError extends Error {
  override name = "ConfigReleaseError";
  constructor(
    public readonly code:
      | "invalid-package"
      | "mutable-version-forbidden"
      | "predecessor-mismatch"
      | "not-found"
      | "invalid-state"
      | "self-approval-forbidden"
      | "retention-floor-violation"
      | "reason-required"
      | "duplicate-release",
    public readonly statusCode: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Pure single-decision action evaluator for Cycle 7 RBAC (`C7-02`, `EV-4`).
 * Evaluates surface compatibility first, then role × action matrix. Fail-closed on unknown roles/actions.
 */
export function evaluateRoleAction(ctx: Pick<AuthContext, "roles" | "surface">, action: ServerAction): AuthorizationDecision {
  if (!(DEPLOYMENT_SURFACES as readonly string[]).includes(ctx.surface)) {
    return {
      permitted: false,
      action,
      roleMatched: null,
      deniedBy: "surface",
      reason: `Unrecognized deployment surface "${String(ctx.surface)}" is rejected (fail closed)`,
    };
  }
  const customerOnlyActions: readonly ServerAction[] = ["record-read-customer", "release-customer"];
  if (ctx.surface === "customer" && !customerOnlyActions.includes(action)) {
    return {
      permitted: false,
      action,
      roleMatched: null,
      deniedBy: "surface",
      reason: `Action "${action}" is disabled on the dedicated customer deployment surface`,
    };
  }
  if (ctx.surface === "internal" && customerOnlyActions.includes(action)) {
    return {
      permitted: false,
      action,
      roleMatched: null,
      deniedBy: "surface",
      reason: `Customer output action "${action}" is disabled on the internal-only deployment surface`,
    };
  }
  const roles = Array.isArray(ctx.roles) ? ctx.roles : [];
  for (const role of roles) {
    const allowed = Object.hasOwn(ROLE_ACTION_MATRIX, role) ? ROLE_ACTION_MATRIX[role] : undefined;
    if (allowed && allowed.includes(action)) {
      return { permitted: true, action, roleMatched: role, reason: `Permitted for role ${role}` };
    }
  }
  return {
    permitted: false,
    action,
    roleMatched: null,
    deniedBy: "role",
    reason: `None of the principal's active roles (${roles.join(", ") || "none"}) may perform "${action}"`,
  };
}
