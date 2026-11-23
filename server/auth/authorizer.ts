/**
 * Server-side authentication and Policy Decision Point / Policy Enforcement Point boundary
 * (C7-01, C7-02, C7-03, LEAN-DEF-01, LEAN-DEF-03, EV-4, ADR-0005).
 *
 * Every protected HTTP request flows through `authenticateRequest` -> `authorizeRequest` so direct
 * API calls can never bypass role, field, action, or deployment-surface rules, and grant revocations
 * take effect immediately on the very next request.
 */
import type { IncomingMessage } from "node:http";
import {
  AuthError,
  evaluateRoleAction,
  type AuthContext,
  type AuthMode,
  type DeploymentSurface,
  type ServerAction,
} from "../../src/model/c7Contracts";
import type { DbAdapter } from "../db/adapter";
import { GrantStore } from "./grantStore";
import type { OidcVerifier } from "./oidc";

export interface AuthRuntimeConfig {
  mode: AuthMode;
  surface: DeploymentSurface;
  oidcVerifier?: OidcVerifier;
  now?: () => string;
}

const BEARER_PREFIX = /^Bearer\s+(\S+)$/;

/**
 * Resolves the authenticated principal for an HTTP request.
 * - In `oidc` mode: verifies the signed Bearer JWT and loads live active roles + `grant_epoch` from SQLite.
 * - In `local-dev` mode: returns a single local loopback operator (`ACT-01` only — never `ADMIN` or `CURATOR`).
 */
export function authenticateRequest(
  req: IncomingMessage,
  db: DbAdapter,
  securityDomain: string,
  config: AuthRuntimeConfig,
): AuthContext {
  if (config.mode === "local-dev") {
    return {
      sub: "local-operator",
      issuer: "local-dev",
      roles: ["ACT-01"],
      grantEpoch: 1,
      securityDomain,
      authMode: "local-dev",
      productGroup: "aluminium-sheet",
      legalAct: "ESPR",
      surface: config.surface,
    };
  }

  if (!config.oidcVerifier) {
    throw new AuthError("unauthenticated", 401, "OIDC mode is enabled but no OIDC verifier is configured");
  }

  const header = typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
  const match = BEARER_PREFIX.exec(header);
  if (!match) {
    throw new AuthError("unauthenticated", 401, "Authorization: Bearer <token> header is required");
  }

  const nowMs = Date.parse((config.now ?? (() => new Date().toISOString()))());
  if (!Number.isFinite(nowMs)) {
    throw new Error("Server clock produced an invalid timestamp");
  }
  const nowSec = Math.floor(nowMs / 1000);
  const claims = config.oidcVerifier.verifyToken(match[1]!, nowSec);

  const grants = new GrantStore(db, securityDomain, { now: config.now });
  const user = grants.getUser(claims.sub);
  if (!user) {
    throw new AuthError(
      "user-unknown",
      403,
      "The authenticated subject has no provisioned user record in this security domain",
    );
  }
  if (!user.active) {
    throw new AuthError("user-inactive", 403, "The user has been deactivated");
  }
  if (
    claims.grantEpoch !== undefined &&
    (!Number.isSafeInteger(claims.grantEpoch) || claims.grantEpoch !== user.grantEpoch)
  ) {
    throw new AuthError(
      "grant-revoked",
      403,
      "The token grant epoch does not match the live grant epoch",
    );
  }

  return {
    sub: user.sub,
    issuer: claims.iss,
    roles: user.roles,
    grantEpoch: user.grantEpoch,
    securityDomain,
    authMode: "oidc",
    productGroup: "aluminium-sheet",
    legalAct: "ESPR",
    surface: config.surface,
    tokenIssuedAt: claims.iat,
    tokenExpiresAt: claims.exp,
  };
}

/** Single server-side PDP enforcement helper for every HTTP endpoint (`C7-02`, `C7-03`). */
export function authorizeRequest(
  req: IncomingMessage,
  db: DbAdapter,
  securityDomain: string,
  config: AuthRuntimeConfig,
  action: ServerAction,
  /** The principal already resolved for this very request (the rate limiter needs the subject first); never carried across requests. */
  preAuthenticated?: AuthContext,
): AuthContext {
  const ctx = preAuthenticated ?? authenticateRequest(req, db, securityDomain, config);
  const decision = evaluateRoleAction(ctx, action);
  if (!decision.permitted) {
    throw new AuthError(decision.deniedBy === "surface" ? "surface-forbidden" : "forbidden", 403, decision.reason);
  }
  return ctx;
}
