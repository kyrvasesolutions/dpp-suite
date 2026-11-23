/**
 * Ephemeral test-only OIDC identity provider (RS256 + ES256) and contract-pack proposal builders
 * for Cycle 7 Layer 3 verification (`C7-01`..`C7-05`).
 *
 * Generates fresh RSA-2048 and EC P-256 key pairs in memory per test run — zero static private keys
 * exist anywhere in the repository (`npm run check-secrets` stays clean).
 */
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import type { JwksDocument, JwksEntry, OidcConfig } from "../../server/auth/oidc";
import type { ProposePackageInput } from "../../src/model/c7Contracts";
import type { PackSource } from "../../src/model/profile";

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export interface TestIdp {
  issuer: string;
  audience: string;
  jwks: JwksDocument;
  oidcConfig: OidcConfig;
  signRs256(claims: Record<string, unknown>, headerOverrides?: Record<string, unknown>): string;
  signEs256(claims: Record<string, unknown>, headerOverrides?: Record<string, unknown>): string;
  signAlgNone(claims: Record<string, unknown>): string;
  signHs256Confusion(claims: Record<string, unknown>): string;
  signWithUntrustedKey(claims: Record<string, unknown>): string;
}

export function createTestIdp(
  issuer = "https://idp.test.local",
  audience = "dpp-suite-api",
): TestIdp {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rogue = generateKeyPairSync("rsa", { modulusLength: 2048 });

  const rsaPub = rsa.publicKey.export({ format: "jwk" }) as JwksEntry;
  const ecPub = ec.publicKey.export({ format: "jwk" }) as JwksEntry;

  const jwks: JwksDocument = {
    keys: [
      { ...rsaPub, kid: "rsa-key-1", use: "sig", alg: "RS256" },
      { ...ecPub, kid: "ec-key-1", use: "sig", alg: "ES256" },
    ],
  };

  const oidcConfig: OidcConfig = { issuer, audience, jwks };

  const defaultClaims = (overrides: Record<string, unknown>, nowSec = Math.floor(Date.parse("2026-11-22T12:00:00.000Z") / 1000)) => ({
    iss: issuer,
    aud: audience,
    iat: nowSec - 60,
    exp: nowSec + 3600,
    ...overrides,
  });

  const signRs256 = (claims: Record<string, unknown>, headerOverrides: Record<string, unknown> = {}): string => {
    const header = { alg: "RS256", typ: "JWT", kid: "rsa-key-1", ...headerOverrides };
    const payload = defaultClaims(claims);
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = sign("sha256", Buffer.from(input, "ascii"), rsa.privateKey);
    return `${input}.${b64url(sig)}`;
  };

  const signEs256 = (claims: Record<string, unknown>, headerOverrides: Record<string, unknown> = {}): string => {
    const header = { alg: "ES256", typ: "JWT", kid: "ec-key-1", ...headerOverrides };
    const payload = defaultClaims(claims);
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = sign("sha256", Buffer.from(input, "ascii"), { key: ec.privateKey, dsaEncoding: "ieee-p1363" });
    return `${input}.${b64url(sig)}`;
  };

  const signAlgNone = (claims: Record<string, unknown>): string => {
    const header = { alg: "none", typ: "JWT" };
    const payload = defaultClaims(claims);
    return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.unsigned`;
  };

  const signHs256Confusion = (claims: Record<string, unknown>): string => {
    const header = { alg: "HS256", typ: "JWT", kid: "rsa-key-1" };
    const payload = defaultClaims(claims);
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const pubPem = rsa.publicKey.export({ type: "spki", format: "pem" });
    const mac = createHmac("sha256", pubPem).update(input, "ascii").digest();
    return `${input}.${b64url(mac)}`;
  };

  const signWithUntrustedKey = (claims: Record<string, unknown>): string => {
    const header = { alg: "RS256", typ: "JWT", kid: "rsa-key-1" };
    const payload = defaultClaims(claims);
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = sign("sha256", Buffer.from(input, "ascii"), rogue.privateKey);
    return `${input}.${b64url(sig)}`;
  };

  return { issuer, audience, jwks, oidcConfig, signRs256, signEs256, signAlgNone, signHs256Confusion, signWithUntrustedKey };
}

/**
 * Clones a `PackSource`, applies file additions/removals/edits, and recomputes every SHA-256 entry
 * in `manifest.files` cleanly to build a valid `ProposePackageInput`.
 */
export function buildPackageProposal(
  base: PackSource,
  options: {
    packageId?: string;
    version: string;
    predecessorReleaseId: string | null;
    note: string;
    profileRef?: string;
    mutateFiles?: (files: Record<string, string>) => void;
  },
): ProposePackageInput {
  const files: Record<string, string> = { ...base.files };
  options.mutateFiles?.(files);
  const manifestFiles: Record<string, string> = {};
  for (const path of Object.keys(files).sort()) {
    manifestFiles[path] = createHash("sha256").update(files[path]!).digest("hex");
  }
  return {
    packageId: options.packageId ?? "PROFILE-ALU-24-01",
    version: options.version,
    predecessorReleaseId: options.predecessorReleaseId,
    note: options.note,
    manifest: {
      pack: base.manifest.pack,
      profile: options.profileRef ?? base.manifest.profile,
      files: manifestFiles,
    },
    files,
  };
}
