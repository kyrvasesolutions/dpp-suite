/**
 * Durable staged import job runner with crash-injection hooks, deterministic recovery/rollback,
 * transactional multi-operator concurrency control, classification/retention enforcement, and
 * acceptance receipts (C6-02, C6-03, C6-04, C6-05, FUNC-087).
 *
 * Pipeline stages persisted in `import_jobs` and `job_events`:
 *   received -> classified -> validated -> staged -> committed | rolled_back | failed
 *
 * Reuses the exact shared pure domain engine (`src/model/ingress.ts`, `correction.ts`, `readiness.ts`,
 * `log.ts`) so there is zero fork between browser and server (S2-05).
 */
import { randomUUID } from "node:crypto";
import { canonical } from "../../src/model/canonical";
import { carryCorrections } from "../../src/model/correction";
import {
  classifyLimitOutcome,
  LimitError,
  type JobBudget,
  type LimitName,
  type LimitOutcome,
  type OperationalLimits,
} from "../../src/model/c8Contracts";
import {
  buildRecords,
  importErpCsv,
  importLabJson,
  ingressIssue,
  STAGES,
  type ImportResult,
  type IngressCode,
  type IngressIssue,
  type ProductRecord,
  type Stage,
} from "../../src/model/ingress";
import { importEvents, readinessEvents, recordRef } from "../../src/model/log";
import {
  computeRetentionUntil,
  ConcurrencyConflictError,
  DEFAULT_SECURITY_DOMAIN,
  resolveDatasetRetention,
  resolveCallerTimeEnvelope,
  RetentionViolationError,
  type CallerTimeEnvelope,
  type CrashPoint,
  type Ev5TimeEnvelope,
  type EvidenceRetentionMetadata,
  type JobEvent,
  type JobStage,
  type StagedImportJob,
  type UpdateReceipt,
} from "../../src/model/pContracts";
import type { ProfilePack } from "../../src/model/profile";
import { assess, type RouteReadiness } from "../../src/model/readiness";
import { OPERATOR, REASON_FIRST, REASON_REIMPORT, type Snapshot } from "../../src/model/recordRepository";
import type { DbAdapter, SqlParam } from "../db/adapter";
import { PolicyStore } from "../store/policyStore";
import { SqlEvidenceStore, type PutEvidenceRequest } from "../store/sqlEvidenceStore";
import { SqlLogStore } from "../store/sqlLogStore";
import { CLASSIFICATIONS } from "../../src/model/classification";
import { recordDigestSync, sha256Sync, SqlRecordRepository } from "../store/sqlRepository";

export class SimulatedCrashError extends Error {
  override name = "SimulatedCrashError";
  constructor(public readonly crashPoint: CrashPoint) {
    super(`Simulated crash injected at ${crashPoint}`);
  }
}

/** The only datasets an import job accepts as input; anything else is refused before a job exists. */
export const IMPORT_DATASETS = ["erp-extract", "lab-assessment"] as const;

/** Identifies this process: a running job last touched by it, and not executing now, is a crashed run of its own. */
const PROCESS_ID = randomUUID();
/** A running job of another process is left alone until it has been silent this long (the 30 s job deadline, doubled). */
export const JOB_LEASE_MS = 60_000;
/** Jobs executing now in this process, so a duplicate request waits for them instead of taking them over. */
const INFLIGHT = new Map<string, Promise<ImportJobOutcome>>();

function badRequest(code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

export interface ImportEvidenceUpload {
  evidenceId: string;
  issuer: string;
  revision: string;
  recordKind: string;
  dataset?: string;
  statedClassification?: string | null;
  declaredSha256?: string;
  mediaType?: string;
  contentBytes: Uint8Array;
  legalHold?: boolean;
}

/** The budget an ingress code names (a limit code never carries the value that crossed it). */
const LIMIT_OF_CODE: Partial<Record<IngressCode, LimitName>> = {
  "too-large": "source_file_max_bytes",
  "too-deep": "max_nesting_depth",
  "multiple-records": "max_records_per_job",
  "too-many-nodes": "max_parser_nodes_per_job",
  deadline: "job_deadline_ms",
};

/** The stage a stop reached, as an ingress stage (a stage name that is not an ingress stage reads as `route`). */
function ingressStage(stage: string | undefined): Stage {
  return (STAGES as readonly string[]).includes(stage ?? "") ? (stage as Stage) : "route";
}

/**
 * Cycle 8 control of one job (D8-02): its deadline and cancellation token, the execution budgets, who submitted it,
 * and test seams. Absent for the in-process callers of Cycles 6 and 7, which keep their behaviour unchanged.
 */
export interface ImportJobControl {
  budget: JobBudget;
  /** The pinned OPERATIONAL-LIMITS execution budgets. */
  limits: OperationalLimits["execution"];
  submitterSub: string;
  /** Called once the job exists (claimed), so a cancel request can find it. */
  onClaimed?: (jobId: string) => void;
  /**
   * Test-only seam, like crash injection: runs at every stage boundary and may take time. A test uses it to hold a stage open,
   * so a cancel or a deadline lands mid-stage deterministically. The budget is checked right after it returns.
   */
  stageHook?: (stage: string, ctx: { jobId: string; budget: JobBudget }) => void | Promise<void>;
}

export interface RunImportJobRequest {
  idempotencyKey: string;
  actor?: typeof OPERATOR;
  dataset?: string;
  statedClassification?: string | null;
  erp: { bytes: Uint8Array; name: string; type: string };
  lab?: { bytes: Uint8Array; name: string; type: string };
  /** Explicit optimistic lock on current latest version (`0` for first import). Omit to serialize automatically. */
  expectedVersion?: number | null;
  reason?: string;
  /** What the caller may say about time (observedAt, declaredAt, validFrom); the server assigns the rest. */
  timeEnvelope?: CallerTimeEnvelope;
  evidence?: ImportEvidenceUpload[];
  /** Deterministic crash-injection hook for AT-U recovery tests (C6-04). */
  injectCrashAt?: CrashPoint;
  /** Cycle 8 job budget, execution limits and cancellation (server path only). */
  control?: ImportJobControl;
}

export interface ImportJobOutcome {
  ok: boolean;
  job: StagedImportJob;
  events: JobEvent[];
  receipt?: UpdateReceipt;
  snapshot?: Snapshot;
  readiness?: RouteReadiness[];
  evidence?: EvidenceRetentionMetadata[];
  carried?: number;
  disputed?: number;
  unattachedLab?: boolean;
  errors?: IngressIssue[];
  /** Cycle 8: set when the job stopped on a declared limit. Never carries the value that crossed it. */
  outcome?: LimitOutcome;
  limit?: LimitName;
}

export interface RecoveryReport {
  scanned: number;
  resumed: string[];
  rolledBack: string[];
}

interface JobRow {
  job_id: string;
  security_domain: string;
  idempotency_key: string;
  actor: string;
  state: StagedImportJob["state"];
  stage: JobStage;
  classification: StagedImportJob["classification"];
  retention_policy_pin: string;
  erp_sha256: string | null;
  lab_sha256: string | null;
  input_key: string | null;
  owner: string | null;
  model: string | null;
  batch: string | null;
  expected_version: number | null;
  result_version: number | null;
  result_snapshot_digest: string | null;
  staged_payload_json: string | null;
  error_code: string | null;
  error_stage: string | null;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
}

interface CommitResult {
  snapshot: Snapshot;
  receipt: UpdateReceipt;
  storedEvidence: EvidenceRetentionMetadata[];
  carried: number;
  disputed: number;
}

interface StagedPayload {
  record: ProductRecord;
  reason: string;
  actor: typeof OPERATOR;
  dataset: string;
  statedClassification?: string | null;
  expectedVersion: number | null;
  seenVersion: number;
  carried: number;
  disputed: number;
  timeEnvelope: Ev5TimeEnvelope;
  evidence: Array<{
    evidenceId: string;
    issuer: string;
    revision: string;
    recordKind: string;
    dataset?: string;
    statedClassification?: string | null;
    declaredSha256?: string;
    mediaType?: string;
    contentBase64: string;
    legalHold?: boolean;
  }>;
  logEntries: Array<Record<string, unknown>>;
}

function rowToJob(r: JobRow): StagedImportJob {
  return {
    jobId: r.job_id,
    idempotencyKey: r.idempotency_key,
    securityDomain: r.security_domain,
    actor: r.actor,
    state: r.state,
    stage: r.stage,
    classification: r.classification,
    retentionPolicyPin: r.retention_policy_pin,
    erpSha256: r.erp_sha256,
    labSha256: r.lab_sha256,
    model: r.model,
    batch: r.batch,
    expectedVersion: r.expected_version !== null ? Number(r.expected_version) : null,
    resultVersion: r.result_version !== null ? Number(r.result_version) : null,
    resultSnapshotDigest: r.result_snapshot_digest,
    errorCode: r.error_code,
    errorStage: r.error_stage,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    committedAt: r.committed_at,
  };
}

export class ImportJobRunner {
  public readonly policies: PolicyStore;
  public readonly repository: SqlRecordRepository;
  public readonly evidenceStore: SqlEvidenceStore;
  public readonly logStore: SqlLogStore;
  /** The server clock. Only an in-process test can replace it; nothing in a request can. */
  private readonly now: () => string;
  private readonly clock: () => number;

  constructor(
    private readonly db: DbAdapter,
    private readonly pack: ProfilePack,
    public readonly securityDomain: string = DEFAULT_SECURITY_DOMAIN,
    options: { now?: () => string; /** Monotonic millisecond clock of the ingress deadline (default `performance.now()`). */ clock?: () => number } = {},
  ) {
    this.clock = options.clock ?? (() => performance.now());
    if (!securityDomain.trim()) {
      throw new RetentionViolationError("domain-missing", "securityDomain is required for ImportJobRunner");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.policies = new PolicyStore(db, securityDomain);
    this.repository = new SqlRecordRepository(db, securityDomain);
    this.evidenceStore = new SqlEvidenceStore(db, securityDomain, { now: this.now });
    this.logStore = new SqlLogStore(db, securityDomain);
  }

  getJob(jobId: string): StagedImportJob | undefined {
    const row = this.db.get<JobRow>(
      "SELECT * FROM import_jobs WHERE security_domain = ? AND job_id = ?",
      this.securityDomain,
      jobId,
    );
    return row ? rowToJob(row) : undefined;
  }

  getJobByIdempotencyKey(idempotencyKey: string): StagedImportJob | undefined {
    const row = this.db.get<JobRow>(
      "SELECT * FROM import_jobs WHERE security_domain = ? AND idempotency_key = ?",
      this.securityDomain,
      idempotencyKey,
    );
    return row ? rowToJob(row) : undefined;
  }

  listJobs(): StagedImportJob[] {
    const rows = this.db.query<JobRow>(
      "SELECT * FROM import_jobs WHERE security_domain = ? ORDER BY created_at ASC, job_id ASC",
      this.securityDomain,
    );
    return rows.map(rowToJob);
  }

  getJobEvents(jobId: string): JobEvent[] {
    const rows = this.db.query<{
      seq: number;
      job_id: string;
      security_domain: string;
      stage: JobStage;
      outcome: JobEvent["outcome"];
      code: string | null;
      recorded_at: string;
    }>(
      "SELECT * FROM job_events WHERE security_domain = ? AND job_id = ? ORDER BY seq ASC",
      this.securityDomain,
      jobId,
    );
    return rows.map((r) => ({
      seq: Number(r.seq),
      jobId: r.job_id,
      securityDomain: r.security_domain,
      stage: r.stage,
      outcome: r.outcome,
      code: r.code,
      recordedAt: r.recorded_at,
    }));
  }

  getReceiptForJob(jobId: string): UpdateReceipt | undefined {
    const row = this.db.get<{
      receipt_id: string;
      job_id: string;
      idempotency_key: string;
      security_domain: string;
      model: string;
      batch: string;
      version: number;
      record_digest: string;
      snapshot_digest: string;
      recorded_at: string;
      stored: number;
      classification: UpdateReceipt["classification"];
      retention_until: string;
      policy_pin: string;
    }>(
      "SELECT * FROM update_receipts WHERE security_domain = ? AND job_id = ? LIMIT 1",
      this.securityDomain,
      jobId,
    );
    if (!row) return undefined;
    return {
      receiptId: row.receipt_id,
      jobId: row.job_id,
      idempotencyKey: row.idempotency_key,
      securityDomain: row.security_domain,
      model: row.model,
      batch: row.batch,
      version: Number(row.version),
      recordDigest: row.record_digest,
      snapshotDigest: row.snapshot_digest,
      recordedAt: row.recorded_at,
      stored: Number(row.stored) === 1,
      classification: row.classification,
      retentionUntil: row.retention_until,
      policyPin: row.policy_pin,
    };
  }

  private recordEvent(jobId: string, stage: JobStage, outcome: JobEvent["outcome"], code: string | null = null): void {
    this.db.run(
      `INSERT INTO job_events (job_id, security_domain, stage, outcome, code, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      jobId,
      this.securityDomain,
      stage,
      outcome,
      code,
      this.now(),
    );
  }

  /**
   * Moves a claimed job forward and records the event, in one transaction. Every transition is guarded by the
   * `running` state and the input key the job was claimed for, so a job that was rolled back, taken over or
   * committed meanwhile can never be moved again (C6-03).
   */
  private advance(
    jobId: string,
    inputKey: string,
    set: string,
    params: SqlParam[],
    event: { stage: JobStage; outcome: JobEvent["outcome"]; code?: string | null },
  ): void {
    this.db.transaction(() => {
      const res = this.db.run(
        `UPDATE import_jobs SET ${set}, updated_at = ? WHERE job_id = ? AND state = 'running' AND input_key = ?`,
        ...params,
        this.now(),
        jobId,
        inputKey,
      );
      if (res.changes !== 1) {
        throw new ConcurrencyConflictError("idempotency-conflict", `Job ${jobId} is no longer running for the input it was claimed with`);
      }
      this.recordEvent(jobId, event.stage, event.outcome, event.code ?? null);
    });
  }

  private failJob(jobId: string, inputKey: string, code: string, stage: string, extra: { model?: string; batch?: string } = {}, logInputs: Array<Record<string, unknown>> = []): void {
    this.db.transaction(() => {
      for (const ev of logInputs) this.logStore.addSync(ev as never, this.now());
      this.advance(
        jobId,
        inputKey,
        `state = 'failed', stage = 'failed', error_code = ?, error_stage = ?${extra.model ? ", model = ?, batch = ?" : ""}`,
        [code, stage, ...(extra.model ? [extra.model, extra.batch ?? ""] : [])],
        { stage: "failed", outcome: "error", code },
      );
    });
  }

  private replayOutcome(row: JobRow): ImportJobOutcome {
    const receipt = this.getReceiptForJob(row.job_id);
    const snapshot =
      row.model && row.batch && row.result_version
        ? this.repository.getSync(row.model, row.batch, Number(row.result_version))
        : undefined;
    return {
      ok: true,
      job: rowToJob(row),
      events: this.getJobEvents(row.job_id),
      receipt: receipt ? { ...receipt, stored: false } : undefined,
      snapshot,
      readiness: snapshot ? assess(this.pack, snapshot.record) : undefined,
    };
  }

  /**
   * Claims `(securityDomain, idempotencyKey)` atomically inside one `BEGIN IMMEDIATE` transaction:
   * `INSERT ... ON CONFLICT DO NOTHING` decides who owns the key. The other side gets the existing job's outcome,
   * waits for it if it is executing in this process, or is refused with a conflict when its payload digest differs.
   */
  private claim(
    req: RunImportJobRequest,
    c: { actor: string; inputKey: string; erpSha: string; labSha: string | null; classification: string; policyPin: string },
  ):
    | { kind: "owned"; jobId: string; resumeStaged: boolean }
    | { kind: "replay"; row: JobRow }
    | { kind: "inflight"; promise: Promise<ImportJobOutcome> } {
    return this.db.transaction(() => {
      const nowIso = this.now();
      const newId = `JOB-${randomUUID()}`;
      const ins = this.db.run(
        `INSERT INTO import_jobs (
          job_id, security_domain, idempotency_key, actor, state, stage,
          classification, retention_policy_pin, erp_sha256, lab_sha256, input_key, owner,
          expected_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'running', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (security_domain, idempotency_key) DO NOTHING`,
        newId,
        this.securityDomain,
        req.idempotencyKey,
        c.actor,
        c.classification,
        c.policyPin,
        c.erpSha,
        c.labSha,
        c.inputKey,
        PROCESS_ID,
        req.expectedVersion ?? null,
        nowIso,
        nowIso,
      );
      if (ins.changes === 1) {
        this.recordEvent(newId, "received", "ok");
        return { kind: "owned" as const, jobId: newId, resumeStaged: false };
      }

      const existing = this.db.get<JobRow>(
        "SELECT * FROM import_jobs WHERE security_domain = ? AND idempotency_key = ?",
        this.securityDomain,
        req.idempotencyKey,
      )!;
      if (existing.input_key !== c.inputKey) {
        throw new ConcurrencyConflictError(
          "idempotency-conflict",
          `Idempotency key "${req.idempotencyKey}" is already claimed for a different payload`,
        );
      }
      if (existing.state === "committed") return { kind: "replay" as const, row: existing };

      if (existing.state === "running") {
        const live = INFLIGHT.get(existing.job_id);
        if (live) return { kind: "inflight" as const, promise: live };
        const idleMs = Date.now() - Date.parse(existing.updated_at);
        if (existing.owner !== PROCESS_ID && idleMs < JOB_LEASE_MS) {
          throw new ConcurrencyConflictError(
            "idempotency-in-progress",
            `Idempotency key "${req.idempotencyKey}" is being processed by another server process`,
          );
        }
        // A crashed run of this process, or a run silent past its lease: resume from durable staged state if there is one.
        if (existing.stage === "staged" && existing.staged_payload_json && !req.injectCrashAt) {
          this.db.run("UPDATE import_jobs SET owner = ?, updated_at = ? WHERE job_id = ? AND state = 'running'", PROCESS_ID, nowIso, existing.job_id);
          return { kind: "owned" as const, jobId: existing.job_id, resumeStaged: true };
        }
      }

      // running (taken over), failed or rolled back: start the same job again from `received`
      const upd = this.db.run(
        `UPDATE import_jobs
         SET state = 'running', stage = 'received', actor = ?, classification = ?, retention_policy_pin = ?,
             owner = ?, expected_version = ?, staged_payload_json = NULL, error_code = NULL, error_stage = NULL, updated_at = ?
         WHERE job_id = ? AND input_key = ? AND state IN ('running', 'failed', 'rolled_back')`,
        c.actor,
        c.classification,
        c.policyPin,
        PROCESS_ID,
        req.expectedVersion ?? null,
        nowIso,
        existing.job_id,
        c.inputKey,
      );
      if (upd.changes !== 1) {
        throw new ConcurrencyConflictError("idempotency-conflict", `Idempotency key "${req.idempotencyKey}" changed while it was being claimed`);
      }
      this.recordEvent(existing.job_id, "received", "ok");
      return { kind: "owned" as const, jobId: existing.job_id, resumeStaged: false };
    });
  }

  /**
   * Executes a staged, crash-recoverable, transactional import job.
   * Refuses immediately if no active classification/retention policy is loaded (C6-02), if the dataset is not one of
   * the two input datasets, and claims the idempotency key atomically before any work starts (C6-03).
   */
  async runImportJob(req: RunImportJobRequest): Promise<ImportJobOutcome> {
    // C6-02 hard precondition: retention & classification policy MUST be active before any payload is processed
    const activePolicy = this.policies.requireActive();

    if (!req.idempotencyKey || !req.idempotencyKey.trim()) {
      throw badRequest("idempotency-key-missing", "idempotencyKey is required for every import job");
    }
    if (req.dataset !== undefined && !(IMPORT_DATASETS as readonly string[]).includes(req.dataset)) {
      throw badRequest("dataset-not-allowed", `An import job accepts only the datasets ${IMPORT_DATASETS.join(", ")}`);
    }

    const actor = req.actor ?? OPERATOR;
    // The input decides the class: a lab file can never be filed under the weaker ERP dataset.
    const derived = req.lab ? "lab-assessment" : "erp-extract";
    const requested = req.dataset ?? derived;
    const rank = (d: string) => CLASSIFICATIONS.indexOf(resolveDatasetRetention(activePolicy.policy, d).classification);
    const dataset = rank(requested) >= rank(derived) ? requested : derived;
    const erpSha = sha256Sync(req.erp.bytes);
    const labSha = req.lab ? sha256Sync(req.lab.bytes) : null;
    // Evidence is part of what the key is claimed for: the same files with other evidence are a different payload (409).
    const evidenceKey = (req.evidence ?? []).length
      ? `:${sha256Sync(
          canonical(
            req.evidence!
              .map((e) => ({
                sha256: sha256Sync(e.contentBytes),
                evidenceId: e.evidenceId,
                issuer: e.issuer,
                revision: e.revision,
                recordKind: e.recordKind,
                dataset: e.dataset ?? null,
                legalHold: !!e.legalHold,
              }))
              .sort((a, b) => (a.sha256 + a.evidenceId).localeCompare(b.sha256 + b.evidenceId)),
          ),
        )}`
      : "";
    const inputKey = `${erpSha}:${labSha ?? "-"}:${dataset}${evidenceKey}`;
    const retention = resolveDatasetRetention(activePolicy.policy, dataset, req.statedClassification);

    const claimed = this.claim(req, {
      actor,
      inputKey,
      erpSha,
      labSha,
      classification: retention.classification,
      policyPin: retention.policyPin,
    });
    if (claimed.kind === "replay") return this.replayOutcome(claimed.row);
    if (claimed.kind === "inflight") return claimed.promise;
    if (req.control) {
      this.db.run(
        "INSERT OR IGNORE INTO job_submitters (job_id, security_domain, submitter_sub, recorded_at) VALUES (?, ?, ?, ?)",
        claimed.jobId,
        this.securityDomain,
        req.control.submitterSub,
        this.now(),
      );
      req.control.onClaimed?.(claimed.jobId);
    }

    // No await between the claim and registering the promise: a duplicate request sees it, never a gap.
    const promise = this.executeClaimed(claimed.jobId, claimed.resumeStaged, req, { actor, dataset, inputKey });
    INFLIGHT.set(claimed.jobId, promise);
    try {
      return await promise;
    } finally {
      INFLIGHT.delete(claimed.jobId);
    }
  }

  private async executeClaimed(
    jobId: string,
    resumeStaged: boolean,
    req: RunImportJobRequest,
    ctx: { actor: typeof OPERATOR; dataset: string; inputKey: string },
  ): Promise<ImportJobOutcome> {
    try {
      if (resumeStaged) return this.commitStagedJob(jobId, true);
      return await this.pipeline(jobId, req, ctx);
    } catch (err) {
      if (err instanceof LimitError) {
        if (err.outcome === "CANCELLED") {
          // Cancelled: nothing was promoted, the job ends rolled back with the `cancelled` code (outcome CANCELLED).
          this.markJobRolledBack(jobId, "cancelled");
          throw err;
        }
        if (err.outcome === "TIMEOUT") {
          // Deadline: promotion was revoked before commit, so the job ends failed with the `deadline` code (outcome TIMEOUT).
          return this.failJobOnTimeout(jobId, err.stage);
        }
      }
      if (!(err instanceof SimulatedCrashError)) {
        // Anything else leaves nothing half-done: a job still running is rolled back (a failed one stays failed).
        this.markJobRolledBack(jobId, err instanceof ConcurrencyConflictError ? err.code : "internal-error");
      }
      throw err;
    }
  }

  /** Ends a running job as failed on its deadline, drops its staged payload, and answers with the TIMEOUT outcome. */
  private failJobOnTimeout(jobId: string, stage: string | undefined): ImportJobOutcome {
    this.db.transaction(() => {
      const res = this.db.run(
        `UPDATE import_jobs SET state = 'failed', stage = 'failed', staged_payload_json = NULL,
         error_code = 'deadline', error_stage = ?, updated_at = ? WHERE job_id = ? AND state = 'running'`,
        stage ?? "route",
        this.now(),
        jobId,
      );
      if (res.changes === 1) this.recordEvent(jobId, "failed", "error", "deadline");
    });
    return {
      ok: false,
      job: this.getJob(jobId)!,
      events: this.getJobEvents(jobId),
      errors: [ingressIssue(ingressStage(stage), "deadline", "job")],
      outcome: "TIMEOUT",
      limit: "job_deadline_ms",
    };
  }

  /**
   * Stage boundary of a controlled job: yields to the event loop so a cancel request can be served, runs the test seam,
   * then checks the cancellation token and the deadline (within `cancellation_poll_max_ms` of simulated ticks).
   */
  private async boundary(jobId: string, stage: string, control: ImportJobControl | undefined): Promise<void> {
    if (!control) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await control.stageHook?.(stage, { jobId, budget: control.budget });
    control.budget.check(stage);
  }

  /** A job-level budget refusal: the job fails with the given code and nothing is written to the log or the store. */
  private refuseOverLimit(jobId: string, inputKey: string, limit: LimitName, stage: Stage, location: string): ImportJobOutcome {
    this.failJob(jobId, inputKey, "too-large", stage);
    return {
      ok: false,
      job: this.getJob(jobId)!,
      events: this.getJobEvents(jobId),
      errors: [ingressIssue(stage, "too-large", location)],
      outcome: "OVER_LIMIT",
      limit,
    };
  }

  // ---- cancellation record (access-controlled; never in the public log) ----

  getSubmitter(jobId: string): string | null {
    const row = this.db.get<{ submitter_sub: string }>(
      "SELECT submitter_sub FROM job_submitters WHERE security_domain = ? AND job_id = ?",
      this.securityDomain,
      jobId,
    );
    return row?.submitter_sub ?? null;
  }

  /** Records the first cancel request of a job. A repeat changes nothing and keeps the first reason. */
  recordCancellation(jobId: string, requestedBy: string, reason: string): void {
    this.db.run(
      `INSERT OR IGNORE INTO job_cancellations (job_id, security_domain, requested_by, reason, outcome, requested_at)
       VALUES (?, ?, ?, ?, 'CANCELLED', ?)`,
      jobId,
      this.securityDomain,
      requestedBy,
      reason,
      this.now(),
    );
  }

  getCancellation(jobId: string): { requestedBy: string; reason: string; requestedAt: string; outcome: "CANCELLED" } | null {
    const row = this.db.get<{ requested_by: string; reason: string; requested_at: string; outcome: "CANCELLED" }>(
      "SELECT requested_by, reason, requested_at, outcome FROM job_cancellations WHERE security_domain = ? AND job_id = ?",
      this.securityDomain,
      jobId,
    );
    return row ? { requestedBy: row.requested_by, reason: row.reason, requestedAt: row.requested_at, outcome: row.outcome } : null;
  }

  private async pipeline(
    jobId: string,
    req: RunImportJobRequest,
    ctx: { actor: typeof OPERATOR; dataset: string; inputKey: string },
  ): Promise<ImportJobOutcome> {
    const { actor, dataset, inputKey } = ctx;
    const activePolicy = this.policies.requireActive();
    const control = req.control;

    if (req.injectCrashAt === "after-receive") {
      throw new SimulatedCrashError("after-receive");
    }
    await this.boundary(jobId, "received", control);

    // Stage 2: classified (C6-02 / LEAN-DEF-12)
    const retention = resolveDatasetRetention(activePolicy.policy, dataset, req.statedClassification);
    this.advance(jobId, inputKey, "stage = 'classified', classification = ?, retention_policy_pin = ?", [retention.classification, retention.policyPin], {
      stage: "classified",
      outcome: "ok",
    });

    if (req.injectCrashAt === "after-classify") {
      throw new SimulatedCrashError("after-classify");
    }
    await this.boundary(jobId, "classified", control);

    // Job-level byte budgets (D8-02): the pair of source files, then everything one job would stage. Exactly the limit passes.
    if (control) {
      const pairBytes = req.erp.bytes.byteLength + (req.lab?.bytes.byteLength ?? 0);
      if (pairBytes > control.limits.source_pair_max_bytes) {
        return this.refuseOverLimit(jobId, inputKey, "source_pair_max_bytes", "bytes", "source pair");
      }
      const stagingBytes = pairBytes + (req.evidence ?? []).reduce((n, e) => n + e.contentBytes.byteLength, 0);
      if (stagingBytes > control.limits.total_staging_max_bytes) {
        return this.refuseOverLimit(jobId, inputKey, "total_staging_max_bytes", "bytes", "staged payload");
      }
    }

    // Stage 3: validated (strict N ingress + EV-5 time envelope + shared job deadline). The server assigns recordedAt.
    const envelope = resolveCallerTimeEnvelope(req.timeEnvelope, this.now());
    // One monotonic clock for the job's start and for the ingress deadline that is measured against it.
    const startedAt = this.clock();
    const ingressControl = control
      ? {
          budget: control.budget,
          limits: {
            maxFileBytes: control.limits.source_file_max_bytes,
            maxJsonDepth: control.limits.max_nesting_depth,
            maxRows: control.limits.max_records_per_job,
            maxParserNodes: control.limits.max_parser_nodes_per_job,
            deadlineMs: control.limits.job_deadline_ms,
          },
        }
      : {};
    const erpRes: ImportResult = await importErpCsv(
      this.pack,
      { bytes: req.erp.bytes, name: req.erp.name, type: req.erp.type, startedAt, now: this.clock, ...ingressControl },
      actor,
    );
    const labRes: ImportResult | undefined = req.lab
      ? await importLabJson(
          this.pack,
          { bytes: req.lab.bytes, name: req.lab.name, type: req.lab.type, startedAt, now: this.clock, ...ingressControl },
          actor,
        )
      : undefined;

    if (!erpRes.ok || (labRes && !labRes.ok)) {
      const errors: IngressIssue[] = [
        ...(!erpRes.ok ? erpRes.errors : []),
        ...(labRes && !labRes.ok ? labRes.errors : []),
      ];
      const first = errors[0];
      const logInputs = [...importEvents(erpRes), ...(labRes ? importEvents(labRes) : [])];
      this.failJob(jobId, inputKey, first?.code ?? "ingress-error", first?.stage ?? "semantics", {}, logInputs as never);
      const stopped = first ? classifyLimitOutcome(first.code) : null;
      return {
        ok: false,
        job: this.getJob(jobId)!,
        events: this.getJobEvents(jobId),
        errors,
        ...(stopped && first && LIMIT_OF_CODE[first.code] ? { outcome: stopped, limit: LIMIT_OF_CODE[first.code]! } : {}),
      };
    }

    const built = await buildRecords(labRes ? [erpRes, labRes] : [erpRes]);
    const incoming = built.records[0];
    if (!incoming) {
      this.failJob(jobId, inputKey, "no-rows", "structure");
      return {
        ok: false,
        job: this.getJob(jobId)!,
        events: this.getJobEvents(jobId),
        errors: [{ stage: "structure", code: "no-rows", message: "No product record was produced.", location: req.erp.name }],
      };
    }

    const unattachedLab = built.unattached.length > 0;
    if (unattachedLab) {
      // Do not silently merge an unattached lab file onto an unrelated ERP batch (P01 exception EX-UNATTACHED-LAB-BATCH)
      const logInputs = [...importEvents(erpRes), ...(labRes ? importEvents(labRes) : [])];
      this.failJob(jobId, inputKey, "unattached-lab", "semantics", { model: incoming.model, batch: incoming.batch }, logInputs as never);
      return {
        ok: false,
        job: this.getJob(jobId)!,
        events: this.getJobEvents(jobId),
        unattachedLab: true,
        errors: [
          {
            stage: "semantics",
            code: "subject-mismatch",
            message: "The laboratory file refers to a product model or batch that does not match the ERP extract.",
            location: req.lab?.name ?? "lab",
          },
        ],
      };
    }

    // Validate attached evidence digests BEFORE staging so corrupted evidence never enters staged state (C6-05)
    for (const ev of req.evidence ?? []) {
      const actualSha = sha256Sync(ev.contentBytes);
      if (ev.declaredSha256 !== undefined) {
        const norm = ev.declaredSha256.replace(/^sha256:/i, "").toLowerCase();
        if (norm !== actualSha) {
          this.failJob(jobId, inputKey, "digest-mismatch", "retention");
          throw new RetentionViolationError(
            "digest-mismatch",
            `Evidence ${ev.evidenceId}: declared digest ${norm} does not match computed ${actualSha}`,
          );
        }
      }
    }

    this.advance(jobId, inputKey, "stage = 'validated', model = ?, batch = ?", [incoming.model, incoming.batch], {
      stage: "validated",
      outcome: "ok",
    });

    if (req.injectCrashAt === "after-validate") {
      throw new SimulatedCrashError("after-validate");
    }
    await this.boundary(jobId, "validated", control);

    // Stage 4: stage durable payload (computing carryCorrections against current latest snapshot)
    const maxRetries = req.expectedVersion !== undefined && req.expectedVersion !== null ? 1 : 6;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const latest = this.repository.latestSync(incoming.model, incoming.batch);
      const seenVersion = latest?.version ?? 0;
      if (
        req.expectedVersion !== undefined &&
        req.expectedVersion !== null &&
        req.expectedVersion !== seenVersion
      ) {
        this.failJob(jobId, inputKey, "version-conflict", "route");
        throw new ConcurrencyConflictError(
          "version-conflict",
          `Record ${incoming.model} / ${incoming.batch}: expected version ${req.expectedVersion} but latest is ${seenVersion}`,
        );
      }

      const { record, carried, disputed } = await carryCorrections(latest, incoming);
      const reason =
        req.reason ??
        (!latest
          ? REASON_FIRST
          : disputed
            ? `${REASON_REIMPORT}: the source changed after a correction, so the value is challenged`
            : carried
              ? `${REASON_REIMPORT}: corrections carried forward`
              : REASON_REIMPORT);

      const readiness = assess(this.pack, record);
      const nextVersion = latest && latest.record.digest === record.digest ? latest.version : seenVersion + 1;
      const logEntries = [
        ...importEvents(erpRes),
        ...(labRes ? importEvents(labRes) : []),
        ...(await readinessEvents(record.model, record.batch, readiness, nextVersion)),
      ];

      const staged: StagedPayload = {
        record,
        reason,
        actor,
        dataset,
        statedClassification: req.statedClassification,
        expectedVersion: req.expectedVersion ?? null,
        seenVersion,
        carried,
        disputed,
        timeEnvelope: envelope,
        evidence: (req.evidence ?? []).map((e) => ({
          evidenceId: e.evidenceId,
          issuer: e.issuer,
          revision: e.revision,
          recordKind: e.recordKind,
          dataset: e.dataset,
          statedClassification: e.statedClassification,
          declaredSha256: e.declaredSha256,
          mediaType: e.mediaType,
          contentBase64: Buffer.from(e.contentBytes).toString("base64"),
          legalHold: e.legalHold,
        })),
        logEntries,
      };

      this.advance(jobId, inputKey, "stage = 'staged', staged_payload_json = ?", [JSON.stringify(staged)], {
        stage: "staged",
        outcome: "ok",
      });

      // after-stage: the payload is durable but no commit has begun.
      if (req.injectCrashAt === "after-stage") {
        throw new SimulatedCrashError("after-stage");
      }
      await this.boundary(jobId, "staged", control);

      try {
        // before-commit crashes INSIDE the commit transaction, after every row is written and before COMMIT:
        // everything rolls back and only the staged payload remains.
        const outcome = this.commitStagedJob(jobId, false, req.injectCrashAt === "before-commit", control?.budget);
        if (req.injectCrashAt === "after-commit") {
          throw new SimulatedCrashError("after-commit");
        }
        return outcome;
      } catch (err) {
        if (
          err instanceof ConcurrencyConflictError &&
          err.code === "version-conflict" &&
          (req.expectedVersion === undefined || req.expectedVersion === null) &&
          attempt < maxRetries - 1
        ) {
          // Concurrent writer committed while we were staging; re-run carryCorrections against fresh latest
          continue;
        }
        if (err instanceof ConcurrencyConflictError && err.code === "version-conflict") {
          this.markJobRolledBack(jobId, "version-conflict");
        }
        throw err;
      }
    }

    this.markJobRolledBack(jobId, "version-conflict");
    throw new ConcurrencyConflictError("version-conflict", "Exceeded concurrent serialization retries");
  }

  private markJobRolledBack(jobId: string, code: string): void {
    this.db.transaction(() => {
      const res = this.db.run(
        `UPDATE import_jobs SET state = 'rolled_back', stage = 'rolled_back', staged_payload_json = NULL,
         error_code = ?, updated_at = ? WHERE job_id = ? AND state = 'running'`,
        code,
        this.now(),
        jobId,
      );
      if (res.changes === 1) this.recordEvent(jobId, "rolled_back", "rolled_back", code);
    });
  }

  /**
   * Atomically commits a job currently in `stage = 'staged'` inside a single `BEGIN IMMEDIATE`
   * transaction. Used both for normal completion and for crash recovery (`recovered = true`).
   */
  private commitStagedJob(jobId: string, recovered: boolean, crashBeforeCommit = false, budget?: JobBudget): ImportJobOutcome {
    const activePolicy = this.policies.requireActive();

    let committed;
    try {
      committed = this.db.transaction((): CommitResult | { replay: JobRow } => {
        // Promotion is revoked once a cancel or the deadline has tripped: a stopped job never commits (D8-02).
        // The whole commit runs synchronously inside this transaction, so no cancel can land between this check and the COMMIT.
        budget?.assertMayCommit();
        const row = this.db.get<JobRow>(
          "SELECT * FROM import_jobs WHERE security_domain = ? AND job_id = ?",
          this.securityDomain,
          jobId,
        );
        if (row?.state === "committed") return { replay: row };
        if (!row || row.state !== "running" || !row.staged_payload_json) {
          throw new ConcurrencyConflictError(
            "idempotency-conflict",
            `Job ${jobId} is not a running job with a durable staged payload, so it cannot be committed`,
          );
        }

        const staged = JSON.parse(row.staged_payload_json) as StagedPayload;
        // Integrity verify the staged record before committing
        if (recordDigestSync(staged.record) !== staged.record.digest) {
          throw new Error(`STAGED_DIGEST_MISMATCH:${jobId}`);
        }

        const latest = this.repository.latestSync(staged.record.model, staged.record.batch);
        const currentVersion = latest?.version ?? 0;

        // Guard against concurrent write between staging and commit
        const expected = staged.expectedVersion !== null ? staged.expectedVersion : staged.seenVersion;
        if (currentVersion !== expected) {
          throw new ConcurrencyConflictError(
            "version-conflict",
            `Concurrent update on ${staged.record.model} / ${staged.record.batch}: expected v${expected}, found v${currentVersion}`,
          );
        }

        const { stored, snapshot, metadata } = this.repository.storeRecordAtomic(staged.record, {
          expectedVersion: expected,
          reason: staged.reason,
          actor: staged.actor,
          dataset: "central-record-snapshot",
          statedClassification: staged.statedClassification,
          timeEnvelope: staged.timeEnvelope,
        });

        const storedEvidence: EvidenceRetentionMetadata[] = [];
        for (const ev of staged.evidence) {
          const req: PutEvidenceRequest = {
            evidenceId: ev.evidenceId,
            issuer: ev.issuer,
            revision: ev.revision,
            recordKind: ev.recordKind,
            dataset: ev.dataset ?? "evidence-object",
            statedClassification: ev.statedClassification,
            declaredSha256: ev.declaredSha256,
            mediaType: ev.mediaType,
            contentBytes: new Uint8Array(Buffer.from(ev.contentBase64, "base64")),
            legalHold: ev.legalHold,
            storedAt: staged.timeEnvelope.recordedAt,
          };
          storedEvidence.push(this.evidenceStore.put(req).metadata);
        }

        for (const entry of staged.logEntries) {
          this.logStore.addSync(entry, staged.timeEnvelope.recordedAt);
        }

        const committedAt = this.now();
        const retention = resolveDatasetRetention(activePolicy.policy, staged.dataset, staged.statedClassification);
        // An unchanged record keeps the horizon of the version it already is; a new one runs from its own recording time.
        const retentionUntil = stored ? computeRetentionUntil(staged.timeEnvelope.recordedAt, retention.retentionDays) : metadata.retentionUntil;

        const receipt: UpdateReceipt = {
          receiptId: `RCPT-${randomUUID()}`,
          jobId,
          idempotencyKey: row.idempotency_key,
          securityDomain: this.securityDomain,
          model: snapshot.model,
          batch: snapshot.batch,
          version: snapshot.version,
          recordDigest: snapshot.record.digest,
          snapshotDigest: snapshot.digest,
          recordedAt: metadata.timeEnvelope.recordedAt,
          stored,
          classification: metadata.classification,
          retentionUntil,
          policyPin: metadata.retentionPolicyPin,
        };

        this.db.run(
          `INSERT INTO update_receipts (
            receipt_id, job_id, idempotency_key, security_domain, model, batch, version,
            record_digest, snapshot_digest, recorded_at, stored, classification, retention_until, policy_pin
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          receipt.receiptId,
          receipt.jobId,
          receipt.idempotencyKey,
          receipt.securityDomain,
          receipt.model,
          receipt.batch,
          receipt.version,
          receipt.recordDigest,
          receipt.snapshotDigest,
          receipt.recordedAt,
          receipt.stored ? 1 : 0,
          receipt.classification,
          receipt.retentionUntil,
          receipt.policyPin,
        );

        const done = this.db.run(
          `UPDATE import_jobs
           SET state = 'committed', stage = 'committed', result_version = ?, result_snapshot_digest = ?,
               staged_payload_json = NULL, error_code = NULL, error_stage = NULL,
               updated_at = ?, committed_at = ?
           WHERE job_id = ? AND state = 'running' AND stage = 'staged'`,
          snapshot.version,
          snapshot.digest,
          committedAt,
          committedAt,
          jobId,
        );
        if (done.changes !== 1) {
          throw new ConcurrencyConflictError("idempotency-conflict", `Job ${jobId} was no longer staged when its commit finished`);
        }
        this.recordEvent(jobId, "committed", recovered ? "recovered" : "ok");

        if (crashBeforeCommit) throw new SimulatedCrashError("before-commit");

        return {
          snapshot,
          receipt,
          storedEvidence,
          carried: staged.carried,
          disputed: staged.disputed,
        };
      });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("STAGED_DIGEST_MISMATCH:")) {
        this.markJobRolledBack(jobId, "staged-digest-mismatch");
        throw new Error(`Staged payload for job ${jobId} failed digest verification`);
      }
      if (recovered && err instanceof ConcurrencyConflictError) {
        this.markJobRolledBack(jobId, err.code);
      }
      throw err;
    }

    if ("replay" in committed) return this.replayOutcome(committed.replay);
    return {
      ok: true,
      job: this.getJob(jobId)!,
      events: this.getJobEvents(jobId),
      receipt: committed.receipt,
      snapshot: committed.snapshot,
      readiness: assess(this.pack, committed.snapshot.record),
      evidence: committed.storedEvidence,
      carried: committed.carried,
      disputed: committed.disputed,
    };
  }

  /**
   * Recovers all in-flight (`state = 'running'`) jobs after a crash or process restart (C6-04):
   * - Jobs with a valid durable staged payload (`stage = 'staged'`) resume atomically to `committed`
   *   (or roll back cleanly on conflict).
   * - Jobs interrupted earlier (`received`, `classified`, `validated`) roll back cleanly to `rolled_back`
   *   with zero partial snapshots or evidence rows.
   */
  recoverPendingJobs(options: { force?: boolean } = {}): RecoveryReport {
    // Jobs executing now are never touched. A job of another process is left alone until its lease has run out,
    // unless `force` is set (server start-up, which assumes it is the only process on the data file).
    const pending = this.db
      .query<JobRow>(
        "SELECT * FROM import_jobs WHERE security_domain = ? AND state = 'running' ORDER BY created_at ASC",
        this.securityDomain,
      )
      .filter((row) => {
        if (INFLIGHT.has(row.job_id)) return false;
        if (options.force || row.owner === PROCESS_ID) return true;
        return Date.now() - Date.parse(row.updated_at) >= JOB_LEASE_MS;
      });

    const resumed: string[] = [];
    const rolledBack: string[] = [];

    for (const row of pending) {
      if (row.stage === "staged" && row.staged_payload_json) {
        try {
          this.commitStagedJob(row.job_id, true);
          resumed.push(row.job_id);
        } catch {
          // Ensure rolled_back state if commit threw before updating job row
          const current = this.getJob(row.job_id);
          if (current && current.state === "running") {
            this.db.transaction(() => {
              this.db.run(
                `UPDATE import_jobs
                 SET state = 'rolled_back', stage = 'rolled_back', staged_payload_json = NULL,
                     error_code = 'recovery-rollback', updated_at = ?
                 WHERE job_id = ?`,
                this.now(),
                row.job_id,
              );
              this.recordEvent(row.job_id, "rolled_back", "rolled_back", "recovery-rollback");
            });
          }
          rolledBack.push(row.job_id);
        }
      } else {
        this.db.transaction(() => {
          this.db.run(
            `UPDATE import_jobs
             SET state = 'rolled_back', stage = 'rolled_back', staged_payload_json = NULL,
                 error_code = 'interrupted-before-stage', updated_at = ?
             WHERE job_id = ?`,
            this.now(),
            row.job_id,
          );
          this.recordEvent(row.job_id, "rolled_back", "rolled_back", "interrupted-before-stage");
        });
        rolledBack.push(row.job_id);
      }
    }

    return { scanned: pending.length, resumed, rolledBack };
  }

  /** Helper exposing sanitized record digest ref for external callers (e.g., HTTP API logging). */
  async logCorrection(model: string, batch: string, version: number): Promise<void> {
    this.logStore.addSync({
      event: "correction",
      outcome: "corrected",
      record: await recordRef(model, batch),
      version,
    });
  }
}
