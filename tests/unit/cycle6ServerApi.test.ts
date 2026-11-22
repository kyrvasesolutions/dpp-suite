// @vitest-environment node
/**
 * Cycle 6 Layer 3: end-to-end HTTP API tests against an ephemeral localhost Node 24 server
 * (`createDppServer`), verifying health, policies, staged imports, idempotent replays, optimistic
 * 409 conflicts, transactional corrections, deterministic releases, evidence retention/legal holds,
 * security headers, path-traversal refusal, and `RemoteRecordRepository` / `RemoteLogStore` adapters.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../server/db/adapter";
import { migrateUp } from "../../server/db/migrations";
import { createDppServer } from "../../server/http/api";
import { PolicyStore } from "../../server/store/policyStore";
import { ExecutionLog } from "../../src/model/log";
import type { ProfilePack } from "../../src/model/profile";
import { RemoteLogStore, RemoteRecordRepository } from "../../src/model/remoteStore";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, loadPack } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const tmpDir = mkdtempSync(join(tmpdir(), "dpp-c6-api-"));
let pack: ProfilePack;
let db: SqliteAdapter;
let baseUrl: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  pack = await loadPack();
  db = new SqliteAdapter({ path: join(tmpDir, "api.sqlite") });
  migrateUp(db);
  new PolicyStore(db).activate(pack.policy.retention);

  const server = createDppServer({ db, pack, software: TEST_SOFTWARE });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  closeServer = () =>
    new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

afterAll(async () => {
  await closeServer();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Cycle 6 Node 24 HTTP API and client adapter", () => {
  it("exposes health, retention policy, and exception catalogue with strict security headers", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const health = (await res.json()) as {
      status: string;
      schemaVersion: number;
      activeRetentionPolicy: string;
      packManifestDigest: string;
    };
    expect(health.status).toBe("ok");
    expect(health.schemaVersion).toBe(2);
    expect(health.activeRetentionPolicy).toBe("RETENTION@1.0.0");
    expect(health.packManifestDigest).toBe(pack.manifestDigest);

    const pol = (await (await fetch(`${baseUrl}/api/policy/retention`)).json()) as {
      active: { policyPin: string; policy: { default_classification: string; default_retention_days: number } };
    };
    expect(pol.active.policyPin).toBe("RETENTION@1.0.0");
    expect(pol.active.policy.default_classification).toBe("restricted");
    expect(pol.active.policy.default_retention_days).toBe(3650);

    const ex = (await (await fetch(`${baseUrl}/api/policy/exceptions`)).json()) as {
      catalogue: { id: string; exceptions: unknown[] };
    };
    expect(ex.catalogue.id).toBe("EXCEPTIONS");
    expect(ex.catalogue.exceptions.length).toBeGreaterThanOrEqual(12);
  });

  it("handles full import -> idempotent replay -> conflict -> correction -> release -> evidence retention lifecycle", async () => {
    const erpB64 = Buffer.from(fixtureBytes("n", CLEAN.erp)).toString("base64");
    const labB64 = Buffer.from(fixtureBytes("n", CLEAN.lab)).toString("base64");
    const evBytes = new TextEncoder().encode("mill-test-report-pdf-bytes");
    const evSha = createHash("sha256").update(evBytes).digest("hex");

    // 1. Import job with evidence and EV-5 time envelope
    const impRes = await fetch(`${baseUrl}/api/jobs/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Idempotency-Key": "api-import-1" },
      body: JSON.stringify({
        expectedVersion: 0,
        timeEnvelope: {
          recordedAt: "2026-11-22T12:00:00Z",
          observedAt: "2026-11-20T09:00:00Z",
          declaredAt: "2026-11-21T15:00:00Z",
          publishedAt: null,
          validFrom: "2026-11-22T12:00:00Z",
          validTo: null,
        },
        erp: { name: CLEAN.erp, type: "text/csv", base64: erpB64 },
        lab: { name: CLEAN.lab, type: "application/json", base64: labB64 },
        evidence: [
          {
            evidenceId: "EV-API-1",
            issuer: "Demo Lab",
            revision: "1",
            recordKind: "test-report",
            declaredSha256: evSha,
            base64: Buffer.from(evBytes).toString("base64"),
          },
        ],
      }),
    });
    expect(impRes.status).toBe(200);
    const imp = (await impRes.json()) as {
      ok: boolean;
      job: { jobId: string; state: string };
      receipt: { version: number; stored: boolean; retentionUntil: string };
      snapshot: { model: string; batch: string; version: number };
    };
    expect(imp.ok).toBe(true);
    expect(imp.job.state).toBe("committed");
    expect(imp.receipt.version).toBe(1);
    expect(imp.receipt.stored).toBe(true);
    expect(imp.receipt.retentionUntil).toBe("2036-11-19T12:00:00.000Z");

    const { model, batch } = imp.snapshot;

    // 2. Idempotent replay with same key returns stored=false
    const replayRes = await fetch(`${baseUrl}/api/jobs/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Idempotency-Key": "api-import-1" },
      body: JSON.stringify({
        erp: { name: CLEAN.erp, type: "text/csv", base64: erpB64 },
        lab: { name: CLEAN.lab, type: "application/json", base64: labB64 },
      }),
    });
    expect(replayRes.status).toBe(200);
    const replay = (await replayRes.json()) as { receipt: { stored: boolean; version: number } };
    expect(replay.receipt.stored).toBe(false);
    expect(replay.receipt.version).toBe(1);

    // 3. Stale optimistic expectedVersion=0 with new key -> 409 Conflict
    const conflictRes = await fetch(`${baseUrl}/api/jobs/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Idempotency-Key": "api-import-stale" },
      body: JSON.stringify({
        expectedVersion: 0,
        erp: { name: CLEAN.erp, type: "text/csv", base64: erpB64 },
        lab: { name: CLEAN.lab, type: "application/json", base64: labB64 },
      }),
    });
    expect(conflictRes.status).toBe(409);

    // 4. Transactional operator correction -> v2
    const prop = pack.properties.find((p) => p.definitionRef.endsWith(":recycled-content"))!;
    const corrRes = await fetch(
      `${baseUrl}/api/records/${encodeURIComponent(model)}/${encodeURIComponent(batch)}/correct`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          property: prop.id,
          raw: "44",
          reason: "Confirmed recycled share from smelter certificate",
          expectedVersion: 1,
        }),
      },
    );
    expect(corrRes.status).toBe(200);
    const corr = (await corrRes.json()) as { snapshot: { version: number } };
    expect(corr.snapshot.version).toBe(2);

    // 5. Generate release from v2 (PDF ready, ERP CSV ready, Registry HOLD draft)
    const relRes = await fetch(
      `${baseUrl}/api/records/${encodeURIComponent(model)}/${encodeURIComponent(batch)}/release`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
    );
    expect(relRes.status).toBe(200);
    const rel = (await relRes.json()) as {
      substantiveDigest: string;
      files: Array<{ route: string; status: string }>;
      refused: unknown[];
    };
    expect(rel.substantiveDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(rel.files.map((f) => `${f.route}:${f.status}`)).toEqual([
      "customer-pdf:ready",
      "erp-staging-csv:ready",
      "registry-prep-json:hold",
    ]);
    expect(rel.refused).toHaveLength(0);

    // 6. Evidence retention and legal-hold endpoints
    const evGet = await fetch(`${baseUrl}/api/evidence/${evSha}`);
    expect(evGet.status).toBe(200);
    const delEarly = await fetch(`${baseUrl}/api/evidence/${evSha}?asOf=2028-01-01T00:00:00Z`, { method: "DELETE" });
    expect(delEarly.status).toBe(409);

    const holdRes = await fetch(`${baseUrl}/api/evidence/${evSha}/legal-hold`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ legalHold: true }),
    });
    expect(holdRes.status).toBe(200);
    const delHeld = await fetch(`${baseUrl}/api/evidence/${evSha}?asOf=2045-01-01T00:00:00Z`, { method: "DELETE" });
    expect(delHeld.status).toBe(409);

    // 7. RemoteRecordRepository & RemoteLogStore client adapters read the same durable state
    const remoteRepo = new RemoteRecordRepository(baseUrl);
    const hist = await remoteRepo.history(model, batch);
    expect(hist).toHaveLength(2);
    expect((await remoteRepo.latest(model, batch))?.version).toBe(2);
    expect(await remoteRepo.records()).toEqual([{ model, batch }]);

    const remoteLog = new ExecutionLog(new RemoteLogStore(baseUrl));
    const entries = await remoteLog.entries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.event === "correction")).toBe(true);
    expect(entries.some((e) => e.event === "release")).toBe(true);
  });

  it("rejects malformed JSON and path-traversal parameters cleanly", async () => {
    const badJson = await fetch(`${baseUrl}/api/jobs/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(badJson.status).toBe(400);

    const traversal = await fetch(`${baseUrl}/api/records/..%2Fetc/passwd/history`);
    expect(traversal.status).toBe(400);
  });
});
