// @vitest-environment node
/**
 * Cycle 6 Layer 3: replays every representative customer data-quality exception in the pinned
 * `policy/EXCEPTIONS@1.0.0.yaml` catalogue and `fixtures/p/` through the real durable `ImportJobRunner`,
 * verifies every expected outcome/code/hold, and scans the SQLite public log for zero leaked source values (C6-01).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../server/db/adapter";
import { migrateUp } from "../../server/db/migrations";
import { ImportJobRunner } from "../../server/jobs/importJobRunner";
import { PolicyStore } from "../../server/store/policyStore";
import { generateRelease } from "../../src/model/outputs/release";
import type { ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, loadPack } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});

const pFixture = (rel: string) => fixtureBytes("p", rel.replace(/^fixtures\/p\//, ""));

describe("Cycle 6 P01 data-quality exception catalogue replay (C6-01)", () => {
  it("replays every pinned exception rule in EXCEPTIONS@1.0.0 with exact expected stage, outcome, and code, and zero log leaks", async () => {
    const catalogue = pack.policy.exceptions;
    expect(catalogue.status).toBe("FROZEN");
    expect(catalogue.exceptions.length).toBeGreaterThanOrEqual(12);

    const db = new SqliteAdapter({ path: ":memory:" });
    try {
      migrateUp(db);
      new PolicyStore(db).activate(pack.policy.retention);
      const runner = new ImportJobRunner(db, pack);

      const cleanErp = fixtureBytes("n", CLEAN.erp);
      const cleanLab = fixtureBytes("n", CLEAN.lab);

      // Baseline clean record digest for CRLF equivalence comparison
      const baselineDb = new SqliteAdapter({ path: ":memory:" });
      migrateUp(baselineDb);
      new PolicyStore(baselineDb).activate(pack.policy.retention);
      const baseRes = await new ImportJobRunner(baselineDb, pack).runImportJob({
        idempotencyKey: "baseline-clean",
        erp: { bytes: cleanErp, name: CLEAN.erp, type: "text/csv" },
        lab: { bytes: cleanLab, name: CLEAN.lab, type: "application/json" },
      });
      baselineDb.close();
      expect(baseRes.ok).toBe(true);
      const cleanDigest = baseRes.snapshot!.record.digest;

      for (const rule of catalogue.exceptions) {
        if (rule.id === "EX-UNCLASSIFIED-PAYLOAD") {
          const out = await runner.runImportJob({
            idempotencyKey: `ex-${rule.id}`,
            dataset: "unlisted-customer-upload",
            erp: { bytes: cleanErp, name: CLEAN.erp, type: "text/csv" },
            lab: { bytes: cleanLab, name: CLEAN.lab, type: "application/json" },
          });
          expect(out.ok, rule.id).toBe(true);
          expect(out.job.classification, rule.id).toBe("restricted");
          expect(out.receipt?.classification, rule.id).toBe("restricted");
          continue;
        }

        expect(rule.fixture, rule.id).toBeTruthy();
        const bytes = pFixture(rule.fixture!);
        const isErp = rule.fixture!.endsWith(".csv");
        const erpInput = isErp
          ? { bytes, name: rule.fixture!.split("/").pop()!, type: "text/csv" }
          : { bytes: cleanErp, name: CLEAN.erp, type: "text/csv" };
        const labInput = isErp
          ? { bytes: cleanLab, name: CLEAN.lab, type: "application/json" }
          : { bytes, name: rule.fixture!.split("/").pop()!, type: "application/json" };

        const out = await runner.runImportJob({
          idempotencyKey: `ex-${rule.id}`,
          erp: erpInput,
          lab: labInput,
        });

        if (rule.expected_outcome === "rejected") {
          expect(out.ok, rule.id).toBe(false);
          expect(out.job.state, rule.id).toBe("failed");
          expect(out.job.errorStage, rule.id).toBe(rule.expected_stage);
          expect(out.job.errorCode, rule.id).toBe(rule.expected_code);
        } else if (rule.expected_outcome === "accepted") {
          expect(out.ok, rule.id).toBe(true);
          // CRLF line endings must produce a record whose values/model/batch match LF (differing only in source file sha256)
          expect(out.snapshot!.record.values.map((v) => [v.property, v.member, v.qualifier, v.assertions[0]?.raw])).toEqual(
            baseRes.snapshot!.record.values.map((v) => [v.property, v.member, v.qualifier, v.assertions[0]?.raw]),
          );
          expect(cleanDigest).toMatch(/^[0-9a-f]{64}$/);
        } else if (rule.expected_outcome === "held") {
          if (rule.expected_code === "unattached-lab") {
            expect(out.ok, rule.id).toBe(false);
            expect(out.unattachedLab, rule.id).toBe(true);
            expect(out.job.errorCode, rule.id).toBe("unattached-lab");
          } else if (rule.expected_stage === "readiness") {
            expect(out.ok, rule.id).toBe(true);
            const allHolds = (out.readiness ?? []).flatMap((r) => r.holds.map((h) => h.ruleId));
            expect(allHolds, rule.id).toContain(rule.expected_code);
          } else if (rule.expected_stage === "output") {
            expect(out.ok, rule.id).toBe(true);
            const release = await generateRelease(pack, out.snapshot!, { software: TEST_SOFTWARE });
            const pdfOutcome = release.outcomes.find((o) => o.route === "customer-pdf")!;
            expect("refused" in pdfOutcome, rule.id).toBe(true);
            if ("refused" in pdfOutcome) {
              expect(pdfOutcome.refused.holds.some((h) => h.ruleId === rule.expected_code), rule.id).toBe(true);
            }
            // ERP CSV stays ready/unaffected by PDF WinAnsi guard
            const erpOutcome = release.outcomes.find((o) => o.route === "erp-staging-csv")!;
            expect("file" in erpOutcome, rule.id).toBe(true);
          }
        }
      }

      // Scan entire SQLite execution_log for zero leaked fixture names, values, or restricted codes
      const logJson = JSON.stringify(runner.logStore.allSync());
      for (const forbidden of [
        "erp-utf8-bom.csv",
        "erp-unknown-supplier.csv",
        "SUP-XX-99",
        "EN AW-5083",
        "B-2026-UNATTACHED",
        "Demo LCA consultancy",
        "Ω",
      ]) {
        expect(logJson, `log leaked "${forbidden}"`).not.toContain(forbidden);
      }
    } finally {
      db.close();
    }
  });
});
