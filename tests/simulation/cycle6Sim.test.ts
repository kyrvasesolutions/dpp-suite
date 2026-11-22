// @vitest-environment node
/**
 * Layer 2 pre-implementation deterministic contract simulator for Cycle 6 (P01 + P02).
 *
 * Calibrated first against N (`contracts/n` and `fixtures/n`), then simulates UC-12 (P)
 * and UC-03 (P) using typed deterministic stubs that carry `(securityDomain, model, batch, jobId)`
 * and provenance lists (preventing canned-data false passes), plus automated drop-one-input
 * contract-tightness checks proving every Cycle 6 precondition breaks at the expected stage.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { classify, DEFAULT_CLASSIFICATION, type Classification } from "../../src/model/classification";
import { buildRecords, importErpCsv, importLabJson, type ProductRecord } from "../../src/model/ingress";
import {
  computeRetentionUntil,
  ConcurrencyConflictError,
  DEFAULT_SECURITY_DOMAIN,
  resolveDatasetRetention,
  RetentionViolationError,
  TimeEnvelopeError,
  validateEv5TimeEnvelope,
  type CrashPoint,
  type Ev5TimeEnvelope,
  type EvidenceRetentionMetadata,
  type JobStage,
  type RetentionPolicy,
} from "../../src/model/pContracts";
import type { ProfilePack } from "../../src/model/profile";
import { assess } from "../../src/model/readiness";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, loadPack } from "../support/records";

const SAMPLE_POLICY: RetentionPolicy = {
  id: "RETENTION",
  version: "1.0.0",
  default_classification: "restricted",
  default_retention_days: 3650,
  require_policy_before_ingest: true,
  legal_hold_blocks_deletion: true,
  datasets: [
    {
      dataset: "erp-extract",
      classification: "internal",
      retention_days: 3650,
      legal_hold_permitted: true,
      description: "ERP master and batch extract files",
    },
    {
      dataset: "lab-assessment",
      classification: "restricted",
      retention_days: 3650,
      legal_hold_permitted: true,
      description: "Laboratory mechanical, chemical, and footprint files",
    },
    {
      dataset: "central-record-snapshot",
      classification: "restricted",
      retention_days: 3650,
      legal_hold_permitted: true,
      description: "Append-only versioned product record snapshots",
    },
    {
      dataset: "evidence-object",
      classification: "restricted",
      retention_days: 3650,
      legal_hold_permitted: true,
      description: "Content-addressed supporting evidence artefacts",
    },
  ],
};

interface SimProvenance {
  stage: string;
  securityDomain: string;
  jobId: string;
  model: string;
  batch: string;
  detail: string;
}

interface SimJobInput {
  securityDomain?: string;
  idempotencyKey?: string;
  actor: string;
  policy?: RetentionPolicy | null;
  dataset: string;
  statedClassification?: string | null;
  erpBytes: Uint8Array;
  labBytes: Uint8Array;
  expectedVersion?: number | null;
  timeEnvelope?: Ev5TimeEnvelope;
  evidencePayload?: {
    evidenceId: string;
    issuer: string;
    revision: string;
    recordKind: string;
    declaredSha256?: string;
    actualSha256: string;
    sizeBytes: number;
    legalHold?: boolean;
  };
  injectCrashAt?: CrashPoint;
}

interface SimJobResult {
  ok: boolean;
  stage: JobStage;
  code: string | null;
  jobId: string;
  version?: number;
  stored?: boolean;
  classification?: Classification;
  retentionUntil?: string;
  provenance: SimProvenance[];
}

/** Deterministic in-memory Layer 2 simulator for P01 + P02 pipeline contracts. */
class Cycle6ContractSimulator {
  private readonly snapshots = new Map<string, Array<{ version: number; digest: string; envelope: Ev5TimeEnvelope }>>();
  private readonly jobs = new Map<string, { stage: JobStage; committedVersion?: number; payloadKey: string; staged?: { model: string; batch: string; digest: string } }>();
  private readonly evidence = new Map<string, EvidenceRetentionMetadata>();
  private jobSeq = 0;

  constructor(private readonly pack: ProfilePack) {}

  private recordKey(domain: string, model: string, batch: string): string {
    return `${domain}::${model}::${batch}`;
  }

  async runImportJob(input: SimJobInput): Promise<SimJobResult> {
    const provenance: SimProvenance[] = [];
    const jobId = `SIM-JOB-${++this.jobSeq}`;

    // Stage 1: security domain & idempotency identity check
    if (!input.securityDomain || !input.securityDomain.trim()) {
      return { ok: false, stage: "failed", code: "domain-missing", jobId, provenance };
    }
    if (!input.idempotencyKey || !input.idempotencyKey.trim()) {
      return { ok: false, stage: "failed", code: "idempotency-key-missing", jobId, provenance };
    }
    const domain = input.securityDomain;
    const idemKey = `${domain}::${input.idempotencyKey}`;
    const payloadKey = `${input.erpBytes.length}:${input.labBytes.length}:${input.dataset}`;

    const existingJob = this.jobs.get(idemKey);
    if (existingJob?.stage === "committed") {
      if (existingJob.payloadKey !== payloadKey) {
        throw new ConcurrencyConflictError("idempotency-conflict", "Idempotency key reused with different payload");
      }
      return { ok: true, stage: "committed", code: null, jobId, version: existingJob.committedVersion, stored: false, provenance };
    }

    this.jobs.set(idemKey, { stage: "received", payloadKey });
    if (input.injectCrashAt === "after-receive") {
      this.jobs.set(idemKey, { stage: "rolled_back", payloadKey });
      return { ok: false, stage: "rolled_back", code: "injected-crash", jobId, provenance };
    }

    // Stage 2: classification & retention policy guard (C6-02)
    let retention: ReturnType<typeof resolveDatasetRetention>;
    try {
      retention = resolveDatasetRetention(input.policy, input.dataset, input.statedClassification);
    } catch (err) {
      const code = err instanceof RetentionViolationError ? err.code : "policy-invalid";
      this.jobs.set(idemKey, { stage: "failed", payloadKey });
      return { ok: false, stage: "failed", code, jobId, provenance };
    }
    const retentionUntil = computeRetentionUntil(
      input.timeEnvelope?.recordedAt ?? "2026-11-22T12:00:00Z",
      retention.retentionDays,
    );
    this.jobs.set(idemKey, { stage: "classified", payloadKey });
    if (input.injectCrashAt === "after-classify") {
      this.jobs.set(idemKey, { stage: "rolled_back", payloadKey });
      return { ok: false, stage: "rolled_back", code: "injected-crash", jobId, provenance };
    }

    // Stage 3: strict N ingress + EV-5 time envelope check
    if (!input.timeEnvelope) {
      this.jobs.set(idemKey, { stage: "failed", payloadKey });
      return { ok: false, stage: "failed", code: "time-envelope-missing", jobId, provenance };
    }
    try {
      validateEv5TimeEnvelope(input.timeEnvelope);
    } catch (err) {
      const code = err instanceof TimeEnvelopeError ? err.code : "invalid-timestamp";
      this.jobs.set(idemKey, { stage: "failed", payloadKey });
      return { ok: false, stage: "failed", code, jobId, provenance };
    }

    const erp = await importErpCsv(this.pack, { bytes: input.erpBytes, name: "erp.csv", type: "text/csv" });
    const lab = await importLabJson(this.pack, { bytes: input.labBytes, name: "lab.json", type: "application/json" });
    if (!erp.ok || !lab.ok) {
      const firstErr = !erp.ok ? erp.errors[0] : !lab.ok ? lab.errors[0] : undefined;
      this.jobs.set(idemKey, { stage: "failed", payloadKey });
      return { ok: false, stage: "failed", code: firstErr?.code ?? "ingress-error", jobId, provenance };
    }

    const built = await buildRecords([erp, lab]);
    const rec: ProductRecord | undefined = built.records[0];
    if (!rec) {
      this.jobs.set(idemKey, { stage: "failed", payloadKey });
      return { ok: false, stage: "failed", code: "no-record", jobId, provenance };
    }
    provenance.push({
      stage: "validated",
      securityDomain: domain,
      jobId,
      model: rec.model,
      batch: rec.batch,
      detail: `erp+lab validated (${rec.digest.slice(0, 12)})`,
    });
    this.jobs.set(idemKey, { stage: "validated", payloadKey });
    if (input.injectCrashAt === "after-validate") {
      this.jobs.set(idemKey, { stage: "rolled_back", payloadKey });
      return { ok: false, stage: "rolled_back", code: "injected-crash", jobId, provenance };
    }

    // Stage 4: evidence retention integrity check (C6-05) & staging
    if (input.evidencePayload) {
      if (!input.evidencePayload.declaredSha256 || input.evidencePayload.declaredSha256 !== input.evidencePayload.actualSha256) {
        this.jobs.set(idemKey, { stage: "failed", payloadKey });
        return { ok: false, stage: "failed", code: "digest-mismatch", jobId, provenance };
      }
    }
    this.jobs.set(idemKey, { stage: "staged", payloadKey, staged: { model: rec.model, batch: rec.batch, digest: rec.digest } });
    provenance.push({
      stage: "staged",
      securityDomain: domain,
      jobId,
      model: rec.model,
      batch: rec.batch,
      detail: `class=${retention.classification};retentionUntil=${retentionUntil}`,
    });
    if (input.injectCrashAt === "after-stage" || input.injectCrashAt === "before-commit") {
      // Simulate atomic rollback on crash prior to commit: no snapshot or evidence written
      this.jobs.set(idemKey, { stage: "rolled_back", payloadKey });
      return { ok: false, stage: "rolled_back", code: "injected-crash", jobId, provenance };
    }

    // Stage 5: atomic transactional commit with optimistic expectedVersion check (C6-03)
    const rKey = this.recordKey(domain, rec.model, rec.batch);
    const hist = this.snapshots.get(rKey) ?? [];
    const currentVersion = hist.length;
    if (input.expectedVersion !== undefined && input.expectedVersion !== null && input.expectedVersion !== currentVersion) {
      this.jobs.set(idemKey, { stage: "failed", payloadKey });
      throw new ConcurrencyConflictError(
        "version-conflict",
        `Expected version ${input.expectedVersion} but latest is ${currentVersion}`,
      );
    }

    const latest = hist[hist.length - 1];
    let version = currentVersion;
    let stored = false;
    if (!latest || latest.digest !== rec.digest) {
      version = currentVersion + 1;
      hist.push({ version, digest: rec.digest, envelope: input.timeEnvelope });
      this.snapshots.set(rKey, hist);
      stored = true;
    }

    if (input.evidencePayload) {
      const evRet = resolveDatasetRetention(input.policy, "evidence-object");
      this.evidence.set(`${domain}::${input.evidencePayload.actualSha256}`, {
        sha256: input.evidencePayload.actualSha256,
        securityDomain: domain,
        evidenceId: input.evidencePayload.evidenceId,
        issuer: input.evidencePayload.issuer,
        revision: input.evidencePayload.revision,
        recordKind: input.evidencePayload.recordKind,
        dataset: "evidence-object",
        classification: evRet.classification,
        policyPin: evRet.policyPin,
        retentionDays: evRet.retentionDays,
        storedAt: input.timeEnvelope.recordedAt,
        retentionUntil: computeRetentionUntil(input.timeEnvelope.recordedAt, evRet.retentionDays),
        legalHold: !!input.evidencePayload.legalHold,
        sizeBytes: input.evidencePayload.sizeBytes,
        mediaType: "application/pdf",
      });
    }

    this.jobs.set(idemKey, { stage: "committed", committedVersion: version, payloadKey });
    provenance.push({
      stage: "committed",
      securityDomain: domain,
      jobId,
      model: rec.model,
      batch: rec.batch,
      detail: `v${version} stored=${stored}`,
    });

    if (input.injectCrashAt === "after-commit") {
      // Crash AFTER durable commit: record stays intact; re-running with same idempotencyKey returns stored=false
      return { ok: false, stage: "committed", code: "post-commit-crash", jobId, version, stored, provenance };
    }

    return {
      ok: true,
      stage: "committed",
      code: null,
      jobId,
      version,
      stored,
      classification: retention.classification,
      retentionUntil,
      provenance,
    };
  }

  deleteEvidence(domain: string, sha256: string, nowIso: string): void {
    const rec = this.evidence.get(`${domain}::${sha256}`);
    if (!rec) return;
    if (rec.legalHold) {
      throw new RetentionViolationError("legal-hold-active", "Cannot delete evidence under active legal hold");
    }
    if (Date.parse(nowIso) < Date.parse(rec.retentionUntil)) {
      throw new RetentionViolationError("retention-active", `Retention active until ${rec.retentionUntil}`);
    }
    this.evidence.delete(`${domain}::${sha256}`);
  }

  snapshotCount(domain: string, model: string, batch: string): number {
    return (this.snapshots.get(this.recordKey(domain, model, batch)) ?? []).length;
  }
}

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});
const CLEAN_ERP = fixtureBytes("n", CLEAN.erp);
const CLEAN_LAB = fixtureBytes("n", CLEAN.lab);
const BASE_ENVELOPE: Ev5TimeEnvelope = {
  recordedAt: "2026-11-22T12:00:00Z",
  observedAt: "2026-11-20T09:15:00Z",
  declaredAt: "2026-11-21T16:30:00Z",
  publishedAt: null,
  validFrom: "2026-11-22T12:00:00Z",
  validTo: null,
};

describe("Layer 2 Cycle 6 deterministic contract simulator (P01 + P02)", () => {
  it("calibrates cleanly against N clean and failure fixtures", async () => {
    const erpClean = await importErpCsv(pack, { bytes: CLEAN_ERP, name: CLEAN.erp, type: "text/csv" });
    const labClean = await importLabJson(pack, { bytes: CLEAN_LAB, name: CLEAN.lab, type: "application/json" });
    expect(erpClean.ok && labClean.ok).toBe(true);
    const built = await buildRecords([erpClean, labClean]);
    const readiness = assess(pack, built.records[0]!);
    expect(readiness.find((r) => r.route === "customer-pdf")?.status).toBe("ready");
    expect(readiness.find((r) => r.route === "erp-staging-csv")?.status).toBe("ready");
    expect(readiness.find((r) => r.route === "registry-prep-json")?.status).toBe("on-hold");

    // Verify failure fixture calibration matches N contract
    const labConflict = await importLabJson(pack, {
      bytes: fixtureBytes("n", "lab-conflicting-alloy.json"),
      name: "lab-conflicting-alloy.json",
      type: "application/json",
    });
    expect(labConflict.ok).toBe(true);
    const conflictBuilt = await buildRecords([erpClean, labConflict]);
    const conflictReadiness = assess(pack, conflictBuilt.records[0]!);
    expect(conflictReadiness.every((r) => r.status === "on-hold")).toBe(true);
    expect(conflictReadiness.find((r) => r.route === "customer-pdf")?.holds.some((h) => h.ruleId === "RR-CHALLENGED")).toBe(true);
    expect(conflictReadiness.find((r) => r.route === "erp-staging-csv")?.holds.some((h) => h.ruleId === "RR-CHALLENGED")).toBe(true);
    expect(conflictReadiness.find((r) => r.route === "registry-prep-json")?.holds.some((h) => h.ruleId === "RR-STANDING-HOLD")).toBe(true);
  });

  it("executes UC-12 (P) & UC-03 (P) end-to-end with domain identity, provenance, and idempotency", async () => {
    const sim = new Cycle6ContractSimulator(pack);
    const first = await sim.runImportJob({
      securityDomain: DEFAULT_SECURITY_DOMAIN,
      idempotencyKey: "batch-001-v1",
      actor: "ACT-01",
      policy: SAMPLE_POLICY,
      dataset: "erp-extract",
      erpBytes: CLEAN_ERP,
      labBytes: CLEAN_LAB,
      expectedVersion: 0,
      timeEnvelope: BASE_ENVELOPE,
      evidencePayload: {
        evidenceId: "EV-SIM-01",
        issuer: "Test Lab",
        revision: "rev-1",
        recordKind: "test-certificate",
        declaredSha256: "a".repeat(64),
        actualSha256: "a".repeat(64),
        sizeBytes: 1024,
      },
    });
    expect(first.ok).toBe(true);
    expect(first.version).toBe(1);
    expect(first.stored).toBe(true);
    expect(first.classification).toBe("internal");
    expect(first.retentionUntil).toBe("2036-11-19T12:00:00.000Z");
    expect(first.provenance.map((p) => p.stage)).toEqual(["validated", "staged", "committed"]);
    expect(first.provenance.every((p) => p.securityDomain === DEFAULT_SECURITY_DOMAIN && p.model && p.batch)).toBe(true);

    // Repeating with the same idempotencyKey is idempotent and does not duplicate assertions
    const replay = await sim.runImportJob({
      securityDomain: DEFAULT_SECURITY_DOMAIN,
      idempotencyKey: "batch-001-v1",
      actor: "ACT-01",
      policy: SAMPLE_POLICY,
      dataset: "erp-extract",
      erpBytes: CLEAN_ERP,
      labBytes: CLEAN_LAB,
      expectedVersion: 0,
      timeEnvelope: BASE_ENVELOPE,
    });
    expect(replay.ok).toBe(true);
    expect(replay.stored).toBe(false);
    expect(replay.version).toBe(1);
    const { model, batch } = first.provenance[0]!;
    expect(sim.snapshotCount(DEFAULT_SECURITY_DOMAIN, model, batch)).toBe(1);
  });

  it("enforces drop-one-input contract tightness across all Cycle 6 preconditions (C6-02..C6-05)", async () => {
    const base: SimJobInput = {
      securityDomain: DEFAULT_SECURITY_DOMAIN,
      idempotencyKey: "drop-check",
      actor: "ACT-01",
      policy: SAMPLE_POLICY,
      dataset: "lab-assessment",
      erpBytes: CLEAN_ERP,
      labBytes: CLEAN_LAB,
      expectedVersion: 0,
      timeEnvelope: BASE_ENVELOPE,
    };

    // 1. Drop securityDomain
    const sim1 = new Cycle6ContractSimulator(pack);
    expect((await sim1.runImportJob({ ...base, securityDomain: "" })).code).toBe("domain-missing");

    // 2. Drop idempotencyKey
    const sim2 = new Cycle6ContractSimulator(pack);
    expect((await sim2.runImportJob({ ...base, idempotencyKey: "" })).code).toBe("idempotency-key-missing");

    // 3. Drop classification & retention policy (C6-02)
    const sim3 = new Cycle6ContractSimulator(pack);
    expect((await sim3.runImportJob({ ...base, policy: null })).code).toBe("policy-missing");

    // 4. Drop EV-5 time envelope
    const sim4 = new Cycle6ContractSimulator(pack);
    expect((await sim4.runImportJob({ ...base, timeEnvelope: undefined })).code).toBe("time-envelope-missing");

    // 5. Invalid half-open validity interval validTo <= validFrom (EV-5)
    const sim5 = new Cycle6ContractSimulator(pack);
    expect(
      (
        await sim5.runImportJob({
          ...base,
          timeEnvelope: { ...BASE_ENVELOPE, validTo: BASE_ENVELOPE.validFrom },
        })
      ).code,
    ).toBe("invalid-interval");

    // 6. Drop evidence declared digest (C6-05)
    const sim6 = new Cycle6ContractSimulator(pack);
    expect(
      (
        await sim6.runImportJob({
          ...base,
          evidencePayload: {
            evidenceId: "EV-1",
            issuer: "Lab",
            revision: "1",
            recordKind: "cert",
            declaredSha256: undefined,
            actualSha256: "b".repeat(64),
            sizeBytes: 512,
          },
        })
      ).code,
    ).toBe("digest-mismatch");

    // 7. Unclassified/unknown dataset defaults to restricted (C6-02 / LEAN-DEF-12)
    const sim7 = new Cycle6ContractSimulator(pack);
    const unclassified = await sim7.runImportJob({
      ...base,
      dataset: "unknown-customer-upload",
      statedClassification: undefined,
    });
    expect(unclassified.ok).toBe(true);
    expect(unclassified.classification).toBe(DEFAULT_CLASSIFICATION);
    expect(classify(undefined)).toBe("restricted");
  });

  it("simulates crash injection at every stage (C6-04) and optimistic concurrency conflicts (C6-03)", async () => {
    const stagesBeforeCommit: CrashPoint[] = [
      "after-receive",
      "after-classify",
      "after-validate",
      "after-stage",
      "before-commit",
    ];
    for (const cp of stagesBeforeCommit) {
      const sim = new Cycle6ContractSimulator(pack);
      const crashed = await sim.runImportJob({
        securityDomain: DEFAULT_SECURITY_DOMAIN,
        idempotencyKey: `crash-${cp}`,
        actor: "ACT-01",
        policy: SAMPLE_POLICY,
        dataset: "erp-extract",
        erpBytes: CLEAN_ERP,
        labBytes: CLEAN_LAB,
        expectedVersion: 0,
        timeEnvelope: BASE_ENVELOPE,
        injectCrashAt: cp,
      });
      expect(crashed.ok).toBe(false);
      expect(crashed.stage).toBe("rolled_back");

      // Retry with the exact same idempotencyKey commits cleanly to v1
      const recovered = await sim.runImportJob({
        securityDomain: DEFAULT_SECURITY_DOMAIN,
        idempotencyKey: `crash-${cp}`,
        actor: "ACT-01",
        policy: SAMPLE_POLICY,
        dataset: "erp-extract",
        erpBytes: CLEAN_ERP,
        labBytes: CLEAN_LAB,
        expectedVersion: 0,
        timeEnvelope: BASE_ENVELOPE,
      });
      expect(recovered.ok).toBe(true);
      expect(recovered.version).toBe(1);
      expect(recovered.stored).toBe(true);
    }

    // Post-commit crash: replay with same idempotency key sees committed version and writes nothing
    const simPost = new Cycle6ContractSimulator(pack);
    const postCrash = await simPost.runImportJob({
      securityDomain: DEFAULT_SECURITY_DOMAIN,
      idempotencyKey: "crash-after-commit",
      actor: "ACT-01",
      policy: SAMPLE_POLICY,
      dataset: "erp-extract",
      erpBytes: CLEAN_ERP,
      labBytes: CLEAN_LAB,
      expectedVersion: 0,
      timeEnvelope: BASE_ENVELOPE,
      injectCrashAt: "after-commit",
    });
    expect(postCrash.stage).toBe("committed");
    const postRetry = await simPost.runImportJob({
      securityDomain: DEFAULT_SECURITY_DOMAIN,
      idempotencyKey: "crash-after-commit",
      actor: "ACT-01",
      policy: SAMPLE_POLICY,
      dataset: "erp-extract",
      erpBytes: CLEAN_ERP,
      labBytes: CLEAN_LAB,
      expectedVersion: 0,
      timeEnvelope: BASE_ENVELOPE,
    });
    expect(postRetry.ok).toBe(true);
    expect(postRetry.stored).toBe(false);
    expect(postRetry.version).toBe(1);

    // Concurrent second operator with stale expectedVersion=0 is rejected with version-conflict
    await expect(
      simPost.runImportJob({
        securityDomain: DEFAULT_SECURITY_DOMAIN,
        idempotencyKey: "operator-b-stale",
        actor: "ACT-01",
        policy: SAMPLE_POLICY,
        dataset: "erp-extract",
        erpBytes: CLEAN_ERP,
        labBytes: CLEAN_LAB,
        expectedVersion: 0,
        timeEnvelope: BASE_ENVELOPE,
      }),
    ).rejects.toThrow(ConcurrencyConflictError);

    // Evidence retention and legal-hold enforcement (C6-05)
    const simEv = new Cycle6ContractSimulator(pack);
    await simEv.runImportJob({
      securityDomain: DEFAULT_SECURITY_DOMAIN,
      idempotencyKey: "ev-hold-1",
      actor: "ACT-01",
      policy: SAMPLE_POLICY,
      dataset: "erp-extract",
      erpBytes: CLEAN_ERP,
      labBytes: CLEAN_LAB,
      expectedVersion: 0,
      timeEnvelope: BASE_ENVELOPE,
      evidencePayload: {
        evidenceId: "EV-HOLD",
        issuer: "Lab",
        revision: "1",
        recordKind: "cert",
        declaredSha256: "c".repeat(64),
        actualSha256: "c".repeat(64),
        sizeBytes: 256,
        legalHold: true,
      },
    });
    // Refused even after 10 years because legalHold is active
    expect(() => simEv.deleteEvidence(DEFAULT_SECURITY_DOMAIN, "c".repeat(64), "2040-01-01T00:00:00Z")).toThrow(
      RetentionViolationError,
    );
  });
});
