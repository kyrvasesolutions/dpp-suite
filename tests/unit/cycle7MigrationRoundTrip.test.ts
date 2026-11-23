// @vitest-environment node
/**
 * Cycle 7 Layer 3 (`C7-05`):
 * Forward and backward schema migration round-trip on a production-like hot copy (`VACUUM INTO`)
 * containing multiple batches, correction chains, retained + legal-hold evidence objects, import
 * jobs, receipts, execution log hash chain, and retention policy:
 *   v5 (baseline checksum) -> hot copy -> v6 -> populate C7 identity & config tables
 *   -> verify atomic refusal of v6->v4 over retained data -> migrateDown(v5) (exact baseline checksum!)
 *   -> migrateUp(v6) (exact baseline checksum preserved, every snapshot/evidence/log intact!).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readPack } from "../../config/contractPack";
import { GrantStore } from "../../server/auth/grantStore";
import { SqliteAdapter } from "../../server/db/adapter";
import { computeStoreChecksum, currentMigrationVersion, migrateDown, migrateUp } from "../../server/db/migrations";
import { ImportJobRunner } from "../../server/jobs/importJobRunner";
import { ConfigReleaseStore } from "../../server/releases/configReleaseStore";
import { PolicyStore } from "../../server/store/policyStore";
import { generateRelease } from "../../src/model/outputs/release";
import { releaseEvents } from "../../src/model/log";
import { resolveCallerTimeEnvelope } from "../../src/model/pContracts";
import type { PackSource, ProfilePack } from "../../src/model/profile";
import { OPERATOR } from "../../src/model/recordRepository";
import { fixtureBytes } from "../support/fixtures";
import { buildPackageProposal } from "../support/oidc";
import { CLEAN, loadPack } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const tmpDir = mkdtempSync(join(tmpdir(), "dpp-c7-mig-"));
const NOW = "2026-11-22T12:00:00.000Z";
let pack: ProfilePack;
let packSource: PackSource;

beforeAll(async () => {
  packSource = readPack("contracts/n");
  pack = await loadPack();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Cycle 7 forward/backward migration checksum preservation on a production-like copy (C7-05)", () => {
  it("preserves exact store checksums across v5 -> v6 -> v5 -> v6 with zero data loss or corruption", async () => {
    const prodPath = join(tmpDir, "prod-v5.sqlite");
    const copyPath = join(tmpDir, "prod-copy.sqlite");

    // 1. Construct a realistic production-like v5 database with multi-batch snapshots, corrections,
    //    evidence (one on legal hold), failed/rolled-back jobs, receipts, and release logs.
    const prodDb = new SqliteAdapter({ path: prodPath });
    migrateUp(prodDb, 5);
    expect(currentMigrationVersion(prodDb)).toBe(5);
    new PolicyStore(prodDb).activate(pack.policy.retention, NOW);

    const runner = new ImportJobRunner(prodDb, pack, undefined, { now: () => NOW });

    const ev1 = new TextEncoder().encode("mill-certificate-batch-1-payload");
    const ev1Sha = createHash("sha256").update(ev1).digest("hex");
    const ev2 = new TextEncoder().encode("lab-analysis-batch-2-payload");
    const ev2Sha = createHash("sha256").update(ev2).digest("hex");

    // Batch 1 import + two corrections (v1 -> v2 -> v3) + release
    const r1 = await runner.runImportJob({
      idempotencyKey: "prod-b1-v1",
      actor: OPERATOR,
      expectedVersion: 0,
      erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
      lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
      evidence: [
        {
          evidenceId: "EV-PROD-1",
          issuer: "Mill QA",
          revision: "1",
          recordKind: "mill-certificate",
          declaredSha256: ev1Sha,
          contentBytes: ev1,
          legalHold: true,
        },
      ],
    });
    expect(r1.ok).toBe(true);
    const { model, batch } = r1.snapshot!;
    const batch2 = `${batch}-B2`;
    const cleanErpText = new TextDecoder().decode(fixtureBytes("n", CLEAN.erp));
    const batch2ErpText = cleanErpText.replaceAll(batch, batch2);
    expect(batch2ErpText).not.toBe(cleanErpText);

    const prop = pack.properties.find((p) => p.definitionRef.endsWith(":recycled-content"))!;
    const c2 = runner.repository.correctRecordAtomic(
      pack,
      { model, batch, property: prop.id, raw: "43", reason: "First production QA adjustment" },
      { actor: OPERATOR, expectedVersion: 1, timeEnvelope: resolveCallerTimeEnvelope(undefined, NOW) },
    );
    await runner.logCorrection(model, batch, c2.snapshot.version);

    const c3 = runner.repository.correctRecordAtomic(
      pack,
      { model, batch, property: prop.id, raw: "44", reason: "Second production QA adjustment" },
      { actor: OPERATOR, expectedVersion: 2, timeEnvelope: resolveCallerTimeEnvelope(undefined, NOW) },
    );
    await runner.logCorrection(model, batch, c3.snapshot.version);

    const rel = await generateRelease(pack, c3.snapshot, { software: TEST_SOFTWARE, by: OPERATOR });
    for (const ev of await releaseEvents(model, batch, c3.snapshot.version, rel.outcomes)) {
      runner.logStore.addSync(ev);
    }

    // Batch 2 import + separate evidence
    const r2 = await runner.runImportJob({
      idempotencyKey: "prod-b2-v1",
      actor: OPERATOR,
      erp: { bytes: new TextEncoder().encode(batch2ErpText), name: "erp-b2.csv", type: "text/csv" },
      evidence: [
        {
          evidenceId: "EV-PROD-2",
          issuer: "External Lab",
          revision: "2",
          recordKind: "test-report",
          declaredSha256: ev2Sha,
          contentBytes: ev2,
        },
      ],
    });
    expect(r2.ok).toBe(true);

    // One rejected import job so failed job_events also populate v5 tables
    const rBad = await runner.runImportJob({
      idempotencyKey: "prod-bad-1",
      actor: OPERATOR,
      erp: { bytes: new TextEncoder().encode("not,a,valid,erp"), name: "bad.csv", type: "text/csv" },
    });
    expect(rBad.ok).toBe(false);

    // Record exact v5 baseline checksum & take hot VACUUM INTO copy
    const baselineChecksum = computeStoreChecksum(prodDb);
    const baselineSnapCount = prodDb.get<{ n: number }>("SELECT COUNT(*) AS n FROM snapshots")!.n;
    const baselineEvCount = prodDb.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence_store")!.n;
    const baselineLogCount = prodDb.get<{ n: number }>("SELECT COUNT(*) AS n FROM execution_log")!.n;
    expect(baselineSnapCount).toBe(4);
    expect(baselineEvCount).toBe(2);
    expect(baselineLogCount).toBeGreaterThanOrEqual(4);

    prodDb.backup(copyPath);
    prodDb.close();

    // 2. Open production-like copy and run forward migration v5 -> v6
    const copyDb = new SqliteAdapter({ path: copyPath });
    try {
      expect(currentMigrationVersion(copyDb)).toBe(5);
      expect(computeStoreChecksum(copyDb)).toBe(baselineChecksum);

      migrateUp(copyDb, 6);
      expect(currentMigrationVersion(copyDb)).toBe(6);
      expect(computeStoreChecksum(copyDb)).toBe(baselineChecksum);

      // Populate Cycle 7 identity + multi-release predecessor chain in config_packages while on v6
      const grants = new GrantStore(copyDb, undefined, { now: () => NOW });
      grants.upsertUser({ sub: "admin-1", displayName: "Admin", roles: ["ADMIN"], actorSub: "bootstrap", reason: "Migration test" });
      const cfg = new ConfigReleaseStore(copyDb, undefined, { now: () => NOW });
      const initRel = await cfg.bootstrapActivePack(packSource, pack.id, pack.version);
      const nextProp = buildPackageProposal(packSource, {
        version: "1.1.0",
        predecessorReleaseId: initRel.releaseId,
        note: "Predecessor chain test before v6->v5 rollback",
        mutateFiles: (files) => {
          files["code-lists/TEMPER@1.0.0.csv"] = `${files["code-lists/TEMPER@1.0.0.csv"]}H14\n`;
        },
      });
      await cfg.propose(nextProp, "cur-1");

      // Verify release_id NOT NULL constraint & IS NOT trigger hardening
      expect(() =>
        copyDb.run("UPDATE config_packages SET release_id = NULL WHERE release_id = ?", initRel.releaseId),
      ).toThrow(/immutable|NOT NULL/i);

      // Atomic refusal: rolling back past v5 (into v4, which drops retained triggers) fails atomically at v6!
      expect(() => migrateDown(copyDb, 4)).toThrow(/retained or legal-hold/i);
      expect(currentMigrationVersion(copyDb)).toBe(6);

      // 3. Backward migration v6 -> v5 (with 2-release predecessor chain!): exact baseline checksum preserved
      migrateDown(copyDb, 5);
      expect(currentMigrationVersion(copyDb)).toBe(5);
      expect(computeStoreChecksum(copyDb)).toBe(baselineChecksum);

      const c7Tables = copyDb.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'role_grants', 'grant_events', 'config_packages', 'config_package_events', 'domain_retention_policies')",
      );
      expect(c7Tables).toHaveLength(0);

      // 4. Re-forward migration v5 -> v6: exact baseline checksum STILL preserved, every record/blob intact
      migrateUp(copyDb, 6);
      expect(currentMigrationVersion(copyDb)).toBe(6);
      expect(computeStoreChecksum(copyDb)).toBe(baselineChecksum);

      const afterRunner = new ImportJobRunner(copyDb, pack, undefined, { now: () => NOW });
      expect(afterRunner.repository.historySync(model, batch)).toHaveLength(3);
      expect(afterRunner.repository.historySync(model, batch2)).toHaveLength(1);
      expect(afterRunner.evidenceStore.get(ev1Sha)?.legalHold).toBe(true);
      expect(afterRunner.evidenceStore.get(ev2Sha)?.sha256).toBe(ev2Sha);
      expect(afterRunner.logStore.allSync()).toHaveLength(baselineLogCount);
    } finally {
      copyDb.close();
    }
  });
});
