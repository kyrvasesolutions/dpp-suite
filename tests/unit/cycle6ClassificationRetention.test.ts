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
import { RetentionViolationError, resolveDatasetRetention } from "../../src/model/pContracts";
import type { ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, loadPack, loadPackWithRetention } from "../support/records";

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

      const runner = new ImportJobRunner(db, pack, undefined, { now: FIXED_NOW });

      // A dataset the policy does not list resolves to the restricted default and the 3650-day horizon...
      expect(resolveDatasetRetention(pack.policy.retention, "unlisted-customer-feed")).toMatchObject({
        classification: "restricted",
        retentionDays: 3650,
      });
      // ...but an import job accepts only the two input datasets, so a caller cannot pick any other (not even a public one).
      for (const dataset of ["unlisted-customer-feed", "execution-log", "central-record-snapshot"]) {
        await expect(
          runner.runImportJob({
            idempotencyKey: `dataset-${dataset}`,
            dataset,
            erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
          }),
        ).rejects.toMatchObject({ code: "dataset-not-allowed", statusCode: 400 });
      }
      expect(runner.listJobs()).toHaveLength(0);

      // A lab file is restricted whatever dataset the caller states for it
      const unclassified = await runner.runImportJob({
        idempotencyKey: "unclassified-1",
        dataset: "erp-extract",
        erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
        lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
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
      let clock = "2026-11-22T00:00:00.000Z";
      const evStore = new SqlEvidenceStore(db, undefined, { now: () => clock });
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
      clock = "2030-01-01T00:00:00.000Z";
      expect(() => evStore.delete(digest)).toThrow(/must be retained until/);

      // Placing a legal hold blocks deletion even AFTER retention expires
      const held = evStore.setLegalHold(digest, true);
      expect(held?.legalHold).toBe(true);
      clock = "2040-01-01T00:00:00.000Z";
      expect(() => evStore.delete(digest)).toThrow(/legal hold/);

      // Releasing legal hold allows deletion strictly AFTER retention expires. The in-process clock is a test seam;
      // the SQL trigger judges on the database clock (2026), so the delete itself is refused there until it is due.
      evStore.setLegalHold(digest, false);
      clock = "2036-11-18T23:59:59.000Z";
      expect(() => evStore.delete(digest)).toThrow(/must be retained until/);
      clock = "2036-11-19T00:00:00.000Z";
      expect(() => evStore.delete(digest)).toThrow(/retention horizon/);
      expect(evStore.get(digest)).toBeDefined();

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
      // storage-level corruption bypasses the application and its triggers, so the immutability trigger is lifted to simulate it
      db.exec("DROP TRIGGER trg_evidence_immutable_content");
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

  it("refuses a legal hold on a dataset whose policy forbids it, on put and on setLegalHold", async () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      const strict = await loadPackWithRetention((policy) => {
        policy.datasets.find((d: { dataset: string }) => d.dataset === "execution-log").legal_hold_permitted = false;
      });
      new PolicyStore(db).activate(strict.policy.retention);
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

describe("Cycle 6 evidence retention cannot be bypassed (C6-05)", () => {
  const bytes = new TextEncoder().encode("retained-certificate");
  const digest = sha(bytes);
  const fresh = () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    migrateUp(db);
    new PolicyStore(db).activate(pack.policy.retention);
    return db;
  };
  const evidence = { evidenceId: "EV-RET", issuer: "Mill", revision: "1", recordKind: "certificate", contentBytes: bytes };

  it("deletes expired evidence that is not held, and only then", () => {
    const db = fresh();
    try {
      // stored when the server clock read 2000-01-01, so the 10-year horizon ended in 2010
      new SqlEvidenceStore(db, undefined, { now: () => "2000-01-01T00:00:00.000Z" }).put(evidence);
      const store = new SqlEvidenceStore(db);
      expect(store.delete(digest)).toBe(true);
      expect(store.get(digest)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses a raw SQL DELETE inside the horizon or under a hold, whatever the caller says the time is", () => {
    const db = fresh();
    try {
      const store = new SqlEvidenceStore(db);
      store.put(evidence);
      expect(() => db.run("DELETE FROM evidence_store WHERE sha256 = ?", digest)).toThrow(/legal hold or inside its retention horizon/);
      // a store whose own clock is set far in the future still cannot delete: the database judges on its own clock
      const wrongClock = new SqlEvidenceStore(db, undefined, { now: () => "2099-01-01T00:00:00.000Z" });
      expect(() => wrongClock.delete(digest)).toThrow(RetentionViolationError);
      expect(store.get(digest)).toBeDefined();

      // a held object cannot be deleted even if its horizon has ended
      const held = fresh();
      try {
        const old = new SqlEvidenceStore(held, undefined, { now: () => "2000-01-01T00:00:00.000Z" });
        old.put({ ...evidence, legalHold: true });
        expect(() => held.run("DELETE FROM evidence_store WHERE sha256 = ?", digest)).toThrow(/legal hold/);
        expect(() => new SqlEvidenceStore(held).delete(digest)).toThrow(expect.objectContaining({ code: "legal-hold-active" }) as RetentionViolationError);
      } finally {
        held.close();
      }
    } finally {
      db.close();
    }
  });

  it("refuses to shorten a retention horizon, change content or move evidence with raw SQL", () => {
    const db = fresh();
    try {
      new SqlEvidenceStore(db).put(evidence);
      expect(() => db.run("UPDATE evidence_store SET retention_until = '2001-01-01T00:00:00.000Z' WHERE sha256 = ?", digest)).toThrow(/immutable/);
      expect(() => db.run("UPDATE evidence_store SET content_blob = x'00' WHERE sha256 = ?", digest)).toThrow(/immutable/);
      expect(() => db.run("UPDATE evidence_store SET stored_at = '1990-01-01T00:00:00.000Z' WHERE sha256 = ?", digest)).toThrow(/immutable/);
      // the legal hold flag itself stays changeable
      expect(() => db.run("UPDATE evidence_store SET legal_hold = 1 WHERE sha256 = ?", digest)).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("Cycle 6 retention policy activation accepts only the signed policy (C6-02)", () => {
  it("refuses a policy that did not come out of a verified pack, or was changed after loading", () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      const store = new PolicyStore(db);
      const weak = structuredClone(pack.policy.retention);
      weak.default_retention_days = 1;
      weak.datasets
        .filter((d) => d.dataset !== "evidence-object")
        .forEach((d) => {
          d.classification = "public";
          d.retention_days = 1;
        });
      expect(() => store.activate(weak)).toThrow(expect.objectContaining({ code: "policy-untrusted" }) as RetentionViolationError);
      const mutated = pack.policy.retention;
      const original = mutated.default_retention_days;
      mutated.default_retention_days = 1;
      try {
        expect(() => store.activate(mutated)).toThrow(expect.objectContaining({ code: "policy-untrusted" }) as RetentionViolationError);
      } finally {
        mutated.default_retention_days = original;
      }
      expect(store.getActive()).toBeNull();
      expect(store.activate(pack.policy.retention).policyPin).toBe("RETENTION@1.0.0");
    } finally {
      db.close();
    }
  });

  it("refuses different content under a pin the database already holds", async () => {
    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      const store = new PolicyStore(db);
      store.activate(pack.policy.retention);
      const other = await loadPackWithRetention((policy) => {
        policy.default_retention_days = 1;
      });
      expect(() => store.activate(other.policy.retention)).toThrow(expect.objectContaining({ code: "policy-conflict" }) as RetentionViolationError);
      expect(store.requireActive().policy.default_retention_days).toBe(3650);
    } finally {
      db.close();
    }
  });

  it("keeps a code-level floor under the signed policy: evidence at least restricted and at least 3650 days", async () => {
    for (const edit of [
      (p: any) => (p.datasets.find((d: any) => d.dataset === "evidence-object").classification = "public"),
      (p: any) => (p.datasets.find((d: any) => d.dataset === "evidence-object").retention_days = 1),
      (p: any) => (p.datasets = p.datasets.filter((d: any) => d.dataset !== "evidence-object")),
    ]) {
      const db = new SqliteAdapter({ path: ":memory:" });
      try {
        migrateUp(db);
        // a pack that verifies (its manifest agrees with its files) still cannot activate a policy below the floor
        const weak = await loadPackWithRetention(edit);
        expect(() => new PolicyStore(db).activate(weak.policy.retention)).toThrow(expect.objectContaining({ code: "policy-invalid" }) as RetentionViolationError);
        expect(new PolicyStore(db).getActive()).toBeNull();
      } finally {
        db.close();
      }
    }
  });
});
