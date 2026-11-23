// @vitest-environment node
/**
 * Cycle 7 Layer 3 (`AT-X` adversarial privilege-escalation charter, `C7-01`, `C7-02`, `C7-04`):
 * Codifies every JWT forgery, algorithm confusion, unknown/deactivated subject, cross-domain
 * spoofing, horizontal/vertical privilege escalation, four-eyes bypass, last-ADMIN lockout,
 * unauthenticated non-loopback startup, and SQLite audit-trigger tampering attempt.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readPack } from "../../config/contractPack";
import { GrantStore } from "../../server/auth/grantStore";
import { SqliteAdapter } from "../../server/db/adapter";
import { migrateUp } from "../../server/db/migrations";
import { createDppServer } from "../../server/http/api";
import { ConfigReleaseStore } from "../../server/releases/configReleaseStore";
import { PolicyStore } from "../../server/store/policyStore";
import type { PackSource, ProfilePack } from "../../src/model/profile";
import { buildPackageProposal, createTestIdp } from "../support/oidc";
import { loadPack } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const tmpDir = mkdtempSync(join(tmpdir(), "dpp-c7-atx-"));
const idp = createTestIdp();
const NOW = "2026-11-22T12:00:00.000Z";
const NOW_SEC = Math.floor(Date.parse(NOW) / 1000);

let pack: ProfilePack;
let packSource: PackSource;
let db: SqliteAdapter;
let baseUrl: string;
let localDevUrl: string;
let closeOidc: () => Promise<void>;
let closeLocal: () => Promise<void>;
let initialReleaseId: string;

beforeAll(async () => {
  packSource = readPack("contracts/n");
  pack = await loadPack();
  db = new SqliteAdapter({ path: join(tmpDir, "atx.sqlite") });
  migrateUp(db);
  new PolicyStore(db).activate(pack.policy.retention, NOW);

  const cfgStore = new ConfigReleaseStore(db, undefined, { now: () => NOW });
  const initial = await cfgStore.bootstrapActivePack(packSource, pack.id, pack.version);
  initialReleaseId = initial.releaseId;

  const grants = new GrantStore(db, undefined, { now: () => NOW });
  grants.upsertUser({ sub: "sole-admin", displayName: "Sole Admin", roles: ["ADMIN"], actorSub: "bootstrap", reason: "Initial sole admin" });
  grants.upsertUser({ sub: "op-1", displayName: "Operator", roles: ["ACT-01"], actorSub: "sole-admin", reason: "Seed operator" });
  grants.upsertUser({ sub: "cust-1", displayName: "Customer", roles: ["ACT-06"], actorSub: "sole-admin", reason: "Seed customer" });
  grants.upsertUser({ sub: "cur-1", displayName: "Curator 1", roles: ["CURATOR"], actorSub: "sole-admin", reason: "Seed curator" });

  const oidcServer = createDppServer({
    db,
    pack,
    software: TEST_SOFTWARE,
    authMode: "oidc",
    surface: "all",
    oidc: idp.oidcConfig,
    now: () => NOW,
  });
  await new Promise<void>((resolve) => oidcServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(oidcServer.address() as AddressInfo).port}`;
  closeOidc = () => new Promise((resolve, reject) => oidcServer.close((e) => (e ? reject(e) : resolve())));

  const localServer = createDppServer({
    db,
    pack,
    software: TEST_SOFTWARE,
    authMode: "local-dev",
    surface: "all",
    now: () => NOW,
  });
  await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
  localDevUrl = `http://127.0.0.1:${(localServer.address() as AddressInfo).port}`;
  closeLocal = () => new Promise((resolve, reject) => localServer.close((e) => (e ? reject(e) : resolve())));
});

afterAll(async () => {
  await closeOidc();
  await closeLocal();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Cycle 7 AT-X privilege-escalation & token-forgery resistance", () => {
  it("refuses every forged, unsigned, confused-algorithm, tampered, expired, or mismatched JWT with 401", async () => {
    const valid = idp.signRs256({ sub: "sole-admin" });
    const [h, , s] = valid.split(".")!;
    const tamperedPayload = Buffer.from(
      JSON.stringify({ iss: idp.issuer, aud: idp.audience, sub: "sole-admin", exp: NOW_SEC + 99999 }),
    ).toString("base64url");
    const tampered = `${h}.${tamperedPayload}.${s}`;

    const badTokens: Array<[string, string | null, string]> = [
      ["missing header", null, "unauthenticated"],
      ["alg:none unsigned", idp.signAlgNone({ sub: "sole-admin" }), "token-algorithm-rejected"],
      ["HS256 key confusion", idp.signHs256Confusion({ sub: "sole-admin" }), "token-algorithm-rejected"],
      ["tampered payload", tampered, "token-signature-invalid"],
      ["untrusted RSA signing key", idp.signWithUntrustedKey({ sub: "sole-admin" }), "token-signature-invalid"],
      ["expired token", idp.signRs256({ sub: "sole-admin", exp: NOW_SEC - 1 }), "token-expired"],
      ["future nbf", idp.signRs256({ sub: "sole-admin", nbf: NOW_SEC + 60 }), "token-not-yet-valid"],
      ["far-future iat", idp.signRs256({ sub: "sole-admin", iat: NOW_SEC + 3600 }), "token-not-yet-valid"],
      ["wrong issuer", idp.signRs256({ sub: "sole-admin", iss: "https://evil.example" }), "token-issuer-mismatch"],
      ["wrong audience", idp.signRs256({ sub: "sole-admin", aud: "other-service" }), "token-audience-mismatch"],
      ["unsupported crit header", idp.signRs256({ sub: "sole-admin" }, { crit: ["exp"] }), "token-malformed"],
      ["unknown kid", idp.signRs256({ sub: "sole-admin" }, { kid: "nonexistent-key" }), "token-signature-invalid"],
      ["non-compact garbage", "not.a.valid.jwt.token", "token-malformed"],
    ];

    for (const [label, tok, expectedCode] of badTokens) {
      const headers: Record<string, string> = tok ? { Authorization: `Bearer ${tok}` } : {};
      const res = await fetch(`${baseUrl}/api/records`, { headers });
      expect(res.status, label).toBe(401);
      expect(res.headers.get("www-authenticate"), label).toContain("Bearer");
      expect(((await res.json()) as { code: string }).code, label).toBe(expectedCode);
    }

    // Valid IdP token for unprovisioned subject or spoofed security domain -> 403 user-unknown
    const ghostTok = idp.signRs256({ sub: "unprovisioned-user" });
    const ghostRes = await fetch(`${baseUrl}/api/records`, { headers: { Authorization: `Bearer ${ghostTok}` } });
    expect(ghostRes.status).toBe(403);
    expect(((await ghostRes.json()) as { code: string }).code).toBe("user-unknown");

    const spoofDomainRes = await fetch(`${baseUrl}/api/records`, {
      headers: { Authorization: `Bearer ${valid}`, "X-Security-Domain": "other-tenant" },
    });
    expect(spoofDomainRes.status).toBe(403);
    expect(((await spoofDomainRes.json()) as { code: string }).code).toBe("user-unknown");
  });

  it("blocks vertical/horizontal escalation, local-dev admin writes, non-loopback local-dev bind, self-approval, and last-ADMIN lockout", async () => {
    const opTok = idp.signRs256({ sub: "op-1" });
    const custTok = idp.signEs256({ sub: "cust-1" });
    const curTok = idp.signRs256({ sub: "cur-1" });
    const adminTok = idp.signRs256({ sub: "sole-admin" });

    // Operator cannot self-escalate to ADMIN
    const selfEsc = await fetch(`${baseUrl}/api/admin/users/op-1/roles`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opTok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "ADMIN", reason: "Escalation attempt" }),
    });
    expect(selfEsc.status).toBe(403);

    // Customer cannot call internal admin or config endpoints
    const custEsc = await fetch(`${baseUrl}/api/config-releases/propose`, {
      method: "POST",
      headers: { Authorization: `Bearer ${custTok}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(custEsc.status).toBe(403);

    // Unauthenticated local-dev cannot touch admin or config-release mutation endpoints
    expect(
      (
        await fetch(`${localDevUrl}/api/admin/users`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sub: "rogue", displayName: "Rogue", roles: ["ADMIN"], reason: "Local escalation" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${localDevUrl}/api/config-releases/propose`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(403);

    // Fail-closed startup guards: non-loopback local-dev and missing OIDC config both throw
    expect(() => createDppServer({ db, pack, host: "0.0.0.0", authMode: "local-dev" })).toThrow(/non-loopback/i);
    expect(() => createDppServer({ db, pack, host: "192.168.1.50", authMode: "local-dev" })).toThrow(/non-loopback/i);
    expect(() => createDppServer({ db, pack, authMode: "oidc" })).toThrow(/OIDC configuration/i);

    // Last active ADMIN cannot revoke own ADMIN role or deactivate self
    const revokeLast = await fetch(`${baseUrl}/api/admin/users/sole-admin/roles/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminTok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "ADMIN", reason: "Accidental lockout" }),
    });
    expect(revokeLast.status).toBe(409);
    expect(((await revokeLast.json()) as { code: string }).code).toBe("last-admin-protected");

    const deactLast = await fetch(`${baseUrl}/api/admin/users/sole-admin/deactivate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminTok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Accidental self-deactivation" }),
    });
    expect(deactLast.status).toBe(409);
    expect(((await deactLast.json()) as { code: string }).code).toBe("last-admin-protected");

    // Four-eyes bypass: curator cannot self-approve or activate unapproved release
    const proposal = buildPackageProposal(packSource, {
      version: "1.0.1",
      predecessorReleaseId: initialReleaseId,
      note: "Attempt self-approval",
      mutateFiles: (files) => {
        files["code-lists/TEMPER@1.0.0.csv"] = `${files["code-lists/TEMPER@1.0.0.csv"]}H14\n`;
      },
    });
    const propRes = await fetch(`${baseUrl}/api/config-releases/propose`, {
      method: "POST",
      headers: { Authorization: `Bearer ${curTok}`, "Content-Type": "application/json" },
      body: JSON.stringify(proposal),
    });
    expect(propRes.status).toBe(201);
    const { release } = (await propRes.json()) as { release: { releaseId: string } };

    const selfApprove = await fetch(`${baseUrl}/api/config-releases/${release.releaseId}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${curTok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Self approval attempt" }),
    });
    expect(selfApprove.status).toBe(403);
    expect(((await selfApprove.json()) as { code: string }).code).toBe("self-approval-forbidden");

    const activateUnapproved = await fetch(`${baseUrl}/api/config-releases/${release.releaseId}/activate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminTok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Bypass approval attempt" }),
    });
    expect(activateUnapproved.status).toBe(409);
    expect(((await activateUnapproved.json()) as { code: string }).code).toBe("invalid-state");
  });

  it("blocks direct SQLite tampering on append-only grant_events, config_packages content, and config_package_events", () => {
    expect(() => db.run("DELETE FROM grant_events")).toThrow(/append-only/);
    expect(() => db.run("UPDATE grant_events SET reason = 'rewritten' WHERE seq = 1")).toThrow(/append-only/);
    expect(() => db.run("DELETE FROM config_package_events")).toThrow(/append-only/);
    expect(() => db.run("UPDATE config_package_events SET reason = 'rewritten' WHERE seq = 1")).toThrow(/append-only/);
    expect(() => db.run("DELETE FROM config_packages")).toThrow(/append-only/);
    expect(() =>
      db.run("UPDATE config_packages SET bundle_json = '{}' WHERE release_id = ?", initialReleaseId),
    ).toThrow(/immutable/);
  });
});
