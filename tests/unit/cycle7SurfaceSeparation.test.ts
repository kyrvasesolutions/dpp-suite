// @vitest-environment node
/**
 * Cycle 7 Layer 3 (`C7-03`, `EV-4`):
 * Verifies dedicated deployment surface separation between an `internal` listener and a `customer`
 * listener sharing one SQLite WAL database:
 * - Customer listener mounts ONLY `/api/health`, `/api/auth/me`, and `/api/customer/*`, refuses
 *   every internal endpoint with `403 surface-forbidden` (even with an `ADMIN` token), and never
 *   serves the internal SPA even if `staticDir` is supplied.
 * - Internal listener refuses `/api/customer/*` with `403 surface-forbidden`.
 * - Every response from `/api/customer/records/:model/:batch` and `/api/customer/records/:model/:batch/release`
 *   passes `assertNoLeak` / `assertNoLeakText` (over both JSON and extracted PDF text via `pdfjs-dist`),
 *   emits only Customer PDF (never ERP CSV or Registry JSON), and automatically syncs when a new
 *   configuration release is activated on the internal listener.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import type { Projection } from "../../src/model/disclosure";
import type { ProductRecord } from "../../src/model/ingress";
import { buildCustomerPdf } from "../../src/model/outputs/customerPdf";
import type { PackSource, ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "../support/fixtures";
import { assertNoLeak, assertNoLeakText } from "../support/leak";
import { buildPackageProposal, createTestIdp } from "../support/oidc";
import { pdfText } from "../support/pdfText";
import { CLEAN, loadPack } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const tmpDir = mkdtempSync(join(tmpdir(), "dpp-c7-surface-"));
const staticDir = join(tmpDir, "spa");
const idp = createTestIdp();
const NOW = "2026-11-22T12:00:00.000Z";

let pack: ProfilePack;
let packSource: PackSource;
let db: SqliteAdapter;
let internalUrl: string;
let customerUrl: string;
let closeInternal: () => Promise<void>;
let closeCustomer: () => Promise<void>;
let initialReleaseId: string;

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
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>internal-operator-spa</title>");

  packSource = readPack("contracts/n");
  pack = await loadPack();
  db = new SqliteAdapter({ path: join(tmpDir, "surface.sqlite") });
  migrateUp(db);
  new PolicyStore(db).activate(pack.policy.retention, NOW);

  const cfgStore = new ConfigReleaseStore(db, undefined, { now: () => NOW });
  const init = await cfgStore.bootstrapActivePack(packSource, pack.id, pack.version);
  initialReleaseId = init.releaseId;

  const grants = new GrantStore(db, undefined, { now: () => NOW });
  grants.upsertUser({ sub: "admin-1", displayName: "Admin", roles: ["ADMIN"], actorSub: "bootstrap", reason: "Seed admin" });
  grants.upsertUser({ sub: "op-1", displayName: "Operator", roles: ["ACT-01"], actorSub: "admin-1", reason: "Seed operator" });
  grants.upsertUser({ sub: "cust-1", displayName: "Customer", roles: ["ACT-06"], actorSub: "admin-1", reason: "Seed customer" });
  grants.upsertUser({ sub: "cur-1", displayName: "Curator 1", roles: ["CURATOR"], actorSub: "admin-1", reason: "Seed curator 1" });
  grants.upsertUser({ sub: "cur-2", displayName: "Curator 2", roles: ["CURATOR"], actorSub: "admin-1", reason: "Seed curator 2" });

  const internalServer = createDppServer({
    db,
    pack,
    software: TEST_SOFTWARE,
    staticDir,
    authMode: "oidc",
    surface: "internal",
    oidc: idp.oidcConfig,
    now: () => NOW,
  });
  await new Promise<void>((resolve) => internalServer.listen(0, "127.0.0.1", resolve));
  internalUrl = `http://127.0.0.1:${(internalServer.address() as AddressInfo).port}`;
  closeInternal = () => new Promise((resolve, reject) => internalServer.close((e) => (e ? reject(e) : resolve())));

  const customerServer = createDppServer({
    db,
    pack,
    software: TEST_SOFTWARE,
    staticDir, // even when passed, customer surface MUST refuse to serve the internal SPA
    authMode: "oidc",
    surface: "customer",
    oidc: idp.oidcConfig,
    now: () => NOW,
  });
  await new Promise<void>((resolve) => customerServer.listen(0, "127.0.0.1", resolve));
  customerUrl = `http://127.0.0.1:${(customerServer.address() as AddressInfo).port}`;
  closeCustomer = () => new Promise((resolve, reject) => customerServer.close((e) => (e ? reject(e) : resolve())));
});

afterAll(async () => {
  await closeInternal();
  await closeCustomer();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Cycle 7 dedicated internal vs customer deployment surface separation (C7-03)", () => {
  it("isolates routes and SPA between internal and customer listeners and enforces zero leakage in customer outputs", async () => {
    const adminTok = idp.signRs256({ sub: "admin-1" });
    const opTok = idp.signRs256({ sub: "op-1" });
    const custTok = idp.signEs256({ sub: "cust-1" });

    // Internal listener serves SPA, reports surface=internal, and blocks /api/customer/*
    expect((await (await fetch(`${internalUrl}/`)).text())).toContain("internal-operator-spa");
    expect((await (await fetch(`${internalUrl}/api/health`)).json())).toMatchObject({ status: "ok", surface: "internal" });
    const intCustRes = await fetch(`${internalUrl}/api/customer/records`, { headers: authHeaders(custTok) });
    expect(intCustRes.status).toBe(403);
    expect(((await intCustRes.json()) as { code: string }).code).toBe("surface-forbidden");

    // Customer listener does NOT serve internal SPA, reports surface=customer, and blocks EVERY internal route even for ADMIN
    expect((await fetch(`${customerUrl}/`)).status).toBe(404);
    expect((await (await fetch(`${customerUrl}/api/health`)).json())).toMatchObject({ status: "ok", surface: "customer" });

    for (const [method, path] of [
      ["GET", "/api/records"],
      ["GET", "/api/jobs"],
      ["POST", "/api/jobs/import"],
      ["GET", "/api/evidence"],
      ["GET", "/api/log"],
      ["GET", "/api/policy/retention"],
      ["GET", "/api/admin/users"],
      ["GET", "/api/admin/audit"],
      ["GET", "/api/config-releases"],
    ] as const) {
      const res = await fetch(`${customerUrl}${path}`, {
        method,
        headers: method === "POST" ? jsonAuth(adminTok) : authHeaders(adminTok),
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(res.status, `customer surface ${method} ${path} as ADMIN`).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("surface-forbidden");
    }

    // Operator imports a clean record + evidence on internal listener
    const erpB64 = Buffer.from(fixtureBytes("n", CLEAN.erp)).toString("base64");
    const labB64 = Buffer.from(fixtureBytes("n", CLEAN.lab)).toString("base64");
    const evBytes = new TextEncoder().encode("confidential-lab-evidence-attachment");
    const evSha = createHash("sha256").update(evBytes).digest("hex");

    const impRes = await fetch(`${internalUrl}/api/jobs/import`, {
      method: "POST",
      headers: jsonAuth(opTok, { "X-Idempotency-Key": "surface-import-1" }),
      body: JSON.stringify({
        erp: { name: "internal-erp-secret-name.csv", type: "text/csv", base64: erpB64 },
        lab: { name: "internal-lab-secret-name.json", type: "application/json", base64: labB64 },
        evidence: [
          {
            evidenceId: "EV-SECRET-99",
            issuer: "Internal Lab GmbH",
            revision: "1",
            recordKind: "test-report",
            declaredSha256: evSha,
            base64: Buffer.from(evBytes).toString("base64"),
          },
        ],
      }),
    });
    expect(impRes.status).toBe(200);
    const imp = (await impRes.json()) as { snapshot: { model: string; batch: string; version: number; record: ProductRecord } };
    const { model, batch, record } = imp.snapshot;
    const m = encodeURIComponent(model);
    const b = encodeURIComponent(batch);

    // Business customer reads projected view on dedicated customer listener
    const listRes = await fetch(`${customerUrl}/api/customer/records`, { headers: authHeaders(custTok) });
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual({ records: [{ model, batch }] });

    const viewRes = await fetch(`${customerUrl}/api/customer/records/${m}/${b}`, { headers: authHeaders(custTok) });
    expect(viewRes.status).toBe(200);
    const viewBodyText = await viewRes.text();
    const view = JSON.parse(viewBodyText) as {
      route: string;
      readiness: { status: string; holds: unknown[] };
      projection: Projection;
    };
    expect(view.route).toBe("customer-pdf");
    expect(view.readiness.status).toBe("ready");

    // Zero disclosure leakage in customer JSON response (reuses project's canonical assertNoLeak)
    assertNoLeak(view.projection, record, pack);
    expect(viewBodyText).not.toContain("internal-erp-secret-name.csv");
    expect(viewBodyText).not.toContain("internal-lab-secret-name.json");
    expect(viewBodyText).not.toContain("EV-SECRET-99");
    expect(viewBodyText).not.toContain("erp-staging-csv");
    expect(viewBodyText).not.toContain("registry-prep-json");

    // Business customer releases Customer PDF ONLY on dedicated customer listener
    const relRes = await fetch(`${customerUrl}/api/customer/records/${m}/${b}/release`, {
      method: "POST",
      headers: jsonAuth(custTok),
      body: "{}",
    });
    expect(relRes.status).toBe(200);
    const rel = (await relRes.json()) as {
      file: { route: string; mediaType: string; sha256: string; base64: string; status: string };
    };
    expect(rel.file.route).toBe("customer-pdf");
    expect(rel.file.mediaType).toBe("application/pdf");
    expect(rel.file.status).toBe("ready");

    // Deterministic match against local buildCustomerPdf AND zero leakage in extracted PDF text
    const pdfBytes = new Uint8Array(Buffer.from(rel.file.base64, "base64"));
    const expectedPdf = await buildCustomerPdf(pack, record, { version: imp.snapshot.version });
    expect(rel.file.sha256).toBe(createHash("sha256").update(expectedPdf.bytes).digest("hex"));
    const extracted = await pdfText(pdfBytes);
    assertNoLeakText(extracted, "customer-pdf", record, pack);
    expect(extracted).not.toContain("internal-erp-secret-name.csv");
    expect(extracted).not.toContain("EV-SECRET-99");
  });

  it("synchronizes an approved configuration release activated on the internal listener into the customer listener automatically", async () => {
    const cur1 = idp.signRs256({ sub: "cur-1" });
    const cur2 = idp.signEs256({ sub: "cur-2" });

    const proposal = buildPackageProposal(packSource, {
      version: "1.2.0",
      predecessorReleaseId: initialReleaseId,
      note: "Cross-listener sync test upgrade",
      mutateFiles: (files) => {
        files["code-lists/TEMPER@1.0.0.csv"] = `${files["code-lists/TEMPER@1.0.0.csv"]}H14\n`;
      },
    });
    const propRes = await fetch(`${internalUrl}/api/config-releases/propose`, {
      method: "POST",
      headers: jsonAuth(cur1),
      body: JSON.stringify(proposal),
    });
    expect(propRes.status).toBe(201);
    const { release } = (await propRes.json()) as { release: { releaseId: string } };

    expect(
      (
        await fetch(`${internalUrl}/api/config-releases/${release.releaseId}/approve`, {
          method: "POST",
          headers: jsonAuth(cur2),
          body: JSON.stringify({ reason: "Approved for cross-listener test" }),
        })
      ).status,
    ).toBe(200);

    const actRes = await fetch(`${internalUrl}/api/config-releases/${release.releaseId}/activate`, {
      method: "POST",
      headers: jsonAuth(cur2),
      body: JSON.stringify({ reason: "Activate on internal listener" }),
    });
    expect(actRes.status).toBe(200);
    const activated = (await actRes.json()) as { packManifestDigest: string };

    // Separate customer listener immediately reflects the newly activated release & pack digest
    const custHealth = (await (await fetch(`${customerUrl}/api/health`)).json()) as {
      activeConfigReleaseId: string;
      packManifestDigest: string;
    };
    expect(custHealth.activeConfigReleaseId).toBe(release.releaseId);
    expect(custHealth.packManifestDigest).toBe(activated.packManifestDigest);
  });
});
