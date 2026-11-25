/**
 * Standards-based OIDC JWT (JWS Compact) verifier using Node 24 built-in `node:crypto` (C7-01, ADR-0005).
 *
 * Strictly permits asymmetric `RS256` (RSA >= 2048-bit) and `ES256` (EC P-256 IEEE P1363) only —
 * rejects `none`, symmetric `HS*`, or unknown algorithms before key lookup. Enforces canonical
 * base64url encoding, fatal UTF-8 decoding, strict JWKS filtering (`use`/`key_ops`/`alg`),
 * finite server clock/tolerance, and exact `iss`, `aud`, `sub`, `exp`, `nbf`, `iat`, `grant_epoch`.
 * Zero third-party production npm dependencies.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { AuthError } from "../../src/model/c7Contracts";

const ALLOWED_ALGS = new Set(["RS256", "ES256"] as const);
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true });
const MAX_CLOCK_TOLERANCE_SEC = 3600;

export interface JwksEntry {
  kty: string;
  kid?: string;
  use?: string;
  key_ops?: unknown;
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
  /** Optional clock skew tolerance in seconds (default 0: strict; must be finite integer in 0..3600). */
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
  alg?: "RS256" | "ES256";
  kty: "RSA" | "EC";
  crv?: "P-256";
  key: KeyObject;
}

/** Strict canonical base64url decoder rejecting dangling `len % 4 === 1` and non-zero trailing bits. */
function decodeBase64UrlStrict(segment: string, label: string): Buffer {
  if (segment.length === 0 || segment.length % 4 === 1) {
    throw new AuthError("token-malformed", 401, `JWT ${label} is not canonical base64url`);
  }
  const buf = Buffer.from(segment, "base64url");
  if (buf.toString("base64url") !== segment) {
    throw new AuthError("token-malformed", 401, `JWT ${label} is not canonical base64url`);
  }
  return buf;
}

function decodeBase64UrlJson(segment: string, label: string): Record<string, unknown> {
  const buf = decodeBase64UrlStrict(segment, label);
  try {
    const text = FATAL_UTF8.decode(buf);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AuthError("token-malformed", 401, `JWT ${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("token-malformed", 401, `JWT ${label} is not valid UTF-8 JSON`);
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
    if (typeof config.issuer !== "string" || !config.issuer.trim() || typeof config.audience !== "string" || !config.audience.trim()) {
      throw new Error("OidcVerifier requires non-empty issuer and audience");
    }
    const rawTol = config.clockToleranceSec ?? 0;
    if (typeof rawTol !== "number" || !Number.isFinite(rawTol) || rawTol < 0 || rawTol > MAX_CLOCK_TOLERANCE_SEC) {
      throw new Error(`OidcVerifier clockToleranceSec must be a finite number in 0..${MAX_CLOCK_TOLERANCE_SEC}`);
    }
    this.toleranceSec = Math.trunc(rawTol);

    this.keys = [];
    for (const jwk of Array.isArray(config.jwks?.keys) ? config.jwks.keys : []) {
      if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) continue;
      if (jwk.use !== undefined && jwk.use !== "sig") continue;
      if (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify"))) continue;

      const isRsa = jwk.kty === "RSA";
      const isEcP256 = jwk.kty === "EC" && jwk.crv === "P-256";
      if (!isRsa && !isEcP256) continue;

      let alg: "RS256" | "ES256" | undefined;
      if (jwk.alg !== undefined) {
        if (typeof jwk.alg !== "string") continue;
        if (isRsa && jwk.alg !== "RS256") continue;
        if (isEcP256 && jwk.alg !== "ES256") continue;
        alg = jwk.alg as "RS256" | "ES256";
      }

      if (jwk.kid !== undefined && (typeof jwk.kid !== "string" || !jwk.kid)) continue;

      // Copy ONLY the public parameters specific to this key type (strip private params & mixed fields).
      let publicJwk: Record<string, string>;
      if (isRsa) {
        if (typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
        publicJwk = { kty: "RSA", n: jwk.n, e: jwk.e };
      } else {
        if (typeof jwk.x !== "string" || typeof jwk.y !== "string") continue;
        publicJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
      }

      let key: KeyObject;
      try {
        key = createPublicKey({ key: publicJwk, format: "jwk" });
      } catch {
        continue;
      }
      if (isRsa && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;

      this.keys.push({
        kid: jwk.kid,
        alg,
        kty: isRsa ? "RSA" : "EC",
        crv: isEcP256 ? "P-256" : undefined,
        key,
      });
    }
    if (this.keys.length === 0) {
      throw new Error("OidcVerifier requires at least one valid RS256 (RSA >= 2048-bit) or ES256 (EC P-256) public signing key in JWKS");
    }
  }

  /** Verifies a compact JWS bearer token strictly against the configured issuer, audience, JWKS, and server clock. */
  verifyToken(token: string, nowSec: number = Math.floor(Date.now() / 1000)): VerifiedJwtClaims {
    if (typeof nowSec !== "number" || !Number.isFinite(nowSec)) {
      throw new Error("OidcVerifier requires a finite server timestamp");
    }
    if (typeof token !== "string" || !COMPACT_JWS.test(token)) {
      throw new AuthError("token-malformed", 401, "Bearer token is not a valid compact JWS");
    }
    const [headB64, bodyB64, sigB64] = token.split(".") as [string, string, string];
    const header = decodeBase64UrlJson(headB64, "header");
    const alg = header.alg;
    if (typeof alg !== "string" || !ALLOWED_ALGS.has(alg as "RS256" | "ES256")) {
      throw new AuthError("token-algorithm-rejected", 401, "The JWT algorithm is not allowed");
    }
    if (header.crit !== undefined) {
      throw new AuthError("token-malformed", 401, "Unsupported critical JWT header extensions");
    }
    if (header.kid !== undefined && (typeof header.kid !== "string" || !header.kid || CONTROL_CHARS.test(header.kid))) {
      throw new AuthError("token-malformed", 401, "JWT kid header must be a non-empty printable string");
    }
    const kid = header.kid;

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
    const signature = decodeBase64UrlStrict(sigB64, "signature");
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
        : Array.isArray(aud) && aud.length > 0 && aud.every((a) => typeof a === "string") && aud.includes(this.config.audience);
    if (!audOk) {
      throw new AuthError("token-audience-mismatch", 401, "JWT audience does not match this service");
    }

    const sub = claims.sub;
    if (typeof sub !== "string" || !sub || sub !== sub.trim() || sub.length > 128 || CONTROL_CHARS.test(sub)) {
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
      if (claims.nbf > exp) {
        throw new AuthError("token-malformed", 401, "JWT nbf claim cannot be after exp");
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
      if (claims.iat > nowSec + this.toleranceSec) {
        throw new AuthError("token-not-yet-valid", 401, "JWT iat claim is in the future");
      }
      iat = claims.iat;
    }

    let grantEpoch: number | undefined;
    if (claims.grant_epoch !== undefined) {
      if (typeof claims.grant_epoch !== "number" || !Number.isSafeInteger(claims.grant_epoch) || claims.grant_epoch < 1) {
        throw new AuthError("token-malformed", 401, "JWT grant_epoch claim must be a positive safe integer");
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
