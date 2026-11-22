/**
 * Standards-based OIDC JWT (JWS Compact) verifier using Node 24 built-in `node:crypto` (C7-01, ADR-0005).
 *
 * Strictly permits asymmetric `RS256` and `ES256` only — rejects `none`, symmetric `HS*`, or unknown
 * algorithms before key lookup. Validates exact `iss`, `aud`, `sub`, `exp`, `nbf`, and `iat` against
 * a configured JSON Web Key Set (JWKS). Zero third-party production npm dependencies.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { AuthError } from "../../src/model/c7Contracts";

const ALLOWED_ALGS = new Set(["RS256", "ES256"] as const);
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface JwksEntry {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  [extra: string]: unknown;
}

export interface JwksDocument {
  keys: JwksEntry[];
}

export interface OidcConfig {
  issuer: string;
  audience: string;
  jwks: JwksDocument;
  /** Optional clock skew tolerance in seconds (default 0: strict). */
  clockToleranceSec?: number;
}

export interface VerifiedJwtClaims {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  /** Optional grant epoch embedded by the IdP; compared against live DB grant_epoch if present. */
  grantEpoch?: number;
  email?: string;
  name?: string;
}

interface ParsedKey {
  kid?: string;
  alg?: string;
  kty: string;
  crv?: string;
  key: KeyObject;
}

function decodeBase64UrlJson(segment: string, label: string): Record<string, unknown> {
  try {
    const text = Buffer.from(segment, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AuthError("token-malformed", 401, `JWT ${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("token-malformed", 401, `JWT ${label} is not valid base64url JSON`);
  }
}

export function loadJwksFromFile(path: string): JwksDocument {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { keys?: unknown }).keys)) {
    throw new Error(`JWKS file ${path} must contain a JSON object with a "keys" array`);
  }
  return raw as JwksDocument;
}

export class OidcVerifier {
  private readonly keys: ParsedKey[];
  private readonly toleranceSec: number;

  constructor(private readonly config: OidcConfig) {
    if (!config.issuer.trim() || !config.audience.trim()) {
      throw new Error("OidcVerifier requires non-empty issuer and audience");
    }
    this.toleranceSec = Math.max(0, Math.trunc(config.clockToleranceSec ?? 0));
    this.keys = [];
    for (const jwk of config.jwks.keys ?? []) {
      if (jwk.use && jwk.use !== "sig") continue;
      if (jwk.kty !== "RSA" && !(jwk.kty === "EC" && jwk.crv === "P-256")) continue;
      // Strip any accidental private parameters so only the public key is imported
      const publicJwk: Record<string, string> = {
        kty: jwk.kty,
        ...(typeof jwk.n === "string" ? { n: jwk.n } : {}),
        ...(typeof jwk.e === "string" ? { e: jwk.e } : {}),
        ...(typeof jwk.crv === "string" ? { crv: jwk.crv } : {}),
        ...(typeof jwk.x === "string" ? { x: jwk.x } : {}),
        ...(typeof jwk.y === "string" ? { y: jwk.y } : {}),
      };
      const key = createPublicKey({ key: publicJwk, format: "jwk" });
      if (jwk.kty === "RSA" && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
      this.keys.push({
        kid: typeof jwk.kid === "string" ? jwk.kid : undefined,
        alg: typeof jwk.alg === "string" ? jwk.alg : undefined,
        kty: jwk.kty,
        crv: typeof jwk.crv === "string" ? jwk.crv : undefined,
        key,
      });
    }
    if (this.keys.length === 0) {
      throw new Error("OidcVerifier requires at least one valid RS256 (RSA) or ES256 (EC P-256) public signing key in JWKS");
    }
  }

  /** Verifies a compact JWS bearer token strictly against the configured issuer, audience, JWKS, and server clock. */
  verifyToken(token: string, nowSec: number = Math.floor(Date.now() / 1000)): VerifiedJwtClaims {
    if (typeof token !== "string" || !COMPACT_JWS.test(token)) {
      throw new AuthError("token-malformed", 401, "Bearer token is not a valid compact JWS");
    }
    const [headB64, bodyB64, sigB64] = token.split(".") as [string, string, string];
    const header = decodeBase64UrlJson(headB64, "header");
    const alg = header.alg;
    if (typeof alg !== "string" || !ALLOWED_ALGS.has(alg as "RS256" | "ES256")) {
      throw new AuthError("token-algorithm-rejected", 401, `JWT algorithm "${String(alg)}" is not allowed`);
    }
    if (header.crit !== undefined) {
      throw new AuthError("token-malformed", 401, "Unsupported critical JWT header extensions");
    }
    const kid = typeof header.kid === "string" ? header.kid : undefined;

    const candidates = this.keys.filter((k) => {
      if (alg === "RS256" && k.kty !== "RSA") return false;
      if (alg === "ES256" && !(k.kty === "EC" && k.crv === "P-256")) return false;
      if (k.alg && k.alg !== alg) return false;
      if (kid !== undefined) return k.kid === kid;
      return this.keys.length === 1;
    });
    if (candidates.length === 0) {
      throw new AuthError("token-signature-invalid", 401, "No matching signing key found in JWKS");
    }

    const signingInput = Buffer.from(`${headB64}.${bodyB64}`, "ascii");
    const signature = Buffer.from(sigB64, "base64url");
    if (alg === "ES256" && signature.length !== 64) {
      throw new AuthError("token-signature-invalid", 401, "Invalid ES256 signature length");
    }

    let validSig = false;
    for (const candidate of candidates) {
      const ok =
        alg === "ES256"
          ? verify("sha256", signingInput, { key: candidate.key, dsaEncoding: "ieee-p1363" }, signature)
          : verify("sha256", signingInput, candidate.key, signature);
      if (ok) {
        validSig = true;
        break;
      }
    }
    if (!validSig) {
      throw new AuthError("token-signature-invalid", 401, "JWT signature verification failed");
    }

    const claims = decodeBase64UrlJson(bodyB64, "payload");

    if (claims.iss !== this.config.issuer) {
      throw new AuthError("token-issuer-mismatch", 401, "JWT issuer does not match configured identity provider");
    }

    const aud = claims.aud;
    const audOk =
      typeof aud === "string"
        ? aud === this.config.audience
        : Array.isArray(aud) && aud.every((a) => typeof a === "string") && aud.includes(this.config.audience);
    if (!audOk) {
      throw new AuthError("token-audience-mismatch", 401, "JWT audience does not match this service");
    }

    const sub = claims.sub;
    if (typeof sub !== "string" || !sub.trim() || sub.length > 128 || CONTROL_CHARS.test(sub)) {
      throw new AuthError("token-malformed", 401, "JWT subject (sub) claim is missing or invalid");
    }

    const exp = claims.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) {
      throw new AuthError("token-malformed", 401, "JWT exp claim is required and must be a finite number");
    }
    if (nowSec - this.toleranceSec >= exp) {
      throw new AuthError("token-expired", 401, "JWT has expired");
    }

    let nbf: number | undefined;
    if (claims.nbf !== undefined) {
      if (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf)) {
        throw new AuthError("token-malformed", 401, "JWT nbf claim must be a finite number");
      }
      if (nowSec + this.toleranceSec < claims.nbf) {
        throw new AuthError("token-not-yet-valid", 401, "JWT is not valid yet (nbf)");
      }
      nbf = claims.nbf;
    }

    let iat: number | undefined;
    if (claims.iat !== undefined) {
      if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) {
        throw new AuthError("token-malformed", 401, "JWT iat claim must be a finite number");
      }
      if (claims.iat > nowSec + Math.max(this.toleranceSec, 300)) {
        throw new AuthError("token-not-yet-valid", 401, "JWT iat claim is too far in the future");
      }
      iat = claims.iat;
    }

    let grantEpoch: number | undefined;
    if (claims.grant_epoch !== undefined) {
      if (typeof claims.grant_epoch !== "number" || !Number.isInteger(claims.grant_epoch) || claims.grant_epoch < 1) {
        throw new AuthError("token-malformed", 401, "JWT grant_epoch claim must be a positive integer");
      }
      grantEpoch = claims.grant_epoch;
    }

    return {
      sub,
      iss: claims.iss,
      aud: aud as string | string[],
      exp,
      ...(iat !== undefined ? { iat } : {}),
      ...(nbf !== undefined ? { nbf } : {}),
      ...(grantEpoch !== undefined ? { grantEpoch } : {}),
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      ...(typeof claims.name === "string" ? { name: claims.name } : {}),
    };
  }
}
