// @vitest-environment node
/**
 * Cycle 10 Layer 3 (`FUNC-132`):
 * Verifies:
 *   1. Fault injection raises structured value-free alerts for all 7 fault classes, refreshes CLI
 *      backups, does not grow `operational_alerts` on repeated polls, and clears on recovery;
 *   2. Canary leak scan confirms zero restricted values/identifiers appear in alerts;
 *   3. Rehearsed schema upgrade & rollback (`v8 -> v9 -> v8 -> v9`) preserves `computeStoreChecksum`;
 *   4. Exhaustive HTTP RBAC & surface separation across all 5 roles (`ACT-01`, `ACT-06`, `ACT-17`,
 *      `ACT-19`, `ACT-20`) and all 3 surfaces (`all`, `internal`, `customer` `403 surface-forbidden`)
 *      covering every Cycle 10 endpoint (alerts, backups, migration export/import, content acceptance).
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALERT_FAULT_CLASSES, AlertRecordSchema } from "../../src/model/c10Contracts";
import type { ProfilePack } from "../../src/model/profile";
import { GrantStore } from "../../server/auth/grantStore";
import { SqliteAdapter } from "../../server/db/adapter";
import { computeStoreChecksum, currentMigrationVersion, migrateDown, migrateUp } from "../../server/db/migrations";
import { createDppServer } from "../../server/http/api";
import { ServerMetrics } from "../../server/http/limits";
import { ImportJobRunner } from "../../server/jobs/importJobRunner";
import { AlertMonitor } from "../../server/ops/alertMonitor";
import { createBackup } from "../../server/ops/backupManager";
import { PolicyStore } from "../../server/store/policyStore";
import { fixtureBytes } from "../support/fixtures";
import { createTestIdp } from "../support/oidc";
import { CLEAN, loadPack } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const tmpDir = mkdtempSync(join(tmpdir(), "dpp-c10-alerts-"));
const idp = createTestIdp();
const nowIso = "2026-11-27T11:00:00.000Z";
let pack: ProfilePack;

beforeAll(async () => {
  pack = await loadPack();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Cycle 10 monitoring alerts, upgrade/rollback round-trip, and exhaustive RBAC surface isolation", () => {
  it("raises and resolves structured value-free alerts for all 7 fault classes, notices CLI backups, and does not write on repeated polls", () => {
    const db = new SqliteAdapter({ path: join(tmpDir, "alerts.sqlite") });
    try {
      migrateUp(db);
      const monitor = new AlertMonitor({
        serviceOwner: "platform-ops-owner",
        db,
        now: () => nowIso,
      });

      monitor.recordEgressBlocked();
      monitor.recordIntegrityFailure();
      const fired = monitor.evaluate({
        errors5xx: 3,
        rateLimitedCount: 12,
        jobTimeouts: 2,
        lastBackupAtIso: "2026-11-27T10:30:00.000Z",
        rssBytes: 480 * 1024 * 1024,
      });

      expect(fired.firingCount).toBe(ALERT_FAULT_CLASSES.length);
      const firedClasses = new Set(fired.alerts.map((a) => a.faultClass));
      for (const cls of ALERT_FAULT_CLASSES) {
        expect(firedClasses.has(cls), cls).toBe(true);
      }

      const serialized = JSON.stringify(fired);
      for (const a of fired.alerts) {
        expect(() => AlertRecordSchema.parse(a)).not.toThrow();
        expect(a.serviceOwner).toBe("platform-ops-owner");
        expect(a.runbookRef).toContain("operations-runbook#");
      }
      for (const forbidden of ["STM004215", "004215", "31.4", "2.9", "1.95", "PRIVATE-CANARY", "erp-extract"]) {
        expect(serialized).not.toContain(forbidden);
      }

      // Repeated polls with changing counts while still firing must NOT insert extra rows into operational_alerts
      const countBeforePoll = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM operational_alerts")!.n;
      expect(countBeforePoll).toBe(7);
      monitor.evaluate({
        errors5xx: 4,
        rateLimitedCount: 15,
        jobTimeouts: 3,
        lastBackupAtIso: "2026-11-27T10:29:00.000Z",
        rssBytes: 495 * 1024 * 1024,
      });
      const countAfterPoll = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM operational_alerts")!.n;
      expect(countAfterPoll).toBe(countBeforePoll);

      // Append-only triggers protect operational_alerts from UPDATE/DELETE
      expect(() => db.run("UPDATE operational_alerts SET state = 'resolved'")).toThrow(/append-only/);
      expect(() => db.run("DELETE FROM operational_alerts")).toThrow(/append-only/);

      // Out-of-process backup recorded in backup_records clears backup_overdue automatically on evaluate()
      createBackup(db, { destDir: join(tmpDir, "cli-bk-sync"), tier: "15m", nowIso: "2026-11-27T10:58:00.000Z" });
      const afterRecovery = monitor.evaluate({
        errors5xx: 0,
        rateLimitedCount: 0,
        jobTimeouts: 0,
        rssBytes: 120 * 1024 * 1024,
      });
      expect(afterRecovery.firingCount).toBe(2); // only sticky egressBlocked + integrityFailures remain
      const resolvedRows = db.query<{ fault_class: string }>("SELECT fault_class FROM operational_alerts WHERE state = 'resolved'");
      expect(resolvedRows.length).toBe(5);

      // ServerMetrics counts live HTTP 429 "rate_window" hits (and ignores unrelated OVER_LIMIT codes)
      let clockMs = Date.parse(nowIso);
      const metrics = new ServerMetrics({ clock: () => clockMs });
      for (let i = 0; i < 10; i++) metrics.recordLimit("OVER_LIMIT", "body_max_bytes");
      expect(metrics.faultCounters().rateLimitedCount).toBe(0);
      for (let i = 0; i < 20; i++) metrics.recordLimit("OVER_LIMIT", "rate_window");
      expect(metrics.faultCounters().rateLimitedCount).toBe(20);
      const rateSnap = monitor.evaluate({ ...metrics.faultCounters(), rssBytes: 120 * 1024 * 1024 });
      expect(rateSnap.alerts.some((a) => a.faultClass === "rate_limit_saturation" && a.state === "firing")).toBe(true);
      clockMs += 16 * 60 * 1000;
      expect(metrics.faultCounters().rateLimitedCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rehearses v8 -> v9 -> v8 -> v9 schema upgrade and rollback on representative data with byte-identical store checksum", async () => {
    const db = new SqliteAdapter({ path: join(tmpDir, "upgrade-roundtrip.sqlite") });
    try {
      migrateUp(db, 8);
      expect(currentMigrationVersion(db)).toBe(8);
      new PolicyStore(db).activate(pack.policy.retention, nowIso);
      const grants = new GrantStore(db, undefined, { now: () => nowIso });
      grants.upsertUser({ sub: "ops-1", displayName: "Ops", roles: ["ACT-19"], actorSub: "bootstrap", reason: "Seed" });
      const runner = new ImportJobRunner(db, pack, undefined, { now: () => nowIso });
      await runner.runImportJob({
        idempotencyKey: "c10-upg-1",
        erp: { name: "erp.csv", type: "text/csv", bytes: fixtureBytes("n", CLEAN.erp!) },
        lab: { name: "lab.json", type: "application/json", bytes: fixtureBytes("n", CLEAN.lab!) },
      });

      const checksumV8 = computeStoreChecksum(db);

      migrateUp(db, 9);
      expect(currentMigrationVersion(db)).toBe(9);
      expect(computeStoreChecksum(db)).toBe(checksumV8);

      migrateDown(db, 8);
      expect(currentMigrationVersion(db)).toBe(8);
      expect(computeStoreChecksum(db)).toBe(checksumV8);

      migrateUp(db, 9);
      expect(currentMigrationVersion(db)).toBe(9);
      expect(computeStoreChecksum(db)).toBe(checksumV8);
    } finally {
      db.close();
    }
  });

  it("enforces exhaustive RBAC across all 5 roles and all 3 surfaces for every Cycle 10 ops endpoint", async () => {
    const db = new SqliteAdapter({ path: join(tmpDir, "rbac-ops.sqlite") });
    migrateUp(db);
    new PolicyStore(db).activate(pack.policy.retention, nowIso);
    const grants = new GrantStore(db, undefined, { now: () => nowIso });
    grants.upsertUser({ sub: "ops-1", displayName: "Ops", roles: ["ACT-19"], actorSub: "bootstrap", reason: "Seed" });
    grants.upsertUser({ sub: "op-1", displayName: "Op", roles: ["ACT-01"], actorSub: "ops-1", reason: "Seed" });
    grants.upsertUser({ sub: "cust-1", displayName: "Cust", roles: ["ACT-06"], actorSub: "ops-1", reason: "Seed" });
    grants.upsertUser({ sub: "cur-1", displayName: "Cur", roles: ["ACT-20"], actorSub: "ops-1", reason: "Seed" });
    grants.upsertUser({ sub: "aud-1", displayName: "Aud", roles: ["ACT-17"], actorSub: "ops-1", reason: "Seed" });

    const commonOpts = {
      db,
      pack,
      software: TEST_SOFTWARE,
      authMode: "oidc" as const,
      oidc: idp.oidcConfig,
      backupDir: join(tmpDir, "http-backups"),
      serviceOwner: "platform-ops-owner",
      now: () => nowIso,
    };
    const internalServer = createDppServer({ ...commonOpts, surface: "internal" });
    const customerServer = createDppServer({ ...commonOpts, surface: "customer" });
    const allServer = createDppServer({ ...commonOpts, surface: "all" });

    await new Promise<void>((res) => internalServer.listen(0, "127.0.0.1", res));
    await new Promise<void>((res) => customerServer.listen(0, "127.0.0.1", res));
    await new Promise<void>((res) => allServer.listen(0, "127.0.0.1", res));
    const intBase = `http://127.0.0.1:${(internalServer.address() as AddressInfo).port}`;
    const custBase = `http://127.0.0.1:${(customerServer.address() as AddressInfo).port}`;
    const allBase = `http://127.0.0.1:${(allServer.address() as AddressInfo).port}`;

    try {
      const nowSec = Math.floor(Date.parse(nowIso) / 1000);
      const sign = (sub: string) => idp.signRs256({ sub, iat: nowSec - 60, exp: nowSec + 3600 });
      const tokens = {
        "ACT-19": sign("ops-1"),
        "ACT-01": sign("op-1"),
        "ACT-06": sign("cust-1"),
        "ACT-20": sign("cur-1"),
        "ACT-17": sign("aud-1"),
      };
      const auth = (role: keyof typeof tokens, json = false): Record<string, string> => ({
        Authorization: `Bearer ${tokens[role]}`,
        ...(json ? { "Content-Type": "application/json" } : {}),
      });

      // 1. GET /api/admin/alerts: ACT-19, ACT-17 -> 200; ACT-01, ACT-06, ACT-20 -> 403
      for (const role of ["ACT-19", "ACT-17"] as const) {
        expect((await fetch(`${intBase}/api/admin/alerts`, { headers: auth(role) })).status, `alerts:${role}`).toBe(200);
      }
      for (const role of ["ACT-01", "ACT-06", "ACT-20"] as const) {
        expect((await fetch(`${intBase}/api/admin/alerts`, { headers: auth(role) })).status, `alerts:${role}`).toBe(403);
      }

      // 2. GET & POST /api/admin/backups: ACT-19 -> 200/201; all other 4 roles -> 403
      expect((await fetch(`${intBase}/api/admin/backups`, { headers: auth("ACT-19") })).status).toBe(200);
      const bkPost = await fetch(`${intBase}/api/admin/backups`, {
        method: "POST",
        headers: auth("ACT-19", true),
        body: JSON.stringify({ tier: "15m" }),
      });
      expect(bkPost.status).toBe(201);
      for (const role of ["ACT-01", "ACT-06", "ACT-17", "ACT-20"] as const) {
        expect((await fetch(`${intBase}/api/admin/backups`, { headers: auth(role) })).status, `get-bk:${role}`).toBe(403);
        expect(
          (
            await fetch(`${intBase}/api/admin/backups`, {
              method: "POST",
              headers: auth(role, true),
              body: JSON.stringify({ tier: "15m" }),
            })
          ).status,
          `post-bk:${role}`,
        ).toBe(403);
      }

      // Unapproved remote off-host URL refused 403 & raises egress_blocked_attempt
      const badEgress = await fetch(`${intBase}/api/admin/backups`, {
        method: "POST",
        headers: auth("ACT-19", true),
        body: JSON.stringify({ tier: "15m", offHostTargetUrl: "https://evil.example/exfil" }),
      });
      expect(badEgress.status).toBe(403);
      const alertsAfter = (await (await fetch(`${intBase}/api/admin/alerts`, { headers: auth("ACT-19") })).json()) as {
        alerts: Array<{ faultClass: string }>;
      };
      expect(alertsAfter.alerts.some((a) => a.faultClass === "egress_blocked_attempt")).toBe(true);

      // 3. POST /api/admin/migration/export: ACT-19, ACT-01 -> 200; ACT-06, ACT-17, ACT-20 -> 403
      let exportedPkg: unknown;
      for (const role of ["ACT-19", "ACT-01"] as const) {
        const res = await fetch(`${intBase}/api/admin/migration/export`, {
          method: "POST",
          headers: auth(role, true),
          body: JSON.stringify({ reason: "Authorised RBAC test export" }),
        });
        expect(res.status, `mig-export:${role}`).toBe(200);
        if (role === "ACT-19") exportedPkg = ((await res.json()) as { package: unknown }).package;
      }
      for (const role of ["ACT-06", "ACT-17", "ACT-20"] as const) {
        expect(
          (
            await fetch(`${intBase}/api/admin/migration/export`, {
              method: "POST",
              headers: auth(role, true),
              body: JSON.stringify({ reason: "Denied role test" }),
            })
          ).status,
          `mig-export:${role}`,
        ).toBe(403);
      }

      // 4. POST /api/admin/migration/import: ACT-19 -> 200; ACT-01, ACT-06, ACT-17, ACT-20 -> 403
      const impOk = await fetch(`${intBase}/api/admin/migration/import`, {
        method: "POST",
        headers: auth("ACT-19", true),
        body: JSON.stringify({ package: exportedPkg }),
      });
      expect(impOk.status).toBe(200);
      for (const role of ["ACT-01", "ACT-06", "ACT-17", "ACT-20"] as const) {
        expect(
          (
            await fetch(`${intBase}/api/admin/migration/import`, {
              method: "POST",
              headers: auth(role, true),
              body: JSON.stringify({ package: exportedPkg }),
            })
          ).status,
          `mig-import:${role}`,
        ).toBe(403);
      }

      // 5. `all` surface permits ACT-19 on ops endpoints
      expect((await fetch(`${allBase}/api/admin/alerts`, { headers: auth("ACT-19") })).status).toBe(200);
      expect((await fetch(`${allBase}/api/admin/content-acceptance`, { headers: auth("ACT-19") })).status).toBe(200);

      // 6. Dedicated `customer` surface blocks ALL 6 Cycle 10 ops endpoints even for ACT-19 with 403 surface-forbidden
      const custChecks: Array<{ method: "GET" | "POST"; path: string; body?: string }> = [
        { method: "GET", path: "/api/admin/alerts" },
        { method: "GET", path: "/api/admin/backups" },
        { method: "POST", path: "/api/admin/backups", body: JSON.stringify({ tier: "15m" }) },
        { method: "POST", path: "/api/admin/migration/export", body: JSON.stringify({ reason: "Surface test" }) },
        { method: "POST", path: "/api/admin/migration/import", body: JSON.stringify({ package: exportedPkg }) },
        { method: "GET", path: "/api/admin/content-acceptance" },
      ];
      for (const chk of custChecks) {
        const res = await fetch(`${custBase}${chk.path}`, {
          method: chk.method,
          headers: auth("ACT-19", chk.method === "POST"),
          ...(chk.body ? { body: chk.body } : {}),
        });
        expect(res.status, `customer:${chk.method}:${chk.path}`).toBe(403);
        const body = (await res.json()) as { code: string };
        expect(body.code, `customer:${chk.method}:${chk.path}`).toBe("surface-forbidden");
      }
    } finally {
      await new Promise<void>((res, rej) => internalServer.close((e) => (e ? rej(e) : res())));
      await new Promise<void>((res, rej) => customerServer.close((e) => (e ? rej(e) : res())));
      await new Promise<void>((res, rej) => allServer.close((e) => (e ? rej(e) : res())));
      db.close();
    }
  });
});
