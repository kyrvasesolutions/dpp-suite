// @vitest-environment node
/**
 * Cycle 6 Layer 3: classification and retention enforcement before ingest, default-restricted
 * unclassified payloads, content-addressed evidence integrity, legal-hold deletion blocks,
 * and security-domain isolation (C6-02, C6-05, LEAN-DEF-06, LEAN-DEF-12).
 */
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../server/db/adapter";
import { migrateUp } from "../../server/db/migrations";
import { ImportJobRunner } from "../../server/jobs/importJobRunner";
import { PolicyStore } from "../../server/store/policyStore";
import { SqlEvidenceStore } from "../../server/store/sqlEvidenceStore";
import { RetentionViolationError } from "../../src/model/pContracts";
import type { ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, loadPack } from "../support/records";

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A fixed server clock: retention is anchored at max(server now, stated storedAt), so tests pin "now". */
const FIXED_NOW = () => "2026-11-22T00:00:00.000Z";

describe("Cycle 6 classification and evidence retention enforcement (C6-02, C6-05)", () => {
  it("C6-02 refuses all imports and evidence writes before RETENTION policy is activated", async () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      const runner = new ImportJobRunner(db, pack);
      const evStore = new SqlEvidenceStore(db, undefined, { now: FIXED_NOW });

      await expect(
        runner.runImportJob({
          idempotencyKey: "before-policy",
          erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
          lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
        }),
      ).rejects.toMatchObject({ name: "RetentionViolationError", code: "policy-missing" });

      expect(() =>
        evStore.put({
          evidenceId: "EV-PRE-POLICY",
          issuer: "Lab",
          revision: "1",
          recordKind: "test-report",
          contentBytes: new TextEncoder().encode("raw"),
        }),
      ).toThrow(RetentionViolationError);

      // Zero partial rows persisted
      expect(runner.listJobs()).toHaveLength(0);
      expect(runner.repository.recordsSync()).toHaveLength(0);
      expect(evStore.list()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("C6-02 applies pinned RETENTION@1.0.0 classes, defaults unclassified to restricted, and prevents downgrading", async () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      const policies = new PolicyStore(db);
      const active = policies.activate(pack.policy.retention);
      expect(active.policyPin).toBe("RETENTION@1.0.0");

      const runner = new ImportJobRunner(db, pack);

      // Unlisted dataset with no stated classification -> restricted default, 3650-day retention
      const unclassified = await runner.runImportJob({
        idempotencyKey: "unclassified-1",
        dataset: "unlisted-customer-feed",
        erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
        lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
        timeEnvelope: {
          recordedAt: "2026-11-22T00:00:00Z",
          observedAt: null,
          declaredAt: null,
          publishedAt: null,
          validFrom: "2026-11-22T00:00:00Z",
          validTo: null,
        },
      });
      expect(unclassified.ok).toBe(true);
      expect(unclassified.job.classification).toBe("restricted");
      expect(unclassified.receipt?.classification).toBe("restricted");
      expect(unclassified.receipt?.policyPin).toBe("RETENTION@1.0.0");
      expect(unclassified.receipt?.retentionUntil).toBe("2036-11-19T00:00:00.000Z");

      // Caller attempting to downgrade a restricted dataset (`lab-assessment`) to `public` stays `restricted`
      const evStore = new SqlEvidenceStore(db, undefined, { now: FIXED_NOW });
      const bytes = new TextEncoder().encode("restricted-certificate");
      const put = evStore.put({
        evidenceId: "EV-NO-DOWNGRADE",
        issuer: "Demo Lab",
        revision: "1",
        recordKind: "test-report",
        dataset: "evidence-object",
        statedClassification: "public",
        contentBytes: bytes,
        storedAt: "2026-11-22T00:00:00Z",
      });
      expect(put.stored).toBe(true);
      expect(put.metadata.classification).toBe("restricted");
      expect(put.metadata.retentionDays).toBe(3650);
      expect(put.metadata.retentionUntil).toBe("2036-11-19T00:00:00.000Z");
    } finally {
      db.close();
    }
  });

  it("C6-05 verifies evidence SHA-256 on write and read, blocks premature deletion, and respects legal holds", () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      new PolicyStore(db).activate(pack.policy.retention);
      const evStore = new SqlEvidenceStore(db, undefined, { now: FIXED_NOW });
      const payload = new TextEncoder().encode("signed-mill-certificate-2026");
      const digest = sha(payload);

      // Mismatched declared digest rejected
      expect(() =>
        evStore.put({
          evidenceId: "EV-BAD",
          issuer: "Mill",
          revision: "1",
          recordKind: "certificate",
          declaredSha256: "f".repeat(64),
          contentBytes: payload,
        }),
      ).toThrow(/does not match computed/);

      // Matching digest accepted; second identical write is idempotent
      const first = evStore.put({
        evidenceId: "EV-GOOD",
        issuer: "Mill",
        revision: "1",
        recordKind: "certificate",
        declaredSha256: `sha256:${digest}`,
        contentBytes: payload,
        storedAt: "2026-11-22T00:00:00Z",
      });
      expect(first.stored).toBe(true);
      const second = evStore.put({
        evidenceId: "EV-GOOD",
        issuer: "Mill",
        revision: "1",
        recordKind: "certificate",
        declaredSha256: digest,
        contentBytes: payload,
        storedAt: "2026-11-22T00:00:00Z",
      });
      expect(second.stored).toBe(false);
      expect(evStore.list()).toHaveLength(1);

      // Deletion before 10-year retention expires is refused
      expect(() => evStore.delete(digest, "2030-01-01T00:00:00Z")).toThrow(/must be retained until/);

      // Placing a legal hold blocks deletion even AFTER retention expires
      const held = evStore.setLegalHold(digest, true);
      expect(held?.legalHold).toBe(true);
      expect(() => evStore.delete(digest, "2040-01-01T00:00:00Z")).toThrow(/legal hold/);

      // Releasing legal hold allows deletion strictly AFTER retention expires
      evStore.setLegalHold(digest, false);
      expect(() => evStore.delete(digest, "2036-11-18T23:59:59Z")).toThrow(/must be retained until/);
      expect(evStore.delete(digest, "2036-11-19T00:00:00Z")).toBe(true);
      expect(evStore.get(digest)).toBeUndefined();

      // Integrity corruption on disk is caught on read
      const payload2 = new TextEncoder().encode("intact-payload");
      const digest2 = sha(payload2);
      evStore.put({
        evidenceId: "EV-CORRUPT",
        issuer: "Mill",
        revision: "1",
        recordKind: "certificate",
        contentBytes: payload2,
      });
      db.run("UPDATE evidence_store SET content_blob = ? WHERE sha256 = ?", new TextEncoder().encode("tampered"), digest2);
      expect(() => evStore.get(digest2)).toThrow(/failed integrity verification/);
    } finally {
      db.close();
    }
  });

  it("EV-5 isolates snapshots, jobs, evidence, and logs across security domains", async () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      new PolicyStore(db).activate(pack.policy.retention);
      const runnerA = new ImportJobRunner(db, pack, "customer-alpha");
      const runnerB = new ImportJobRunner(db, pack, "customer-beta");

      const outA = await runnerA.runImportJob({
        idempotencyKey: "shared-key-1",
        erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
        lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
        evidence: [
          {
            evidenceId: "EV-A",
            issuer: "Lab A",
            revision: "1",
            recordKind: "cert",
            contentBytes: new TextEncoder().encode("alpha-secret"),
          },
        ],
      });
      expect(outA.ok).toBe(true);
      expect(runnerA.repository.recordsSync()).toHaveLength(1);
      expect(runnerB.repository.recordsSync()).toHaveLength(0);
      expect(runnerB.evidenceStore.list()).toHaveLength(0);
      expect(runnerB.logStore.allSync()).toHaveLength(0);

      // Same idempotencyKey works independently in domain B
      const outB = await runnerB.runImportJob({
        idempotencyKey: "shared-key-1",
        erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
        lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
      });
      expect(outB.ok).toBe(true);
      expect(outB.receipt?.stored).toBe(true);
      expect(outB.receipt?.securityDomain).toBe("customer-beta");
    } finally {
      db.close();
    }
  });
});

describe("Cycle 6 evidence retention hardening (anchoring, floors, legal-hold permission)", () => {
  const put = (store: SqlEvidenceStore, over: Partial<Parameters<SqlEvidenceStore["put"]>[0]> = {}) =>
    store.put({
      evidenceId: "EV-HARDEN",
      issuer: "Demo Lab",
      revision: "1",
      recordKind: "test-report",
      contentBytes: new TextEncoder().encode(`evidence-${over.evidenceId ?? "EV-HARDEN"}`),
      ...over,
    });

  it("anchors retention at the server clock when the stated storedAt is in the past, so backdating cannot shorten it", () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      new PolicyStore(db).activate(pack.policy.retention);
      const store = new SqlEvidenceStore(db, undefined, { now: () => "2026-11-22T12:00:00.000Z" });
      const backdated = put(store, { storedAt: "2000-01-01T00:00:00Z" });
      expect(backdated.metadata.storedAt).toBe("2000-01-01T00:00:00.000Z");
      expect(backdated.metadata.retentionUntil).toBe("2036-11-19T12:00:00.000Z");
      const future = put(store, { evidenceId: "EV-FUTURE", storedAt: "2026-12-01T00:00:00Z" });
      expect(future.metadata.retentionUntil).toBe("2036-11-28T00:00:00.000Z");
    } finally {
      db.close();
    }
  });

  it("never lets a dataset swap downgrade evidence below the evidence-object floor", () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      new PolicyStore(db).activate(pack.policy.retention);
      const store = new SqlEvidenceStore(db, undefined, { now: FIXED_NOW });
      const swapped = put(store, { dataset: "execution-log", statedClassification: "public" });
      expect(swapped.metadata.classification).toBe("restricted");
      expect(swapped.metadata.retentionDays).toBe(3650);
    } finally {
      db.close();
    }
  });

  it("refuses a legal hold on a dataset whose policy forbids it, on put and on setLegalHold", () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      const policy = structuredClone(pack.policy.retention);
      const rule = policy.datasets.find((d) => d.dataset === "execution-log")!;
      rule.legal_hold_permitted = false;
      new PolicyStore(db).activate(policy);
      const store = new SqlEvidenceStore(db, undefined, { now: FIXED_NOW });
      expect(() => put(store, { dataset: "execution-log", legalHold: true })).toThrow(
        expect.objectContaining({ code: "legal-hold-forbidden" }) as RetentionViolationError,
      );
      const stored = put(store, { evidenceId: "EV-NOHOLD", dataset: "execution-log" });
      expect(() => store.setLegalHold(stored.metadata.sha256, true)).toThrow(/does not permit legal holds/);
      expect(store.setLegalHold(stored.metadata.sha256, false)?.legalHold).toBe(false);
    } finally {
      db.close();
    }
  });
});
