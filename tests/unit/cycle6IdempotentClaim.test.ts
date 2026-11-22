// @vitest-environment node
/**
 * Cycle 6: one idempotency key is claimed atomically (C6-03). The same key sent concurrently, with the same
 * payload or a different one, never corrupts the job, never returns a 500, and never records mixed digests.
 * Also: recovery leaves running jobs alone, and the two crash points before a commit are different points (C6-04).
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SqliteAdapter } from "../../server/db/adapter";
import { migrateUp } from "../../server/db/migrations";
import { createDppServer } from "../../server/http/api";
import { ImportJobRunner, SimulatedCrashError } from "../../server/jobs/importJobRunner";
import { PolicyStore } from "../../server/store/policyStore";
import { SqlRecordRepository } from "../../server/store/sqlRepository";
import { ConcurrencyConflictError } from "../../src/model/pContracts";
import type { ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, loadPack, text } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const tmpDirs: string[] = [];
const mkDbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "dpp-c6-claim-"));
  tmpDirs.push(dir);
  return join(dir, "claim.sqlite");
};
const enc = (s: string) => new TextEncoder().encode(s);
const erpA = () => fixtureBytes("n", CLEAN.erp);
const erpB = () => enc(text(CLEAN.erp).replace(";62.0;", ";68.5;"));
const lab = () => fixtureBytes("n", CLEAN.lab);
const job = (key: string, erp: Uint8Array) => ({
  idempotencyKey: key,
  erp: { bytes: erp, name: CLEAN.erp, type: "text/csv" },
  lab: { bytes: lab(), name: CLEAN.lab, type: "application/json" },
});

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const fresh = () => {
  const db = new SqliteAdapter({ path: mkDbPath() });
  migrateUp(db);
  new PolicyStore(db).activate(pack.policy.retention);
  return db;
};

describe("Cycle 6 atomic idempotency claim (C6-03)", () => {
  it("same key, same payload, in parallel: one version, one job, both callers get the same result", async () => {
    const db = fresh();
    try {
      const results = await Promise.all(
        [1, 2, 3, 4].map(() => new ImportJobRunner(db, pack).runImportJob(job("same-same", erpA()))),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      expect(new Set(results.map((r) => r.receipt?.receiptId)).size).toBe(1);
      expect(new Set(results.map((r) => r.snapshot?.digest)).size).toBe(1);
      expect(results.every((r) => r.receipt?.version === 1)).toBe(true);

      const runner = new ImportJobRunner(db, pack);
      expect(runner.listJobs()).toHaveLength(1);
      const row = db.get<{ state: string; stage: string; staged_payload_json: string | null }>(
        "SELECT state, stage, staged_payload_json FROM import_jobs",
      )!;
      expect(row).toMatchObject({ state: "committed", stage: "committed", staged_payload_json: null });
      const [rec] = runner.repository.recordsSync();
      expect(runner.repository.historySync(rec!.model, rec!.batch)).toHaveLength(1);
      expect(db.get("SELECT COUNT(*) AS n FROM update_receipts")).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("same key, different payloads, in parallel: one wins, the other is a 409-class conflict, no mixed digests", async () => {
    const db = fresh();
    try {
      const settled = await Promise.allSettled([
        new ImportJobRunner(db, pack).runImportJob(job("same-diff", erpA())),
        new ImportJobRunner(db, pack).runImportJob(job("same-diff", erpB())),
      ]);
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      const lost = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(ConcurrencyConflictError);
      expect(lost.reason.code).toBe("idempotency-conflict");

      const winner = (settled.find((s) => s.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<ImportJobRunner["runImportJob"]>>>).value;
      const row = db.get<{ erp_sha256: string; state: string }>("SELECT erp_sha256, state FROM import_jobs")!;
      expect(row.state).toBe("committed");
      // the digest on the job is the digest of the file in the stored version
      const erpSource = winner.snapshot!.sources.find((s) => s.role === "erp")!;
      expect(row.erp_sha256).toBe(erpSource.sha256);

      // replaying the loser's payload is refused; replaying the winner's returns the winner's result
      const runner = new ImportJobRunner(db, pack);
      const loserErp = erpSource.sha256 === (await sha(erpA())) ? erpB() : erpA();
      await expect(runner.runImportJob(job("same-diff", loserErp))).rejects.toMatchObject({ code: "idempotency-conflict" });
      const winnerErp = loserErp === erpB() || erpSource.sha256 === (await sha(erpA())) ? erpA() : erpB();
      const replay = await runner.runImportJob(job("same-diff", winnerErp));
      expect(replay.receipt?.snapshotDigest).toBe(winner.snapshot!.digest);
      expect(replay.receipt?.stored).toBe(false);
    } finally {
      db.close();
    }
  });

  it("two connections to the same file race for one key: one claim, the other a conflict or the same result, never a constraint 500", async () => {
    const path = mkDbPath();
    const dbA = new SqliteAdapter({ path });
    const dbB = new SqliteAdapter({ path });
    try {
      migrateUp(dbA);
      new PolicyStore(dbA).activate(pack.policy.retention);
      const settled = await Promise.allSettled([
        new ImportJobRunner(dbA, pack).runImportJob(job("two-conn", erpA())),
        new ImportJobRunner(dbB, pack).runImportJob(job("two-conn", erpB())),
      ]);
      for (const s of settled) {
        if (s.status === "rejected") expect(s.reason).toBeInstanceOf(ConcurrencyConflictError);
      }
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      expect(dbA.get("SELECT COUNT(*) AS n FROM import_jobs")).toEqual({ n: 1 });
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  it("refuses a failed or rolled-back job's key for a different payload, and lets the same payload retry", async () => {
    const db = fresh();
    try {
      const runner = new ImportJobRunner(db, pack);
      await expect(runner.runImportJob({ ...job("retry-key", erpA()), injectCrashAt: "after-validate" })).rejects.toThrow(SimulatedCrashError);
      expect(runner.recoverPendingJobs().rolledBack).toHaveLength(1);
      await expect(runner.runImportJob(job("retry-key", erpB()))).rejects.toMatchObject({ code: "idempotency-conflict" });
      const retry = await runner.runImportJob(job("retry-key", erpA()));
      expect(retry.ok).toBe(true);
      expect(retry.job.state).toBe("committed");
    } finally {
      db.close();
    }
  });

  it("over HTTP: parallel identical and different requests answer 200 or 409, never 500", async () => {
    const db = fresh();
    const server = createDppServer({ db, pack, software: TEST_SOFTWARE });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (key: string, erp: Uint8Array) =>
      fetch(`${base}/api/jobs/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Idempotency-Key": key },
        body: JSON.stringify({
          erp: { name: CLEAN.erp, type: "text/csv", base64: Buffer.from(erp).toString("base64") },
          lab: { name: CLEAN.lab, type: "application/json", base64: Buffer.from(lab()).toString("base64") },
        }),
      });
    try {
      const same = await Promise.all([post("http-same", erpA()), post("http-same", erpA()), post("http-same", erpA())]);
      expect(same.map((r) => r.status)).toEqual([200, 200, 200]);
      const bodies = (await Promise.all(same.map((r) => r.json()))) as Array<{ receipt: { receiptId: string; version: number } }>;
      expect(new Set(bodies.map((b) => b.receipt.receiptId)).size).toBe(1);

      const diff = await Promise.all([post("http-diff", erpA()), post("http-diff", erpB())]);
      expect(diff.map((r) => r.status).sort()).toEqual([200, 409]);
      const row = db.get<{ state: string; stage: string; staged_payload_json: string | null }>(
        "SELECT state, stage, staged_payload_json FROM import_jobs WHERE idempotency_key = 'http-diff'",
      )!;
      expect(row).toMatchObject({ state: "committed", stage: "committed", staged_payload_json: null });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    }
  });
});

describe("Cycle 6 recovery and crash points (C6-04)", () => {
  it("recovery never touches a job that is still running in this process", async () => {
    const db = fresh();
    try {
      const runner = new ImportJobRunner(db, pack);
      const running = runner.runImportJob(job("still-running", erpA())); // not awaited: the job is mid-flight
      const report = runner.recoverPendingJobs();
      expect(report).toEqual({ scanned: 0, resumed: [], rolledBack: [] });
      expect(runner.getJobByIdempotencyKey("still-running")?.state).toBe("running");
      const done = await running;
      expect(done.ok).toBe(true);
      expect(runner.getJobByIdempotencyKey("still-running")?.state).toBe("committed");
    } finally {
      db.close();
    }
  });

  it("recovery leaves a running job of another process alone until its lease ends, unless forced at start-up", () => {
    const db = fresh();
    try {
      const runner = new ImportJobRunner(db, pack);
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO import_jobs (job_id, security_domain, idempotency_key, actor, state, stage, classification,
           retention_policy_pin, erp_sha256, lab_sha256, input_key, owner, created_at, updated_at)
         VALUES ('JOB-OTHER', 'default', 'other-process', 'ACT-01', 'running', 'received', 'restricted',
           'RETENTION@1.0.0', 'e', NULL, 'e:-:erp-extract', 'some-other-process', ?, ?)`,
        now,
        now,
      );
      expect(runner.recoverPendingJobs().scanned).toBe(0);
      expect(runner.getJob("JOB-OTHER")?.state).toBe("running");
      expect(runner.recoverPendingJobs({ force: true }).rolledBack).toEqual(["JOB-OTHER"]);
    } finally {
      db.close();
    }
  });

  it("after-stage and before-commit are different points: only the second starts the commit and rolls it back", async () => {
    for (const point of ["after-stage", "before-commit"] as const) {
      const db = fresh();
      const spy = vi.spyOn(SqlRecordRepository.prototype, "storeRecordAtomic");
      try {
        const runner = new ImportJobRunner(db, pack);
        await expect(runner.runImportJob({ ...job(`crash-${point}`, erpA()), injectCrashAt: point })).rejects.toThrow(SimulatedCrashError);
        expect(spy.mock.calls.length, point).toBe(point === "before-commit" ? 1 : 0);
        // either way nothing is committed and the staged payload is what recovery resumes from
        const row = db.get<{ state: string; stage: string; staged_payload_json: string | null }>("SELECT state, stage, staged_payload_json FROM import_jobs")!;
        expect(row.state).toBe("running");
        expect(row.stage).toBe("staged");
        expect(row.staged_payload_json).not.toBeNull();
        expect(runner.repository.recordsSync()).toHaveLength(0);
        expect(db.get("SELECT COUNT(*) AS n FROM update_receipts")).toEqual({ n: 0 });
        expect(runner.recoverPendingJobs().resumed).toHaveLength(1);
        expect(runner.repository.recordsSync()).toHaveLength(1);
      } finally {
        spy.mockRestore();
        db.close();
      }
    }
  });
});

async function sha(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}
