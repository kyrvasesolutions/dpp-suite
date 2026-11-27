// @vitest-environment node
/**
 * Cycle 10 Layer 3: backup, encrypted off-host archival, egress allow-list enforcement,
 * retention/legal-hold pruning, timed restore drill with checksum + evidence SHA-256 verification,
 * append-only backup audit records, and restored-deployment verification.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readPack } from "../../config/contractPack";
import { GrantStore } from "../../server/auth/grantStore";
import { SqliteAdapter } from "../../server/db/adapter";
import { computeStoreChecksum, migrateUp } from "../../server/db/migrations";
import { createDppServer } from "../../server/http/api";
import { ImportJobRunner } from "../../server/jobs/importJobRunner";
import {
  createBackup,
  listBackupRecords,
  pruneExpiredBackups,
  restoreBackup,
  validateOffHostTargetUrl,
  verifyBackup,
} from "../../server/ops/backupManager";
import { ConfigReleaseStore } from "../../server/releases/configReleaseStore";
import { PolicyStore } from "../../server/store/policyStore";
import { canonical } from "../../src/model/canonical";
import { loadProfilePack, type ProfilePack } from "../../src/model/profile";
import { executeReferencePipeline } from "../../src/model/referencePipeline";
import { fixtureBytes } from "../support/fixtures";
import { createTestIdp } from "../support/oidc";
import { CLEAN, loadPack } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const tmpDir = mkdtempSync(join(tmpdir(), "dpp-c10-backup-"));
const idp = createTestIdp();
const nowIso = "2026-11-27T10:00:00.000Z";
let pack: ProfilePack;

beforeAll(async () => {
  pack = await loadPack();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function seedPopulatedStore(dbPath: string, withLegalHold = false): Promise<{ db: SqliteAdapter; evidenceSha: string; checksum: string }> {
  const db = new SqliteAdapter({ path: dbPath });
  migrateUp(db);
  new PolicyStore(db).activate(pack.policy.retention, nowIso);
  const grants = new GrantStore(db, undefined, { now: () => nowIso });
  grants.upsertUser({ sub: "ops-1", displayName: "Ops Admin", roles: ["ACT-19"], actorSub: "bootstrap", reason: "Seed ops admin" });
  grants.upsertUser({ sub: "op-1", displayName: "Operator", roles: ["ACT-01"], actorSub: "ops-1", reason: "Seed operator" });

  const runner = new ImportJobRunner(db, pack, undefined, { now: () => nowIso });
  const erpBytes = fixtureBytes("n", CLEAN.erp!);
  const labBytes = fixtureBytes("n", CLEAN.lab!);
  const evContent = Buffer.from("synthetic-backup-drill-evidence-bytes", "utf8");
  const evSha = createHash("sha256").update(evContent).digest("hex");

  const res = await runner.runImportJob({
    idempotencyKey: "c10-backup-seed-1",
    erp: { name: "erp.csv", type: "text/csv", bytes: erpBytes },
    lab: { name: "lab.json", type: "application/json", bytes: labBytes },
    evidence: [
      {
        evidenceId: "EV-DRILL-01",
        issuer: "Synthetic Lab",
        revision: "1.0",
        recordKind: "test-report",
        contentBytes: evContent,
        declaredSha256: evSha,
        legalHold: withLegalHold,
      },
    ],
  });
  expect(res.job.state).toBe("committed");
  const checksum = computeStoreChecksum(db);
  return { db, evidenceSha: evSha, checksum };
}

describe("Cycle 10 backup, encrypted off-host copy, retention pruning, and timed restore drill", () => {
  it("runs a timed backup + AES-256-GCM encrypted off-host restore drill meeting RPO/RTO with exact checksum & evidence SHA-256 parity", async () => {
    const liveDbPath = join(tmpDir, "live-drill.sqlite");
    const backupRoot = join(tmpDir, "backups-drill");
    const offHostFile = join(tmpDir, "offhost", "drill-archive.dppbk");
    const restoredDbPath = join(tmpDir, "restored-drill.sqlite");
    const keyHex = randomBytes(32).toString("hex");

    const { db, checksum } = await seedPopulatedStore(liveDbPath, false);
    const created = createBackup(db, {
      destDir: backupRoot,
      tier: "15m",
      recordedBy: "ops-1",
      nowIso: "2026-11-27T10:05:00.000Z",
      offHostEncrypt: { outPath: offHostFile, keyHex, keyId: "key-2026-q4", targetLabel: "offhost-drill-vol" },
    });

    expect(created.manifest.storeChecksum).toBe(checksum);
    expect(created.manifest.evidenceCount).toBeGreaterThanOrEqual(1);
    expect(created.manifest.encryptedOffHost?.algorithm).toBe("aes-256-gcm");
    expect(verifyBackup(created.backupDir).manifestDigest).toBe(created.manifest.manifestDigest);

    const rows = listBackupRecords(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.backupId).toBe(created.manifest.backupId);
    expect(() => db.run("UPDATE backup_records SET tier = 'daily' WHERE backup_id = ?", created.manifest.backupId)).toThrow(/append-only/);
    expect(() => db.run("DELETE FROM backup_records WHERE backup_id = ?", created.manifest.backupId)).toThrow(/append-only/);
    db.close();

    // Remove plaintext copy so restore MUST decrypt the AES-256-GCM off-host archive
    rmSync(created.dbPath, { force: true });

    const drill = restoreBackup({
      backupDir: created.backupDir,
      targetDbPath: restoredDbPath,
      fromEncryptedArchive: { archivePath: offHostFile, keyHex },
      incidentLastReceiptAt: "2026-11-27T10:12:00.000Z",
      nowIso: "2026-11-27T10:13:00.000Z",
    });

    expect(drill.passed).toBe(true);
    expect(drill.checksumMatch).toBe(true);
    expect(drill.restoredChecksum).toBe(checksum);
    expect(drill.evidenceVerified).toBe(true);
    expect(drill.evidenceChecked).toBe(created.manifest.evidenceCount);
    expect(drill.rpoSeconds).toBe(420);
    expect(drill.rpoWithinTarget).toBe(true);
    expect(drill.rtoWithinTarget).toBe(true);

    // Boot a live HTTP server against the restored DB and verify records serve cleanly
    const restoredDb = new SqliteAdapter({ path: restoredDbPath });
    const server = createDppServer({
      db: restoredDb,
      pack,
      software: TEST_SOFTWARE,
      authMode: "oidc",
      surface: "all",
      oidc: idp.oidcConfig,
      now: () => "2026-11-27T10:15:00.000Z",
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const port = (server.address() as AddressInfo).port;
    try {
      const nowSec = Math.floor(Date.parse("2026-11-27T10:15:00.000Z") / 1000);
      const token = idp.signRs256({ sub: "op-1", iat: nowSec - 60, exp: nowSec + 3600 });
      const recRes = await fetch(`http://127.0.0.1:${port}/api/records`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(recRes.status).toBe(200);
      const body = (await recRes.json()) as { records: Array<{ model: string; batch: string }> };
      expect(body.records.length).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
      restoredDb.close();
    }
  });

  it("rejects tampered off-host ciphertexts, swapped AAD, wrong keys, and unapproved/port-mismatched/credentialed off-host URLs", async () => {
    const liveDbPath = join(tmpDir, "live-tamper.sqlite");
    const backupRoot = join(tmpDir, "backups-tamper");
    const offHostFile = join(tmpDir, "offhost", "tamper.dppbk");
    const keyHex = randomBytes(32).toString("hex");
    const wrongKeyHex = randomBytes(32).toString("hex");

    const { db } = await seedPopulatedStore(liveDbPath, false);
    const created = createBackup(db, {
      destDir: backupRoot,
      tier: "daily",
      nowIso,
      offHostEncrypt: { outPath: offHostFile, keyHex, keyId: "k1" },
    });
    db.close();

    // Wrong key fails authentication and leaves no corrupt target DB behind
    const wrongTarget = join(tmpDir, "wrong-key.sqlite");
    expect(() =>
      restoreBackup({
        backupDir: created.backupDir,
        targetDbPath: wrongTarget,
        fromEncryptedArchive: { archivePath: offHostFile, keyHex: wrongKeyHex },
      }),
    ).toThrow(/AES-256-GCM authentication/);
    expect(existsSync(wrongTarget)).toBe(false);

    // Tampered ciphertext fails SHA-256 check
    const tamperedPath = join(tmpDir, "offhost", "tamper-corrupt.dppbk");
    const bytes = readFileSync(offHostFile);
    bytes[bytes.length - 1]! ^= 0x01;
    writeFileSync(tamperedPath, bytes);
    expect(() =>
      restoreBackup({
        backupDir: created.backupDir,
        targetDbPath: join(tmpDir, "tampered.sqlite"),
        fromEncryptedArchive: { archivePath: tamperedPath, keyHex },
      }),
    ).toThrow(/SHA-256 does not match/);

    // Swapping backupId while keeping old encryptedOffHost.aad and re-sealing manifestDigest is rejected
    const forgedDir = join(tmpDir, "forged-aad-dir");
    const forgedManifest = { ...created.manifest, backupId: "BK-20261127T100000-deadbeef" };
    const { manifestDigest: _md, ...forgedBody } = forgedManifest;
    const resealed = { ...forgedBody, manifestDigest: createHash("sha256").update(canonical(forgedBody)).digest("hex") };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(forgedDir, { recursive: true });
    writeFileSync(join(forgedDir, "manifest.json"), JSON.stringify(resealed));
    expect(() => verifyBackup(forgedDir, { requireDbFile: false })).toThrow(/AAD/);

    // Strict origin, port, userinfo, and IPv6 egress URL checks
    expect(() => validateOffHostTargetUrl("https://backup.unapproved.example/bucket", [])).toThrow(/egress allow-list/);
    expect(() => validateOffHostTargetUrl("https://user:pass@backup.customer.example/bucket", ["https://backup.customer.example"])).toThrow(/credentials/);
    expect(() => validateOffHostTargetUrl("https://backup.customer.example:9999/bucket", ["https://backup.customer.example:8443"])).toThrow(/origin/);
    expect(() => validateOffHostTargetUrl("http://backup.customer.example/bucket", ["http://backup.customer.example"])).toThrow(/HTTPS/);
    expect(validateOffHostTargetUrl("https://backup.customer.example:8443/bucket", ["https://backup.customer.example:8443"])).toEqual({
      allowed: true,
      origin: "https://backup.customer.example:8443",
    });
    expect(validateOffHostTargetUrl("http://[::1]:4174/bucket", [])).toEqual({ allowed: true, origin: "http://[::1]:4174" });
  });

  it("enforces backup retention floors and never prunes backups carrying legal holds or unexpired retention", async () => {
    const root = join(tmpDir, "backups-prune");
    const heldDbPath = join(tmpDir, "held.sqlite");
    const { db: heldDb } = await seedPopulatedStore(heldDbPath, true);
    const heldBk = createBackup(heldDb, { destDir: root, tier: "15m", nowIso: "2026-11-27T10:00:00.000Z" });
    heldDb.close();

    expect(heldBk.manifest.hasLegalHold).toBe(true);
    const pruneFuture = pruneExpiredBackups(root, "2050-01-01T00:00:00.000Z");
    expect(pruneFuture.deleted).toEqual([]);
    expect(pruneFuture.retained).toEqual([{ backupId: heldBk.manifest.backupId, reason: "legal-hold" }]);

    const root2 = join(tmpDir, "backups-prune-2");
    const unheldDbPath = join(tmpDir, "unheld.sqlite");
    const { db: unheldDb } = await seedPopulatedStore(unheldDbPath, false);
    const unheldBk = createBackup(unheldDb, { destDir: root2, tier: "15m", nowIso: "2026-11-27T10:00:00.000Z" });
    unheldDb.close();

    expect(pruneExpiredBackups(root2, "2026-11-30T10:00:00.000Z").deleted).toEqual([]);
    expect(pruneExpiredBackups(root2, "2037-01-01T00:00:00.000Z").deleted).toEqual([unheldBk.manifest.backupId]);
  });

  const REF_ROOT = resolve("spec/trustainability/reference_package");
  const PRIVATE_PACK_DIR = resolve("spec/contracts/n");
  it.runIf(existsSync(join(REF_ROOT, "fixtures/cases.json")) && existsSync(join(PRIVATE_PACK_DIR, "MANIFEST.json")))(
    "passes reference execution on a restored deployment loaded directly from restored SQLite",
    async () => {
      const privSource = readPack(PRIVATE_PACK_DIR);
      const privatePack = await loadProfilePack(privSource);
      const privLiveDb = join(tmpDir, "priv-live.sqlite");
      const privBkRoot = join(tmpDir, "priv-backups");
      const privRestoredDb = join(tmpDir, "priv-restored.sqlite");

      const db = new SqliteAdapter({ path: privLiveDb });
      migrateUp(db);
      await new ConfigReleaseStore(db).bootstrapActivePack(privSource, privatePack.id, privatePack.version);
      new PolicyStore(db).activate(privatePack.policy.retention, nowIso);
      const bk = createBackup(db, { destDir: privBkRoot, tier: "15m", nowIso });
      db.close();

      const drill = restoreBackup({ backupDir: bk.backupDir, targetDbPath: privRestoredDb, nowIso });
      expect(drill.passed).toBe(true);

      const restoredDb = new SqliteAdapter({ path: privRestoredDb });
      let restoredPack: ProfilePack;
      try {
        const cfg = new ConfigReleaseStore(restoredDb);
        const active = cfg.getActive();
        expect(active).toBeTruthy();
        restoredPack = (await cfg.loadPackByReleaseId(active!.releaseId))!;
        expect(restoredPack.manifestDigest).toBe(privatePack.manifestDigest);
      } finally {
        restoredDb.close();
      }

      const cases = JSON.parse(readFileSync(join(REF_ROOT, "fixtures/cases.json"), "utf8")) as Array<{ id: string }>;
      const baseErp = readFileSync(join(REF_ROOT, "inputs/erp.csv"), "utf8");
      const baseLab = readFileSync(join(REF_ROOT, "inputs/lab_assessment.json"), "utf8");
      const baseLabObj = JSON.parse(baseLab) as Record<string, unknown>;
      expect(cases).toHaveLength(28);

      const out = await executeReferencePipeline(baseErp, baseLabObj, restoredPack.contracts, { labRawText: baseLab });
      expect(out.status).toBe("EXECUTED_REFERENCE");
      expect(out.import?.status).toBe("IMPORTED");
      expect(out.outputs?.customer.status).toBe("RELEASED_REFERENCE_VIEW");
      expect(out.outputs?.internal.status).toBe("RELEASED_REFERENCE_VIEW");
      expect(out.outputs?.registry.status).toBe("HOLD");
      expect(out.outputs?.registry.code).toBe("TARGET_PROFILE_UNCONFIRMED");
    },
  );
});
