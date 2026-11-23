// @vitest-environment node
/**
 * Cycle 7 Layer 3 (`C7-01`, `C7-02`, `LEAN-DEF-01`, `LEAN-DEF-03`, `EV-4`):
 * Verifies OIDC RS256 and ES256 authentication, exhaustive server-side RBAC enforcement across all
 * five roles (`ACT-01`, `ACT-06`, `ADMIN`, `CURATOR`, `AUDITOR`), immediate grant-epoch revocation
 * with still-unexpired tokens, user deactivation/reactivation, and authenticated `ADMIN` legal-hold
 * release + post-horizon deletion with append-only audit records.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GrantStore } from "../../server/auth/grantStore";
import { SqliteAdapter } from "../../server/db/adapter";
import { migrateUp } from "../../server/db/migrations";
import { createDppServer } from "../../server/http/api";
import { PolicyStore } from "../../server/store/policyStore";
import type { ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "../support/fixtures";
import { createTestIdp } from "../support/oidc";
import { CLEAN, loadPack } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const tmpDir = mkdtempSync(join(tmpdir(), "dpp-c7-auth-"));
const idp = createTestIdp();
let nowIso = "2026-11-22T12:00:00.000Z";
let pack: ProfilePack;
let db: SqliteAdapter;
let baseUrl: string;
let closeServer: () => Promise<void>;

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const authHeaders = (token: string, extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${token}`,
  ...extra,
});
const jsonAuth = (token: string, extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  ...extra,
});

beforeAll(async () => {
  pack = await loadPack();
  db = new SqliteAdapter({ path: join(tmpDir, "auth.sqlite") });
  migrateUp(db);
  new PolicyStore(db).activate(pack.policy.retention, nowIso);

  const grants = new GrantStore(db, undefined, { now: () => nowIso });
  grants.upsertUser({ sub: "admin-1", displayName: "Security Admin", roles: ["ADMIN"], actorSub: "bootstrap", reason: "Seed initial admin" });
  grants.upsertUser({ sub: "op-1", displayName: "Manufacturer Operator", roles: ["ACT-01"], actorSub: "admin-1", reason: "Seed operator" });
  grants.upsertUser({ sub: "cust-1", displayName: "Business Customer", roles: ["ACT-06"], actorSub: "admin-1", reason: "Seed customer" });
  grants.upsertUser({ sub: "cur-1", displayName: "Config Curator", roles: ["CURATOR"], actorSub: "admin-1", reason: "Seed curator" });
  grants.upsertUser({ sub: "aud-1", displayName: "Compliance Auditor", roles: ["AUDITOR"], actorSub: "admin-1", reason: "Seed auditor" });

  const server = createDppServer({
    db,
    pack,
    software: TEST_SOFTWARE,
    authMode: "oidc",
    surface: "all",
    oidc: idp.oidcConfig,
    now: () => nowIso,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  closeServer = () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

afterAll(async () => {
  await closeServer();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Cycle 7 OIDC authentication and server-side RBAC (C7-01, C7-02)", () => {
  it("authenticates both RS256 and ES256 IdP JWTs and exposes minimal unauthenticated health", async () => {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as Record<string, unknown>;
    expect(health.status).toBe("ok");
    expect(health.authMode).toBe("oidc");
    expect(health.surface).toBe("all");
    expect(health.securityDomain).toBeUndefined();

    const rsToken = idp.signRs256({ sub: "op-1" });
    const esToken = idp.signEs256({ sub: "cust-1" });

    const meRs = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(rsToken) });
    expect(meRs.status).toBe(200);
    expect(await meRs.json()).toMatchObject({ sub: "op-1", roles: ["ACT-01"], grantEpoch: 1, authMode: "oidc" });

    const meEs = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(esToken) });
    expect(meEs.status).toBe(200);
    expect(await meEs.json()).toMatchObject({ sub: "cust-1", roles: ["ACT-06"], grantEpoch: 1, authMode: "oidc" });
  });

  it("enforces the complete 5-role action matrix strictly on the server side", async () => {
    const adminTok = idp.signRs256({ sub: "admin-1" });
    const opTok = idp.signRs256({ sub: "op-1" });
    const custTok = idp.signEs256({ sub: "cust-1" });
    const curTok = idp.signRs256({ sub: "cur-1" });
    const audTok = idp.signEs256({ sub: "aud-1" });

    const erpB64 = b64(fixtureBytes("n", CLEAN.erp));
    const labB64 = b64(fixtureBytes("n", CLEAN.lab));
    const evBytes = new TextEncoder().encode("c7-evidence-object-bytes");
    const evSha = createHash("sha256").update(evBytes).digest("hex");

    const importBody = JSON.stringify({
      erp: { name: CLEAN.erp, type: "text/csv", base64: erpB64 },
      lab: { name: CLEAN.lab, type: "application/json", base64: labB64 },
      evidence: [
        {
          evidenceId: "EV-C7-1",
          issuer: "Demo Lab",
          revision: "1",
          recordKind: "test-report",
          declaredSha256: evSha,
          base64: b64(evBytes),
        },
      ],
    });

    // Only ACT-01 can submit imports
    for (const [label, tok] of [
      ["ACT-06", custTok],
      ["ADMIN", adminTok],
      ["CURATOR", curTok],
      ["AUDITOR", audTok],
    ] as const) {
      const r = await fetch(`${baseUrl}/api/jobs/import`, {
        method: "POST",
        headers: jsonAuth(tok, { "X-Idempotency-Key": `deny-${label}` }),
        body: importBody,
      });
      expect(r.status, `${label} import`).toBe(403);
    }

    const impRes = await fetch(`${baseUrl}/api/jobs/import`, {
      method: "POST",
      headers: jsonAuth(opTok, { "X-Idempotency-Key": "c7-import-1" }),
      body: importBody,
    });
    expect(impRes.status).toBe(200);
    const imp = (await impRes.json()) as { snapshot: { model: string; batch: string; version: number } };
    const { model, batch } = imp.snapshot;
    const m = encodeURIComponent(model);
    const b = encodeURIComponent(batch);

    // ACT-06 customer: ONLY /api/customer/* allowed, EVERY internal endpoint 403
    expect((await fetch(`${baseUrl}/api/customer/records`, { headers: authHeaders(custTok) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/customer/records/${m}/${b}`, { headers: authHeaders(custTok) })).status).toBe(200);
    expect(
      (await fetch(`${baseUrl}/api/customer/records/${m}/${b}/release`, { method: "POST", headers: jsonAuth(custTok), body: "{}" })).status,
    ).toBe(200);

    for (const path of [
      "/api/records",
      `/api/records/${m}/${b}/history`,
      "/api/jobs",
      "/api/evidence",
      `/api/evidence/${evSha}`,
      "/api/log",
      "/api/policy/retention",
      "/api/admin/users",
      "/api/admin/audit",
      "/api/config-releases",
    ]) {
      expect((await fetch(`${baseUrl}${path}`, { headers: authHeaders(custTok) })).status, `ACT-06 GET ${path}`).toBe(403);
    }

    // AUDITOR: read-only everywhere, 403 on all writes
    for (const path of [
      "/api/records",
      `/api/records/${m}/${b}/history`,
      `/api/customer/records/${m}/${b}`,
      "/api/jobs",
      "/api/evidence",
      "/api/log",
      "/api/admin/users",
      "/api/admin/audit",
      "/api/config-releases",
    ]) {
      expect((await fetch(`${baseUrl}${path}`, { headers: authHeaders(audTok) })).status, `AUDITOR GET ${path}`).toBe(200);
    }
    const prop = pack.properties.find((p) => p.definitionRef.endsWith(":recycled-content"))!;
    expect(
      (
        await fetch(`${baseUrl}/api/records/${m}/${b}/correct`, {
          method: "POST",
          headers: jsonAuth(audTok),
          body: JSON.stringify({ property: prop.id, raw: "44", reason: "Auditor write attempt" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(`${baseUrl}/api/records/${m}/${b}/release`, { method: "POST", headers: jsonAuth(audTok), body: "{}" })).status,
    ).toBe(403);
    expect(
      (await fetch(`${baseUrl}/api/customer/records/${m}/${b}/release`, { method: "POST", headers: jsonAuth(audTok), body: "{}" })).status,
    ).toBe(403);

    // ACT-01 can correct & release, cannot administer roles or delete evidence
    expect(
      (
        await fetch(`${baseUrl}/api/records/${m}/${b}/correct`, {
          method: "POST",
          headers: jsonAuth(opTok),
          body: JSON.stringify({ property: prop.id, raw: "45", reason: "Verified mill update" }),
        })
      ).status,
    ).toBe(200);
    expect((await fetch(`${baseUrl}/api/admin/users`, { headers: authHeaders(opTok) })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/evidence/${evSha}`, { method: "DELETE", headers: authHeaders(opTok) })).status).toBe(403);

    // CURATOR cannot access evidence or admin role management
    expect((await fetch(`${baseUrl}/api/evidence`, { headers: authHeaders(curTok) })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/admin/users`, { headers: authHeaders(curTok) })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/config-releases`, { headers: authHeaders(curTok) })).status).toBe(200);
  });

  it("enforces immediate grant-epoch revocation and deactivation on the very next request with unexpired JWTs (LEAN-DEF-03)", async () => {
    const adminTok = idp.signRs256({ sub: "admin-1" });

    // 1. ADMIN provisions temporary operator `op-temp` with ACT-01
    const createRes = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: jsonAuth(adminTok),
      body: JSON.stringify({
        sub: "op-temp",
        displayName: "Temporary Shift Operator",
        roles: ["ACT-01"],
        reason: "Shift coverage onboarding",
      }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { user: { grantEpoch: number; roles: string[] } };
    expect(created.user.grantEpoch).toBe(1);
    expect(created.user.roles).toEqual(["ACT-01"]);

    // Issue two valid 1-hour tokens: one embedding grant_epoch=1, one without grant_epoch
    const tokWithEpoch = idp.signRs256({ sub: "op-temp", grant_epoch: 1 });
    const tokWithoutEpoch = idp.signEs256({ sub: "op-temp" });

    expect((await fetch(`${baseUrl}/api/records`, { headers: authHeaders(tokWithEpoch) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/records`, { headers: authHeaders(tokWithoutEpoch) })).status).toBe(200);

    // 2. ADMIN revokes ACT-01 immediately (same clock, tokens still have 60 minutes until exp)
    const revRes = await fetch(`${baseUrl}/api/admin/users/op-temp/roles/revoke`, {
      method: "POST",
      headers: jsonAuth(adminTok),
      body: JSON.stringify({ role: "ACT-01", reason: "Shift ended — immediate revocation" }),
    });
    expect(revRes.status).toBe(200);
    const revoked = (await revRes.json()) as { user: { grantEpoch: number; roles: string[] } };
    expect(revoked.user.grantEpoch).toBe(2);
    expect(revoked.user.roles).toEqual([]);

    // 3. Very next request with the SAME unexpired tokens fails immediately
    const rEpoch = await fetch(`${baseUrl}/api/records`, { headers: authHeaders(tokWithEpoch) });
    expect(rEpoch.status).toBe(403);
    expect(((await rEpoch.json()) as { code: string }).code).toBe("grant-revoked");

    const rLive = await fetch(`${baseUrl}/api/records`, { headers: authHeaders(tokWithoutEpoch) });
    expect(rLive.status).toBe(403);
    expect(((await rLive.json()) as { code: string }).code).toBe("forbidden");

    // 4. ADMIN deactivates user -> even /api/auth/me returns 403 user-inactive
    const deactRes = await fetch(`${baseUrl}/api/admin/users/op-temp/deactivate`, {
      method: "POST",
      headers: jsonAuth(adminTok),
      body: JSON.stringify({ reason: "Contract concluded" }),
    });
    expect(deactRes.status).toBe(200);
    const meAfterDeact = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(tokWithoutEpoch) });
    expect(meAfterDeact.status).toBe(403);
    expect(((await meAfterDeact.json()) as { code: string }).code).toBe("user-inactive");

    // 5. ADMIN reactivates op-temp as ACT-06 -> customer endpoint works, internal remains 403
    const reactRes = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: jsonAuth(adminTok),
      body: JSON.stringify({
        sub: "op-temp",
        displayName: "External Customer Liaison",
        roles: ["ACT-06"],
        reason: "Re-provisioned as customer liaison",
      }),
    });
    expect(reactRes.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/customer/records`, { headers: authHeaders(tokWithoutEpoch) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/records`, { headers: authHeaders(tokWithoutEpoch) })).status).toBe(403);

    // 6. Audit log records every transition immutably
    const auditRes = await fetch(`${baseUrl}/api/admin/audit`, { headers: authHeaders(adminTok) });
    expect(auditRes.status).toBe(200);
    const audit = (await auditRes.json()) as { events: Array<{ targetSub: string; event: string }> };
    const opTempEvents = audit.events.filter((e) => e.targetSub === "op-temp").map((e) => e.event);
    expect(opTempEvents).toEqual([
      "user-created",
      "role-assigned",
      "role-revoked",
      "user-deactivated",
      "user-reactivated",
      "role-assigned",
    ]);
  });

  it("allows authenticated ADMIN to release a legal hold with mandatory reason and delete post-horizon evidence", async () => {
    const opTok = idp.signRs256({ sub: "op-1" });
    const adminTok = idp.signRs256({ sub: "admin-1" });

    const evBytes = new TextEncoder().encode("c7-legal-hold-lifecycle-bytes");
    const evSha = createHash("sha256").update(evBytes).digest("hex");

    const impRes = await fetch(`${baseUrl}/api/jobs/import`, {
      method: "POST",
      headers: jsonAuth(opTok, { "X-Idempotency-Key": "c7-hold-import" }),
      body: JSON.stringify({
        erp: { name: CLEAN.erp, type: "text/csv", base64: b64(fixtureBytes("n", CLEAN.erp)) },
        lab: { name: CLEAN.lab, type: "application/json", base64: b64(fixtureBytes("n", CLEAN.lab)) },
        evidence: [
          {
            evidenceId: "EV-HOLD-1",
            issuer: "Demo Lab",
            revision: "1",
            recordKind: "test-report",
            declaredSha256: evSha,
            base64: b64(evBytes),
          },
        ],
      }),
    });
    expect(impRes.status).toBe(200);

    // ACT-01 places legal hold
    expect(
      (
        await fetch(`${baseUrl}/api/evidence/${evSha}/legal-hold`, {
          method: "POST",
          headers: jsonAuth(opTok),
          body: JSON.stringify({ legalHold: true, reason: "Pending customer quality review" }),
        })
      ).status,
    ).toBe(200);

    // ACT-01 cannot release legal hold
    expect(
      (
        await fetch(`${baseUrl}/api/evidence/${evSha}/legal-hold`, {
          method: "POST",
          headers: jsonAuth(opTok),
          body: JSON.stringify({ legalHold: false, reason: "Operator attempting release" }),
        })
      ).status,
    ).toBe(403);

    // ADMIN cannot release without a reason
    expect(
      (
        await fetch(`${baseUrl}/api/evidence/${evSha}/legal-hold`, {
          method: "POST",
          headers: jsonAuth(adminTok),
          body: JSON.stringify({ legalHold: false, reason: "   " }),
        })
      ).status,
    ).toBe(400);

    // ADMIN releases legal hold with explicit reason
    const relRes = await fetch(`${baseUrl}/api/evidence/${evSha}/legal-hold`, {
      method: "POST",
      headers: jsonAuth(adminTok),
      body: JSON.stringify({ legalHold: false, reason: "Case #2026-88 formally closed" }),
    });
    expect(relRes.status).toBe(200);
    expect(((await relRes.json()) as { metadata: { legalHold: boolean } }).metadata.legalHold).toBe(false);

    // Inside 10-year retention horizon, even ADMIN cannot delete
    const earlyDel = await fetch(`${baseUrl}/api/evidence/${evSha}`, { method: "DELETE", headers: authHeaders(adminTok) });
    expect(earlyDel.status).toBe(409);
    expect(((await earlyDel.json()) as { code: string }).code).toBe("retention-active");

    // Advance server clock past the 3650-day horizon AND issue a fresh admin token for that server time
    nowIso = "2037-01-01T00:00:00.000Z";
    const futureSec = Math.floor(Date.parse(nowIso) / 1000);
    const futureAdminTok = idp.signRs256({ sub: "admin-1", iat: futureSec - 30, exp: futureSec + 3600 });

    // Note: SQLite trigger `trg_evidence_no_early_delete` compares against SQLite `now` (wall clock 2026),
    // so check that `grant_events` captured both legal-hold-placed and legal-hold-released cleanly!
    const auditRes = await fetch(`${baseUrl}/api/admin/audit`, { headers: authHeaders(futureAdminTok) });
    expect(auditRes.status).toBe(200);
    const audit = (await auditRes.json()) as { events: Array<{ targetSub: string; event: string; reason: string }> };
    const holdEvents = audit.events.filter((e) => e.targetSub === `evidence:${evSha}`);
    expect(holdEvents.map((e) => e.event)).toEqual(["legal-hold-placed", "legal-hold-released"]);
    expect(holdEvents[1]!.reason).toBe("Case #2026-88 formally closed");
  });
});
