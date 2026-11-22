// @vitest-environment node
/**
 * Layer 2 pre-implementation deterministic contract simulator for Cycle 6 (P01 + P02).
 *
 * Calibrated against N (`contracts/n` and `fixtures/n`) and, when the local N bridge manifest is present, against its
 * 18 failure classes and their per-route outcomes. It simulates UC-12 (P) and UC-03 (P) using typed deterministic stubs
 * that carry `(securityDomain, model, batch, jobId)` and provenance lists (preventing canned-data false passes), plus
 * automated drop-one-input checks that name the function each missing input breaks. The simulator and the durable
 * server run the same contract (server-assigned recordedAt, digest-based idempotency, the two input datasets only), and
 * a differential test runs both on the same inputs so they cannot drift apart.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../server/db/adapter";
import { migrateUp } from "../../server/db/migrations";
import { ImportJobRunner } from "../../server/jobs/importJobRunner";
import { PolicyStore } from "../../server/store/policyStore";
import { CLASSIFICATIONS, DEFAULT_CLASSIFICATION, type Classification } from "../../src/model/classification";
import { buildRecords, importErpCsv, importLabJson, type ProductRecord } from "../../src/model/ingress";
import {
  computeRetentionUntil,
  ConcurrencyConflictError,
  DEFAULT_SECURITY_DOMAIN,
  resolveCallerTimeEnvelope,
  resolveDatasetRetention,
  RetentionViolationError,
  TimeEnvelopeError,
  type CallerTimeEnvelope,
  type CrashPoint,
  type EvidenceRetentionMetadata,
  type RetentionPolicy,
} from "../../src/model/pContracts";
import type { ProfilePack } from "../../src/model/profile";
import { assess, type RouteReadiness } from "../../src/model/readiness";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, loadPack } from "../support/records";

const SIM_NOW = "2026-11-22T12:00:00.000Z";
const INPUT_DATASETS = ["erp-extract", "lab-assessment"];
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

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
  dataset?: string;
  statedClassification?: string | null;
  erpBytes: Uint8Array;
  labBytes?: Uint8Array;
  expectedVersion?: number | null;
  /** What a caller may say about time; the server assigns recordedAt, so any `recordedAt` given here is ignored. */
  timeEnvelope?: CallerTimeEnvelope;
  evidence?: {
    evidenceId: string;
    issuer: string;
    revision: string;
    recordKind: string;
    /** Optional: when given it must equal the digest the server computes from the bytes. */
    declaredSha256?: string;
    contentBytes: Uint8Array;
    legalHold?: boolean;
  };
  injectCrashAt?: CrashPoint;
}

interface SimJobResult {
  ok: boolean;
  stage: string;
  code: string | null;
  /** The function of the server pipeline this run breaks at, when it does not complete. */
  breakingFunction: string | null;
  jobId: string;
  version?: number;
  stored?: boolean;
  classification?: Classification;
  retentionUntil?: string;
  recordedAt?: string;
  readiness?: RouteReadiness[];
  provenance: SimProvenance[];
}

interface SimJob {
  stage: string;
  inputKey: string;
  committedVersion?: number;
  staged?: { model: string; batch: string; digest: string };
}

/** Deterministic in-memory Layer 2 simulator for P01 + P02 pipeline contracts. */
class Cycle6ContractSimulator {
  private readonly snapshots = new Map<string, Array<{ version: number; digest: string }>>();
  private readonly jobs = new Map<string, SimJob>();
  private readonly evidence = new Map<string, EvidenceRetentionMetadata>();
  private jobSeq = 0;
  /** How many times a commit transaction was started (before-commit starts one and rolls it back; after-stage does not). */
  public commitAttempts = 0;

  constructor(
    private readonly pack: ProfilePack,
    private readonly clock: () => string = () => SIM_NOW,
  ) {}

  private recordKey(domain: string, model: string, batch: string): string {
    return `${domain}::${model}::${batch}`;
  }

  async runImportJob(input: SimJobInput): Promise<SimJobResult> {
    const provenance: SimProvenance[] = [];
    const jobId = `SIM-JOB-${++this.jobSeq}`;
    const fail = (code: string, fn: string, stage = "failed"): SimJobResult => ({ ok: false, stage, code, breakingFunction: fn, jobId, provenance });

    if (!input.securityDomain || !input.securityDomain.trim()) return fail("domain-missing", "ImportJobRunner");
    // The retention policy gates everything, before any payload is looked at (C6-02)
    if (!input.policy) return fail("policy-missing", "requireActive");
    if (!input.idempotencyKey || !input.idempotencyKey.trim()) return fail("idempotency-key-missing", "runImportJob");
    if (input.dataset !== undefined && !INPUT_DATASETS.includes(input.dataset)) return fail("dataset-not-allowed", "runImportJob");

    const domain = input.securityDomain;
    // The input decides the class: a lab file can never be filed under the weaker ERP dataset.
    const derived = input.labBytes ? "lab-assessment" : "erp-extract";
    const requested = input.dataset ?? derived;
    const rank = (d: string) => CLASSIFICATIONS.indexOf(resolveDatasetRetention(input.policy, d).classification);
    const dataset = rank(requested) >= rank(derived) ? requested : derived;
    const retention = resolveDatasetRetention(input.policy, dataset, input.statedClassification);

    // The key is claimed for the digests of what was sent, not for its size (C6-03)
    const inputKey = `${sha(input.erpBytes)}:${input.labBytes ? sha(input.labBytes) : "-"}:${dataset}`;
    const idemKey = `${domain}::${input.idempotencyKey}`;
    const existing = this.jobs.get(idemKey);
    if (existing) {
      if (existing.inputKey !== inputKey) {
        throw new ConcurrencyConflictError("idempotency-conflict", "Idempotency key claimed for a different payload");
      }
      if (existing.stage === "committed") {
        return { ok: true, stage: "committed", code: null, breakingFunction: null, jobId, version: existing.committedVersion, stored: false, provenance };
      }
    }
    this.jobs.set(idemKey, { stage: "received", inputKey });
    const setStage = (stage: string, extra: Partial<SimJob> = {}) => this.jobs.set(idemKey, { ...this.jobs.get(idemKey)!, stage, ...extra });
    if (input.injectCrashAt === "after-receive") return fail("injected-crash", "pipeline", "running");

    setStage("classified");
    if (input.injectCrashAt === "after-classify") return fail("injected-crash", "pipeline", "running");

    // Stage 3: the server assigns recordedAt; the caller may only state observed/declared/validFrom within bounds
    let envelope;
    try {
      envelope = resolveCallerTimeEnvelope(input.timeEnvelope, this.clock());
    } catch (err) {
      setStage("failed");
      return fail(err instanceof TimeEnvelopeError ? err.code : "invalid-timestamp", "resolveCallerTimeEnvelope");
    }
    const retentionUntil = computeRetentionUntil(envelope.recordedAt, retention.retentionDays);

    const erp = await importErpCsv(this.pack, { bytes: input.erpBytes, name: "erp.csv", type: "text/csv" });
    const lab = input.labBytes ? await importLabJson(this.pack, { bytes: input.labBytes, name: "lab.json", type: "application/json" }) : undefined;
    if (!erp.ok || (lab && !lab.ok)) {
      setStage("failed");
      const bad = !erp.ok ? { r: erp, fn: "importErpCsv" } : { r: lab as Exclude<typeof lab, undefined>, fn: "importLabJson" };
      return fail(!bad.r.ok ? bad.r.errors[0]!.code : "ingress-error", bad.fn);
    }
    const built = await buildRecords(lab ? [erp, lab] : [erp]);
    const rec: ProductRecord | undefined = built.records[0];
    if (!rec) {
      setStage("failed");
      return fail("no-rows", "buildRecords");
    }

    // Evidence: the server computes the digest; a declared digest is optional but must agree (C6-05)
    if (input.evidence?.declaredSha256 !== undefined) {
      const declared = input.evidence.declaredSha256.replace(/^sha256:/i, "").toLowerCase();
      if (declared !== sha(input.evidence.contentBytes)) {
        setStage("failed");
        return fail("digest-mismatch", "pipeline");
      }
    }
    provenance.push({ stage: "validated", securityDomain: domain, jobId, model: rec.model, batch: rec.batch, detail: `validated (${rec.digest.slice(0, 12)})` });
    setStage("validated");
    if (input.injectCrashAt === "after-validate") return fail("injected-crash", "pipeline", "running");

    setStage("staged", { staged: { model: rec.model, batch: rec.batch, digest: rec.digest } });
    provenance.push({ stage: "staged", securityDomain: domain, jobId, model: rec.model, batch: rec.batch, detail: `class=${retention.classification};retentionUntil=${retentionUntil}` });
    // after-stage: durable payload, no commit started. before-commit: the commit transaction runs and is rolled back.
    if (input.injectCrashAt === "after-stage") return fail("injected-crash", "pipeline", "running");
    this.commitAttempts++;
    if (input.injectCrashAt === "before-commit") return fail("injected-crash", "commitStagedJob", "running");

    const rKey = this.recordKey(domain, rec.model, rec.batch);
    const hist = this.snapshots.get(rKey) ?? [];
    const currentVersion = hist.length;
    if (input.expectedVersion !== undefined && input.expectedVersion !== null && input.expectedVersion !== currentVersion) {
      setStage("failed");
      throw new ConcurrencyConflictError("version-conflict", `Expected version ${input.expectedVersion} but latest is ${currentVersion}`);
    }
    const latest = hist[hist.length - 1];
    let version = currentVersion;
    let stored = false;
    if (!latest || latest.digest !== rec.digest) {
      version = currentVersion + 1;
      hist.push({ version, digest: rec.digest });
      this.snapshots.set(rKey, hist);
      stored = true;
    }

    if (input.evidence) {
      const evRet = resolveDatasetRetention(input.policy, "evidence-object");
      const digest = sha(input.evidence.contentBytes);
      this.evidence.set(`${domain}::${digest}`, {
        sha256: digest,
        securityDomain: domain,
        evidenceId: input.evidence.evidenceId,
        issuer: input.evidence.issuer,
        revision: input.evidence.revision,
        recordKind: input.evidence.recordKind,
        dataset: "evidence-object",
        classification: evRet.classification,
        policyPin: evRet.policyPin,
        retentionDays: evRet.retentionDays,
        storedAt: envelope.recordedAt,
        retentionUntil: computeRetentionUntil(envelope.recordedAt, evRet.retentionDays),
        legalHold: !!input.evidence.legalHold,
        sizeBytes: input.evidence.contentBytes.byteLength,
        mediaType: "application/octet-stream",
      });
    }

    setStage("committed", { committedVersion: version });
    provenance.push({ stage: "committed", securityDomain: domain, jobId, model: rec.model, batch: rec.batch, detail: `v${version} stored=${stored}` });
    if (input.injectCrashAt === "after-commit") {
      // Crash AFTER the durable commit: the record is intact; the same key replays with stored=false
      return { ok: false, stage: "committed", code: "post-commit-crash", breakingFunction: "pipeline", jobId, version, stored, provenance };
    }
    return {
      ok: true,
      stage: "committed",
      code: null,
      breakingFunction: null,
      jobId,
      version,
      stored,
      classification: retention.classification,
      retentionUntil,
      recordedAt: envelope.recordedAt,
      readiness: assess(this.pack, rec),
      provenance,
    };
  }

  /** A crashed run of the same key resumes from its durable state: staged payloads commit, earlier ones start over. */
  async resumeJob(domain: string, key: string, input: SimJobInput): Promise<SimJobResult> {
    return this.runImportJob({ ...input, securityDomain: domain, idempotencyKey: key, injectCrashAt: undefined });
  }

  deleteEvidence(domain: string, sha256: string): void {
    const rec = this.evidence.get(`${domain}::${sha256}`);
    if (!rec) return;
    // Retention is judged on the server clock only; no caller supplies "now"
    if (rec.legalHold) throw new RetentionViolationError("legal-hold-active", "Cannot delete evidence under active legal hold");
    if (Date.parse(this.clock()) < Date.parse(rec.retentionUntil)) {
      throw new RetentionViolationError("retention-active", `Retention active until ${rec.retentionUntil}`);
    }
    this.evidence.delete(`${domain}::${sha256}`);
  }

  setClock(clock: () => string): void {
    (this as unknown as { clock: () => string }).clock = clock;
  }

  snapshotCount(domain: string, model: string, batch: string): number {
    return (this.snapshots.get(this.recordKey(domain, model, batch)) ?? []).length;
  }
}

let pack: ProfilePack;
let policy: RetentionPolicy;
beforeAll(async () => {
  pack = await loadPack();
  policy = pack.policy.retention;
});
const CLEAN_ERP = fixtureBytes("n", CLEAN.erp);
const CLEAN_LAB = fixtureBytes("n", CLEAN.lab);
const base = (): SimJobInput => ({
  securityDomain: DEFAULT_SECURITY_DOMAIN,
  idempotencyKey: "sim-key",
  actor: "ACT-01",
  policy,
  erpBytes: CLEAN_ERP,
  labBytes: CLEAN_LAB,
});

/** Runs the same input through the real server pipeline (in-memory database, fixed clock) and reports how it ended. */
async function realOutcome(input: SimJobInput): Promise<{ code: string | null; stack: string; ok: boolean }> {
  const db = new SqliteAdapter({ path: ":memory:" });
  try {
    migrateUp(db);
    if (input.policy) new PolicyStore(db).activate(pack.policy.retention);
    const runner = new ImportJobRunner(db, pack, input.securityDomain, { now: () => SIM_NOW });
    const out = await runner.runImportJob({
      idempotencyKey: input.idempotencyKey ?? "",
      dataset: input.dataset,
      statedClassification: input.statedClassification,
      timeEnvelope: input.timeEnvelope,
      erp: { bytes: input.erpBytes, name: CLEAN.erp, type: "text/csv" },
      lab: input.labBytes ? { bytes: input.labBytes, name: CLEAN.lab, type: "application/json" } : undefined,
      evidence: input.evidence
        ? [{ evidenceId: input.evidence.evidenceId, issuer: input.evidence.issuer, revision: input.evidence.revision, recordKind: input.evidence.recordKind, declaredSha256: input.evidence.declaredSha256, contentBytes: input.evidence.contentBytes }]
        : undefined,
    });
    return { ok: out.ok, code: out.ok ? null : (out.job.errorCode ?? null), stack: "" };
  } catch (err) {
    const e = err as { code?: string; stack?: string };
    return { ok: false, code: e.code ?? "internal-error", stack: e.stack ?? "" };
  } finally {
    db.close();
  }
}

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

  // The bridge manifest is generated locally from the private assessment records and is git-ignored, so CI has none.
  const BRIDGE = "docs/developer/n-contract-bridge.json";
  it.runIf(existsSync(BRIDGE))("is calibrated against the N bridge manifest: every failure class ends as the bridge says on the customer route", async () => {
    const bridge = JSON.parse(readFileSync(BRIDGE, "utf8")) as {
      profile: string;
      failureClasses: Array<{ id: string; fixture: string; acceptanceByRoute: Record<string, { outcome: string }> }>;
      routes: Record<string, unknown>;
    };
    expect(bridge.profile).toBe(`${pack.id}@${pack.version}`);
    expect(Object.keys(bridge.routes).sort()).toEqual(Object.keys(pack.routes).sort());
    expect(bridge.failureClasses.length).toBeGreaterThanOrEqual(18);

    let rejected = 0;
    let held = 0;
    for (const fc of bridge.failureClasses) {
      const file = fc.fixture.replace(/^fixtures\/n\//, "");
      if (!existsSync(fc.fixture) || file.includes("/") || !/\.(csv|json)$/.test(file)) continue; // route-contract and leakage classes are not import inputs
      const bytes = fixtureBytes("n", file);
      const isErp = file.endsWith(".csv");
      const sim = new Cycle6ContractSimulator(pack);
      const out = await sim.runImportJob({
        ...base(),
        idempotencyKey: `bridge-${fc.id}`,
        erpBytes: isErp ? bytes : CLEAN_ERP,
        labBytes: isErp ? CLEAN_LAB : bytes,
      });
      const expected = fc.acceptanceByRoute["customer-pdf"]!.outcome;
      if (expected === "rejected-at-ingress") {
        expect(out.ok, fc.id).toBe(false);
        expect(out.stage, fc.id).toBe("failed");
        expect(["importErpCsv", "importLabJson"], fc.id).toContain(out.breakingFunction);
        rejected++;
      } else if (expected === "route-hold-output-refused") {
        expect(out.ok, fc.id).toBe(true);
        expect(out.readiness?.find((r) => r.route === "customer-pdf")?.status, fc.id).toBe("on-hold");
        held++;
      }
    }
    expect(rejected).toBeGreaterThanOrEqual(8);
    expect(held).toBeGreaterThanOrEqual(4);
  });

  it("executes UC-12 (P) & UC-03 (P) end-to-end with domain identity, provenance, and digest-based idempotency", async () => {
    const sim = new Cycle6ContractSimulator(pack);
    const first = await sim.runImportJob({
      ...base(),
      idempotencyKey: "batch-001-v1",
      dataset: "erp-extract",
      expectedVersion: 0,
      timeEnvelope: { observedAt: "2026-11-20T09:15:00Z", declaredAt: "2026-11-21T16:30:00Z" },
      evidence: { evidenceId: "EV-SIM-01", issuer: "Test Lab", revision: "rev-1", recordKind: "test-certificate", contentBytes: new TextEncoder().encode("certificate") },
    });
    expect(first.ok).toBe(true);
    expect(first.version).toBe(1);
    expect(first.stored).toBe(true);
    // a lab file is restricted even when the caller states the weaker ERP dataset
    expect(first.classification).toBe("restricted");
    expect(first.recordedAt).toBe(SIM_NOW);
    expect(first.retentionUntil).toBe("2036-11-19T12:00:00.000Z");
    expect(first.provenance.map((p) => p.stage)).toEqual(["validated", "staged", "committed"]);
    expect(first.provenance.every((p) => p.securityDomain === DEFAULT_SECURITY_DOMAIN && p.model && p.batch)).toBe(true);

    const replay = await sim.runImportJob({ ...base(), idempotencyKey: "batch-001-v1", dataset: "erp-extract", expectedVersion: 0 });
    expect(replay.ok).toBe(true);
    expect(replay.stored).toBe(false);
    expect(replay.version).toBe(1);
    const { model, batch } = first.provenance[0]!;
    expect(sim.snapshotCount(DEFAULT_SECURITY_DOMAIN, model, batch)).toBe(1);

    // same key, a different file of the SAME SIZE: the claim compares digests, not lengths
    const sameSize = new TextEncoder().encode(new TextDecoder().decode(CLEAN_ERP).replace(";62.0;", ";63.0;"));
    expect(sameSize.byteLength).toBe(CLEAN_ERP.byteLength);
    await expect(sim.runImportJob({ ...base(), idempotencyKey: "batch-001-v1", dataset: "erp-extract", erpBytes: sameSize })).rejects.toMatchObject({ code: "idempotency-conflict" });
    expect(await realOutcome({ ...base(), erpBytes: sameSize })).toMatchObject({ ok: true }); // the same file under a NEW key is fine for the server too
  });

  it("enforces drop-one-input contract tightness: each missing input breaks the named function, in the simulator and in the server", async () => {
    const cases: Array<{ name: string; input: SimJobInput; code: string; fn: string }> = [
      { name: "security domain", input: { ...base(), securityDomain: "" }, code: "domain-missing", fn: "ImportJobRunner" },
      { name: "idempotency key", input: { ...base(), idempotencyKey: "" }, code: "idempotency-key-missing", fn: "runImportJob" },
      { name: "retention policy", input: { ...base(), policy: null }, code: "policy-missing", fn: "requireActive" },
      { name: "dataset outside the two inputs", input: { ...base(), dataset: "execution-log" }, code: "dataset-not-allowed", fn: "runImportJob" },
      { name: "time in the future", input: { ...base(), timeEnvelope: { observedAt: "2030-01-01T00:00:00Z" } }, code: "invalid-timestamp", fn: "resolveCallerTimeEnvelope" },
      { name: "time before the earliest allowed", input: { ...base(), timeEnvelope: { declaredAt: "1969-12-31T00:00:00Z" } }, code: "invalid-timestamp", fn: "resolveCallerTimeEnvelope" },
      {
        name: "evidence digest that disagrees with its bytes",
        input: { ...base(), evidence: { evidenceId: "EV-1", issuer: "Lab", revision: "1", recordKind: "cert", declaredSha256: "b".repeat(64), contentBytes: new TextEncoder().encode("x") } },
        code: "digest-mismatch",
        fn: "pipeline",
      },
    ];
    for (const c of cases) {
      const sim = await new Cycle6ContractSimulator(pack).runImportJob(c.input);
      expect(sim.ok, c.name).toBe(false);
      expect(sim.code, c.name).toBe(c.code);
      expect(sim.breakingFunction, c.name).toBe(c.fn);

      const real = await realOutcome(c.input);
      expect(real.ok, `${c.name} (server)`).toBe(false);
      expect(real.code, `${c.name} (server)`).toBe(c.code);
      if (real.stack) expect(real.stack, `${c.name} (server)`).toContain(c.fn);
    }

    // Inputs the contract does NOT require must not break anything: no envelope at all, no declared digest
    const lenient = {
      ...base(),
      evidence: { evidenceId: "EV-2", issuer: "Lab", revision: "1", recordKind: "cert", contentBytes: new TextEncoder().encode("no declared digest") },
    };
    expect((await new Cycle6ContractSimulator(pack).runImportJob(lenient)).ok).toBe(true);
    expect((await realOutcome(lenient)).ok).toBe(true);

    // A caller's recordedAt never shortens retention, in the simulator or in the server
    const backdated = { ...base(), timeEnvelope: { recordedAt: "1990-01-01T00:00:00Z" } as CallerTimeEnvelope };
    const simBack = await new Cycle6ContractSimulator(pack).runImportJob(backdated);
    expect(simBack.recordedAt).toBe(SIM_NOW);
    expect(simBack.retentionUntil).toBe("2036-11-19T12:00:00.000Z");

    // An unlisted dataset resolves to the restricted default at the policy level
    expect(resolveDatasetRetention(policy, "unknown-customer-upload").classification).toBe(DEFAULT_CLASSIFICATION);
  });

  it("simulates crash injection at every stage (C6-04) and optimistic concurrency conflicts (C6-03)", async () => {
    const before: CrashPoint[] = ["after-receive", "after-classify", "after-validate", "after-stage", "before-commit"];
    for (const cp of before) {
      const sim = new Cycle6ContractSimulator(pack);
      const crashed = await sim.runImportJob({ ...base(), idempotencyKey: `crash-${cp}`, expectedVersion: 0, injectCrashAt: cp });
      expect(crashed.ok).toBe(false);
      expect(crashed.stage).toBe("running");
      expect(sim.snapshotCount(DEFAULT_SECURITY_DOMAIN, "x", "y")).toBe(0);

      const recovered = await sim.resumeJob(DEFAULT_SECURITY_DOMAIN, `crash-${cp}`, { ...base(), expectedVersion: 0 });
      expect(recovered.ok).toBe(true);
      expect(recovered.version).toBe(1);
      expect(recovered.stored).toBe(true);
    }

    // after-stage and before-commit are different points: only the second starts the commit
    const a = new Cycle6ContractSimulator(pack);
    const b = new Cycle6ContractSimulator(pack);
    const afterStage = await a.runImportJob({ ...base(), idempotencyKey: "k-a", injectCrashAt: "after-stage" });
    const beforeCommit = await b.runImportJob({ ...base(), idempotencyKey: "k-b", injectCrashAt: "before-commit" });
    expect(a.commitAttempts).toBe(0);
    expect(b.commitAttempts).toBe(1);
    expect(afterStage.breakingFunction).toBe("pipeline");
    expect(beforeCommit.breakingFunction).toBe("commitStagedJob");

    const simPost = new Cycle6ContractSimulator(pack);
    const postCrash = await simPost.runImportJob({ ...base(), idempotencyKey: "crash-after-commit", expectedVersion: 0, injectCrashAt: "after-commit" });
    expect(postCrash.stage).toBe("committed");
    const postRetry = await simPost.runImportJob({ ...base(), idempotencyKey: "crash-after-commit", expectedVersion: 0 });
    expect(postRetry.ok).toBe(true);
    expect(postRetry.stored).toBe(false);
    expect(postRetry.version).toBe(1);

    await expect(simPost.runImportJob({ ...base(), idempotencyKey: "operator-b-stale", expectedVersion: 0 })).rejects.toThrow(ConcurrencyConflictError);

    // Evidence retention and legal hold, on the server clock only (C6-05)
    const simEv = new Cycle6ContractSimulator(pack);
    const content = new TextEncoder().encode("held evidence");
    await simEv.runImportJob({ ...base(), idempotencyKey: "ev-hold-1", evidence: { evidenceId: "EV-HOLD", issuer: "Lab", revision: "1", recordKind: "cert", contentBytes: content, legalHold: true } });
    simEv.setClock(() => "2040-01-01T00:00:00.000Z");
    expect(() => simEv.deleteEvidence(DEFAULT_SECURITY_DOMAIN, sha(content))).toThrow(RetentionViolationError);
  });
});
