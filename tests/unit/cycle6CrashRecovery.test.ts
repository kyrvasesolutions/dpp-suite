// @vitest-environment node
/**
 * Cycle 6 Layer 3 (AT-U): crash injection at every pipeline stage on a real on-disk SQLite WAL
 * database, closing and reopening the database between crash and recovery to verify clean resume
 * or atomic rollback with zero orphaned snapshots, evidence rows, or log corruption (C6-04).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../server/db/adapter";
import { migrateUp } from "../../server/db/migrations";
import { ImportJobRunner, SimulatedCrashError } from "../../server/jobs/importJobRunner";
import { PolicyStore } from "../../server/store/policyStore";
import type { CrashPoint } from "../../src/model/pContracts";
import type { ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, loadPack } from "../support/records";

const tmpDirs: string[] = [];
const mkDbPath = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `dpp-c6-crash-${label}-`));
  tmpDirs.push(dir);
  return join(dir, "crash.sqlite");
};

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("Cycle 6 staged job crash injection and recovery (C6-04)", () => {
  const preStagePoints: CrashPoint[] = ["after-receive", "after-classify", "after-validate"];

  it.each(preStagePoints)(
    "rolls back cleanly on restart after crash at %s and allows idempotent retry to commit v1",
    async (crashPoint) => {
      const dbPath = mkDbPath(crashPoint);

      // Process 1: starts job and crashes mid-flight before staging
      const db1 = new SqliteAdapter({ path: dbPath });
      try {
        migrateUp(db1);
        new PolicyStore(db1).activate(pack.policy.retention);
        const runner1 = new ImportJobRunner(db1, pack);

        await expect(
          runner1.runImportJob({
            idempotencyKey: `key-${crashPoint}`,
            erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
            lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
            evidence: [
              {
                evidenceId: "EV-CRASH-1",
                issuer: "Demo Lab",
                revision: "1",
                recordKind: "test-report",
                contentBytes: new TextEncoder().encode("evidence-payload"),
              },
            ],
            injectCrashAt: crashPoint,
          }),
        ).rejects.toThrow(SimulatedCrashError);
      } finally {
        db1.close();
      }

      // Process 2 (fresh restart from disk): recovers cleanly -> rolls back incomplete pre-stage job
      const db2 = new SqliteAdapter({ path: dbPath });
      try {
        const runner2 = new ImportJobRunner(db2, pack);
        const report = runner2.recoverPendingJobs();
        expect(report.scanned).toBe(1);
        expect(report.resumed).toHaveLength(0);
        expect(report.rolledBack).toHaveLength(1);

        // Zero partial snapshots, evidence, or receipts left behind
        expect(runner2.repository.recordsSync()).toHaveLength(0);
        expect(runner2.evidenceStore.list()).toHaveLength(0);
        const job = runner2.getJobByIdempotencyKey(`key-${crashPoint}`)!;
        expect(job.state).toBe("rolled_back");
        expect(job.stage).toBe("rolled_back");

        // Operator retries with the exact same idempotencyKey -> commits cleanly to v1
        const retry = await runner2.runImportJob({
          idempotencyKey: `key-${crashPoint}`,
          erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
          lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
          evidence: [
            {
              evidenceId: "EV-CRASH-1",
              issuer: "Demo Lab",
              revision: "1",
              recordKind: "test-report",
              contentBytes: new TextEncoder().encode("evidence-payload"),
            },
          ],
        });
        expect(retry.ok).toBe(true);
        expect(retry.job.state).toBe("committed");
        expect(retry.receipt?.version).toBe(1);
        expect(retry.receipt?.stored).toBe(true);
        expect(runner2.repository.recordsSync()).toHaveLength(1);
        expect(runner2.evidenceStore.list()).toHaveLength(1);
      } finally {
        db2.close();
      }
    },
  );

  const stagedPoints: CrashPoint[] = ["after-stage", "before-commit"];

  it.each(stagedPoints)(
    "resumes durably staged job cleanly to committed v1 on restart after crash at %s",
    async (crashPoint) => {
      const dbPath = mkDbPath(crashPoint);

      const db1 = new SqliteAdapter({ path: dbPath });
      try {
        migrateUp(db1);
        new PolicyStore(db1).activate(pack.policy.retention);
        const runner1 = new ImportJobRunner(db1, pack);

        await expect(
          runner1.runImportJob({
            idempotencyKey: `key-${crashPoint}`,
            erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
            lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
            evidence: [
              {
                evidenceId: "EV-STAGE-1",
                issuer: "Demo Lab",
                revision: "1",
                recordKind: "test-report",
                contentBytes: new TextEncoder().encode("staged-evidence-payload"),
              },
            ],
            injectCrashAt: crashPoint,
          }),
        ).rejects.toThrow(SimulatedCrashError);

        // Before restart: staged in DB, zero snapshots yet
        expect(runner1.repository.recordsSync()).toHaveLength(0);
      } finally {
        db1.close();
      }

      // Process 2 (fresh restart from disk): automatically resumes staged job to committed v1
      const db2 = new SqliteAdapter({ path: dbPath });
      try {
        const runner2 = new ImportJobRunner(db2, pack);
        const report = runner2.recoverPendingJobs();
        expect(report.scanned).toBe(1);
        expect(report.resumed).toHaveLength(1);
        expect(report.rolledBack).toHaveLength(0);

        const job = runner2.getJobByIdempotencyKey(`key-${crashPoint}`)!;
        expect(job.state).toBe("committed");
        expect(job.resultVersion).toBe(1);
        expect(runner2.repository.recordsSync()).toHaveLength(1);
        expect(runner2.evidenceStore.list()).toHaveLength(1);
        expect(runner2.getJobEvents(job.jobId).some((e) => e.stage === "committed" && e.outcome === "recovered")).toBe(true);

        // Re-sending the same idempotencyKey after recovery is idempotent (stored=false)
        const replay = await runner2.runImportJob({
          idempotencyKey: `key-${crashPoint}`,
          erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
          lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
        });
        expect(replay.ok).toBe(true);
        expect(replay.receipt?.stored).toBe(false);
        expect(replay.receipt?.version).toBe(1);
      } finally {
        db2.close();
      }
    },
  );

  it("handles crash at after-commit idempotently with zero duplicate snapshots on retry", async () => {
    const dbPath = mkDbPath("after-commit");
    const db1 = new SqliteAdapter({ path: dbPath });
    try {
      migrateUp(db1);
      new PolicyStore(db1).activate(pack.policy.retention);
      const runner1 = new ImportJobRunner(db1, pack);

      await expect(
        runner1.runImportJob({
          idempotencyKey: "key-after-commit",
          erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
          lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
          injectCrashAt: "after-commit",
        }),
      ).rejects.toThrow(SimulatedCrashError);
    } finally {
      db1.close();
    }

    const db2 = new SqliteAdapter({ path: dbPath });
    try {
      const runner2 = new ImportJobRunner(db2, pack);
      const report = runner2.recoverPendingJobs();
      expect(report.scanned).toBe(0);

      const replay = await runner2.runImportJob({
        idempotencyKey: "key-after-commit",
        erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
        lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
      });
      expect(replay.ok).toBe(true);
      expect(replay.receipt?.stored).toBe(false);
      expect(replay.receipt?.version).toBe(1);
      expect(runner2.repository.recordsSync()).toHaveLength(1);
    } finally {
      db2.close();
    }
  });

  it("rolls back instead of committing if durable staged_payload_json was tampered with on disk", async () => {
    const dbPath = mkDbPath("tampered-stage");
    const db1 = new SqliteAdapter({ path: dbPath });
    try {
      migrateUp(db1);
      new PolicyStore(db1).activate(pack.policy.retention);
      const runner1 = new ImportJobRunner(db1, pack);
      await expect(
        runner1.runImportJob({
          idempotencyKey: "key-tamper",
          erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
          lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
          injectCrashAt: "after-stage",
        }),
      ).rejects.toThrow(SimulatedCrashError);

      // Tamper with staged payload in SQLite without updating record.digest
      db1.run("UPDATE import_jobs SET staged_payload_json = replace(staged_payload_json, 'EN AW-5754', 'TAMPERED')");
    } finally {
      db1.close();
    }

    const db2 = new SqliteAdapter({ path: dbPath });
    try {
      const runner2 = new ImportJobRunner(db2, pack);
      const report = runner2.recoverPendingJobs();
      expect(report.scanned).toBe(1);
      expect(report.resumed).toHaveLength(0);
      expect(report.rolledBack).toHaveLength(1);
      expect(runner2.repository.recordsSync()).toHaveLength(0);
      expect(runner2.getJobByIdempotencyKey("key-tamper")?.errorCode).toBe("staged-digest-mismatch");
    } finally {
      db2.close();
    }
  });
});
