// @vitest-environment node
/**
 * Cycle 10 Layer 3 (`FUNC-105`):
 * Verifies DPPSP migration & customer exit package export, fresh-deployment import and
 * record/reference reconciliation, deterministic release reconstruction from retained dependencies,
 * strict retention/classification flooring & legal-hold tightening on replay, wrapper spoofing
 * rejection, strict JSON depth rejection over HTTP, and strict replay invariants:
 *   - replay NEVER restores revoked rights or touches identity grants;
 *   - replay NEVER overwrites previously issued evidence or conflicting snapshots.
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
import { ImportJobRunner } from "../../server/jobs/importJobRunner";
import {
  exportMigrationPackage,
  importMigrationPackage,
  reconstructReleaseFromRetained,
} from "../../server/ops/migrationPackage";
import { PolicyStore } from "../../server/store/policyStore";
import { SqlRecordRepository } from "../../server/store/sqlRepository";
import { canonical } from "../../src/model/canonical";
import { generateRelease } from "../../src/model/outputs/release";
import type { ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "../support/fixtures";
import { createTestIdp } from "../support/oidc";
import { CLEAN, loadPack } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const tmpDir = mkdtempSync(join(tmpdir(), "dpp-c10-migration-"));
const idp = createTestIdp();
const nowIso = "2026-11-27T10:30:00.000Z";
let pack: ProfilePack;

function resealMigrationPkg<T extends { exportedAt: string; substantiveDigest: string }>(pkg: T): T {
  const { exportedAt: _e, substantiveDigest: _d, ...rest } = pkg;
  return {
    ...pkg,
    substantiveDigest: createHash("sha256").update(canonical(rest)).digest("hex"),
  };
}

beforeAll(async () => {
  pack = await loadPack();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Cycle 10 FUNC-105 DPPSP migration & customer exit package", () => {
  it("exports authorised DPPPayload + evidence + interpretation, reconciles on a fresh deployment, and reconstructs identical release digests", async () => {
    const srcDb = new SqliteAdapter({ path: join(tmpDir, "source.sqlite") });
    const freshDb = new SqliteAdapter({ path: join(tmpDir, "fresh.sqlite") });
    try {
      migrateUp(srcDb);
      migrateUp(freshDb);
      new PolicyStore(srcDb).activate(pack.policy.retention, nowIso);
      new PolicyStore(freshDb).activate(pack.policy.retention, nowIso);

      const runner = new ImportJobRunner(srcDb, pack, undefined, { now: () => nowIso });
      const evBytes = Buffer.from("synthetic-migration-evidence-payload", "utf8");
      const evSha = createHash("sha256").update(evBytes).digest("hex");
      const imported = await runner.runImportJob({
        idempotencyKey: "c10-mig-1",
        erp: { name: "erp.csv", type: "text/csv", bytes: fixtureBytes("n", CLEAN.erp!) },
        lab: { name: "lab.json", type: "application/json", bytes: fixtureBytes("n", CLEAN.lab!) },
        evidence: [
          {
            evidenceId: "EV-MIG-01",
            issuer: "Synthetic Lab",
            revision: "1.0",
            recordKind: "certificate",
            contentBytes: evBytes,
            declaredSha256: evSha,
          },
        ],
      });
      expect(imported.job.state).toBe("committed");

      const srcRepo = new SqlRecordRepository(srcDb);
      const recs = srcRepo.recordsSync();
      expect(recs).toHaveLength(1);
      const { model, batch } = recs[0]!;
      const srcSnap = (await srcRepo.history(model, batch))[0]!;
      const originalRelease = await generateRelease(pack, srcSnap, { software: TEST_SOFTWARE });

      const pkg = exportMigrationPackage(srcDb, pack, {
        exportedBy: "ops-admin",
        reason: "Authorised customer exit test",
        nowIso,
      });
      expect(pkg.format).toBe("dpp-migration-package@1.0.0");
      expect(pkg.restrictions.excludesIdentityGrants).toBe(true);
      expect(pkg.restrictions.replayNeverRestoresRevokedRights).toBe(true);
      expect(pkg.restrictions.replayNeverOverwritesIssuedEvidence).toBe(true);
      expect(pkg.reconciliation.recordCount).toBe(1);
      expect(pkg.reconciliation.evidenceCount).toBeGreaterThanOrEqual(1);
      expect(pkg.records[0]!.dppPayload["@context"]).toBeDefined();

      const impResult = importMigrationPackage(freshDb, pack, JSON.stringify(pkg), { nowIso });
      expect(impResult.mismatches).toEqual([]);
      expect(impResult.grantsTouched).toBe(false);
      expect(impResult.reconciledRecords).toBe(1);
      expect(impResult.addedSnapshots).toBe(pkg.reconciliation.snapshotCount);
      expect(impResult.addedEvidence).toBe(pkg.reconciliation.evidenceCount);
      expect(impResult.addedReceipts).toBe(pkg.reconciliation.receiptCount);

      const reconstructed = await reconstructReleaseFromRetained(freshDb, pack, {
        model,
        batch,
        version: 1,
        software: TEST_SOFTWARE,
        expectedSubstantiveDigest: originalRelease.manifestFile.substantiveDigest,
      });
      expect(reconstructed.matchesExpected).toBe(true);
      expect(reconstructed.substantiveDigest).toBe(originalRelease.manifestFile.substantiveDigest);
    } finally {
      srcDb.close();
      freshDb.close();
    }
  });

  it("never restores revoked rights, tightens legal holds on replay, floors downgraded retention, and rejects spoofed wrappers or deep JSON over HTTP", async () => {
    const db = new SqliteAdapter({ path: join(tmpDir, "replay-sec.sqlite") });
    const floorDb = new SqliteAdapter({ path: join(tmpDir, "floor-check.sqlite") });
    try {
      migrateUp(db);
      migrateUp(floorDb);
      new PolicyStore(db).activate(pack.policy.retention, nowIso);
      new PolicyStore(floorDb).activate(pack.policy.retention, nowIso);

      const grants = new GrantStore(db, undefined, { now: () => nowIso });
      grants.upsertUser({ sub: "admin-1", displayName: "Admin", roles: ["ACT-19"], actorSub: "bootstrap", reason: "Seed admin" });
      grants.upsertUser({ sub: "ex-op", displayName: "Former Operator", roles: ["ACT-01"], actorSub: "admin-1", reason: "Seed operator" });

      const runner = new ImportJobRunner(db, pack, undefined, { now: () => nowIso });
      const evBytes = Buffer.from("immutable-issued-evidence-v1", "utf8");
      const evSha = createHash("sha256").update(evBytes).digest("hex");
      await runner.runImportJob({
        idempotencyKey: "c10-replay-1",
        erp: { name: "erp.csv", type: "text/csv", bytes: fixtureBytes("n", CLEAN.erp!) },
        lab: { name: "lab.json", type: "application/json", bytes: fixtureBytes("n", CLEAN.lab!) },
        evidence: [
          {
            evidenceId: "EV-IMMUT-01",
            issuer: "Synthetic Lab",
            revision: "1.0",
            recordKind: "certificate",
            contentBytes: evBytes,
            declaredSha256: evSha,
            legalHold: false,
          },
        ],
      });

      const pkg = exportMigrationPackage(db, pack, {
        exportedBy: "admin-1",
        reason: "Pre-revocation archive",
        nowIso,
      });

      // Revoke & deactivate ex-op
      grants.deactivateUser("ex-op", "admin-1", "Operator left organization");
      const afterRevoke = grants.getUser("ex-op")!;
      expect(afterRevoke.active).toBe(false);
      const revokedEpoch = afterRevoke.grantEpoch;

      // Replay with legalHold tightened to true on existing evidence -> tightens DB legal_hold = 1 without overwriting blob or restoring rights
      const heldPkg = resealMigrationPkg({
        ...pkg,
        evidence: pkg.evidence.map((e) => ({ ...e, legalHold: true })),
      });
      const replay = importMigrationPackage(db, pack, heldPkg, { nowIso });
      expect(replay.grantsTouched).toBe(false);
      expect(replay.addedSnapshots).toBe(0);
      expect(replay.skippedSnapshots).toBe(pkg.reconciliation.snapshotCount);
      expect(replay.skippedEvidence).toBe(pkg.reconciliation.evidenceCount);

      const evRow = db.get<{ legal_hold: number }>("SELECT legal_hold FROM evidence_store WHERE sha256 = ?", evSha);
      expect(Number(evRow?.legal_hold)).toBe(1);
      expect(grants.getUser("ex-op")!.active).toBe(false);
      expect(grants.getUser("ex-op")!.grantEpoch).toBe(revokedEpoch);

      // Crafted package trying to downgrade evidence classification to "public", retentionDays to 1, and backdate storedAt/retentionUntil is floored to restricted / >= 3650d from max(storedAt, importedAt)
      const downgradedPkg = resealMigrationPkg({
        ...pkg,
        evidence: pkg.evidence.map((e) => ({
          ...e,
          classification: "public" as const,
          retentionDays: 1,
          storedAt: "1990-01-01T00:00:00.000Z",
          retentionUntil: "2000-01-01T00:00:00.000Z",
        })),
      });
      importMigrationPackage(floorDb, pack, downgradedPkg, { nowIso });
      const flooredEv = floorDb.get<{ classification: string; retention_days: number; retention_until: string }>(
        "SELECT classification, retention_days, retention_until FROM evidence_store WHERE sha256 = ?",
        evSha,
      );
      expect(flooredEv?.classification).toBe("restricted");
      expect(Number(flooredEv?.retention_days)).toBeGreaterThanOrEqual(3650);
      expect(Date.parse(flooredEv!.retention_until)).toBeGreaterThan(Date.parse("2035-01-01T00:00:00.000Z"));

      // Spoofed snapshot wrapper metadata (actor changed without matching payloadJson) is refused even when package is re-sealed
      const spoofedWrapper = resealMigrationPkg({
        ...pkg,
        records: pkg.records.map((r) => ({
          ...r,
          snapshots: r.snapshots.map((s) => ({ ...s, actor: "SPOOFED-ACTOR" })),
        })),
      });
      expect(() => importMigrationPackage(floorDb, pack, spoofedWrapper, { nowIso })).toThrow(/disagrees with payloadJson/);

      // Tampered digest is refused
      expect(() => importMigrationPackage(db, pack, { ...pkg, reason: "tampered-reason" }, { nowIso })).toThrow(/substantiveDigest/);

      // Deeply nested hostile JSON over HTTP POST /api/admin/migration/import is rejected with 400 by parseStrictJson
      const server = createDppServer({
        db,
        pack,
        software: TEST_SOFTWARE,
        authMode: "oidc",
        surface: "internal",
        oidc: idp.oidcConfig,
        now: () => nowIso,
      });
      await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
      const port = (server.address() as AddressInfo).port;
      try {
        const nowSec = Math.floor(Date.parse(nowIso) / 1000);
        const tAdmin = idp.signRs256({ sub: "admin-1", iat: nowSec - 60, exp: nowSec + 3600 });
        const deep = '{"a":'.repeat(40) + "1" + "}".repeat(40);
        const deepRes = await fetch(`http://127.0.0.1:${port}/api/admin/migration/import`, {
          method: "POST",
          headers: { Authorization: `Bearer ${tAdmin}`, "Content-Type": "application/json" },
          body: deep,
        });
        expect(deepRes.status).toBe(400);
      } finally {
        await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
      }
    } finally {
      db.close();
      floorDb.close();
    }
  });
});
