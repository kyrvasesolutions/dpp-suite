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
import { carryCorrections } from "../../src/model/correction";
import {
  buildRecords,
  importErpCsv,
  importLabJson,
  type ImportResult,
  type IngressIssue,
  type ProductRecord,
} from "../../src/model/ingress";
import { importEvents, readinessEvents, recordRef } from "../../src/model/log";
import {
  computeRetentionUntil,
  ConcurrencyConflictError,
  DEFAULT_SECURITY_DOMAIN,
  resolveDatasetRetention,
  RetentionViolationError,
  validateEv5TimeEnvelope,
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
import type { DbAdapter } from "../db/adapter";
import { PolicyStore } from "../store/policyStore";
import { SqlEvidenceStore, type PutEvidenceRequest } from "../store/sqlEvidenceStore";
import { SqlLogStore } from "../store/sqlLogStore";
import { defaultTimeEnvelope, recordDigestSync, sha256Sync, SqlRecordRepository } from "../store/sqlRepository";

export class SimulatedCrashError extends Error {
  override name = "SimulatedCrashError";
  constructor(public readonly crashPoint: CrashPoint) {
    super(`Simulated crash injected at ${crashPoint}`);
  }
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
  timeEnvelope?: Ev5TimeEnvelope;
  evidence?: ImportEvidenceUpload[];
  /** Deterministic crash-injection hook for AT-U recovery tests (C6-04). */
  injectCrashAt?: CrashPoint;
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

  constructor(
    private readonly db: DbAdapter,
    private readonly pack: ProfilePack,
    public readonly securityDomain: string = DEFAULT_SECURITY_DOMAIN,
  ) {
    if (!securityDomain.trim()) {
      throw new RetentionViolationError("domain-missing", "securityDomain is required for ImportJobRunner");
    }
    this.policies = new PolicyStore(db);
    this.repository = new SqlRecordRepository(db, securityDomain);
    this.evidenceStore = new SqlEvidenceStore(db, securityDomain);
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
      new Date().toISOString(),
    );
  }

  /**
   * Executes a staged, crash-recoverable, transactional import job.
   * Refuses immediately if no active classification/retention policy is loaded (C6-02).
   */
  async runImportJob(req: RunImportJobRequest): Promise<ImportJobOutcome> {
    // C6-02 hard precondition: retention & classification policy MUST be active before any payload is processed
    const activePolicy = this.policies.requireActive();

    if (!req.idempotencyKey || !req.idempotencyKey.trim()) {
      throw new ConcurrencyConflictError("idempotency-conflict", "idempotencyKey is required for every import job");
    }

    const actor = req.actor ?? OPERATOR;
    const dataset = req.dataset ?? (req.lab ? "lab-assessment" : "erp-extract");
    const erpSha = sha256Sync(req.erp.bytes);
    const labSha = req.lab ? sha256Sync(req.lab.bytes) : null;
    const nowIso = new Date().toISOString();

    // Check existing job with the same (securityDomain, idempotencyKey)
    const existingRow = this.db.get<JobRow>(
      "SELECT * FROM import_jobs WHERE security_domain = ? AND idempotency_key = ?",
      this.securityDomain,
      req.idempotencyKey,
    );

    if (existingRow) {
      if (existingRow.state === "committed") {
        if (existingRow.erp_sha256 !== erpSha || existingRow.lab_sha256 !== labSha) {
          throw new ConcurrencyConflictError(
            "idempotency-conflict",
            `Idempotency key "${req.idempotencyKey}" was already committed for different input digests`,
          );
        }
        const receipt = this.getReceiptForJob(existingRow.job_id);
        const snapshot =
          existingRow.model && existingRow.batch && existingRow.result_version
            ? this.repository.getSync(existingRow.model, existingRow.batch, Number(existingRow.result_version))
            : undefined;
        const readiness = snapshot ? assess(this.pack, snapshot.record) : undefined;
        return {
          ok: true,
          job: rowToJob(existingRow),
          events: this.getJobEvents(existingRow.job_id),
          receipt: receipt ? { ...receipt, stored: false } : undefined,
          snapshot,
          readiness,
        };
      }

      // If an interrupted job reached `staged` with matching digests, resume directly from durable staged state!
      if (
        existingRow.state === "running" &&
        existingRow.stage === "staged" &&
        existingRow.staged_payload_json &&
        existingRow.erp_sha256 === erpSha &&
        existingRow.lab_sha256 === labSha &&
        !req.injectCrashAt
      ) {
        return this.commitStagedJob(existingRow.job_id, true);
      }
    }

    // Stage 1: received
    const jobId = existingRow ? existingRow.job_id : `JOB-${randomUUID()}`;
    const defaultClass = activePolicy.policy.default_classification;
    this.db.transaction(() => {
      if (existingRow) {
        this.db.run(
          `UPDATE import_jobs
           SET state = 'running', stage = 'received', actor = ?, classification = ?, retention_policy_pin = ?,
               erp_sha256 = ?, lab_sha256 = ?, expected_version = ?, staged_payload_json = NULL,
               error_code = NULL, error_stage = NULL, updated_at = ?
           WHERE job_id = ?`,
          actor,
          defaultClass,
          activePolicy.policyPin,
          erpSha,
          labSha,
          req.expectedVersion ?? null,
          nowIso,
          jobId,
        );
      } else {
        this.db.run(
          `INSERT INTO import_jobs (
            job_id, security_domain, idempotency_key, actor, state, stage,
            classification, retention_policy_pin, erp_sha256, lab_sha256,
            expected_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'running', 'received', ?, ?, ?, ?, ?, ?, ?)`,
          jobId,
          this.securityDomain,
          req.idempotencyKey,
          actor,
          defaultClass,
          activePolicy.policyPin,
          erpSha,
          labSha,
          req.expectedVersion ?? null,
          nowIso,
          nowIso,
        );
      }
      this.recordEvent(jobId, "received", "ok");
    });

    if (req.injectCrashAt === "after-receive") {
      throw new SimulatedCrashError("after-receive");
    }

    // Stage 2: classified (C6-02 / LEAN-DEF-12)
    const retention = resolveDatasetRetention(activePolicy.policy, dataset, req.statedClassification);
    this.db.transaction(() => {
      this.db.run(
        `UPDATE import_jobs SET stage = 'classified', classification = ?, retention_policy_pin = ?, updated_at = ?
         WHERE job_id = ?`,
        retention.classification,
        retention.policyPin,
        new Date().toISOString(),
        jobId,
      );
      this.recordEvent(jobId, "classified", "ok");
    });

    if (req.injectCrashAt === "after-classify") {
      throw new SimulatedCrashError("after-classify");
    }

    // Stage 3: validated (strict N ingress + EV-5 time envelope check + shared job deadline)
    const envelope = validateEv5TimeEnvelope(req.timeEnvelope ?? defaultTimeEnvelope());
    const startedAt = Date.now();
    const erpRes: ImportResult = await importErpCsv(
      this.pack,
      { bytes: req.erp.bytes, name: req.erp.name, type: req.erp.type, startedAt },
      actor,
    );
    const labRes: ImportResult | undefined = req.lab
      ? await importLabJson(
          this.pack,
          { bytes: req.lab.bytes, name: req.lab.name, type: req.lab.type, startedAt },
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
      this.db.transaction(() => {
        for (const ev of logInputs) this.logStore.addSync(ev);
        this.db.run(
          `UPDATE import_jobs SET state = 'failed', stage = 'failed', error_code = ?, error_stage = ?, updated_at = ?
           WHERE job_id = ?`,
          first?.code ?? "ingress-error",
          first?.stage ?? "semantics",
          new Date().toISOString(),
          jobId,
        );
        this.recordEvent(jobId, "failed", "error", first?.code ?? "ingress-error");
      });
      return {
        ok: false,
        job: this.getJob(jobId)!,
        events: this.getJobEvents(jobId),
        errors,
      };
    }

    const built = await buildRecords(labRes ? [erpRes, labRes] : [erpRes]);
    const incoming = built.records[0];
    if (!incoming) {
      this.db.transaction(() => {
        this.db.run(
          `UPDATE import_jobs SET state = 'failed', stage = 'failed', error_code = 'no-rows', error_stage = 'structure', updated_at = ?
           WHERE job_id = ?`,
          new Date().toISOString(),
          jobId,
        );
        this.recordEvent(jobId, "failed", "error", "no-rows");
      });
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
      this.db.transaction(() => {
        for (const ev of logInputs) this.logStore.addSync(ev);
        this.db.run(
          `UPDATE import_jobs
           SET state = 'failed', stage = 'failed', model = ?, batch = ?, error_code = 'unattached-lab', error_stage = 'semantics', updated_at = ?
           WHERE job_id = ?`,
          incoming.model,
          incoming.batch,
          new Date().toISOString(),
          jobId,
        );
        this.recordEvent(jobId, "failed", "error", "unattached-lab");
      });
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
          this.db.transaction(() => {
            this.db.run(
              `UPDATE import_jobs SET state = 'failed', stage = 'failed', error_code = 'digest-mismatch', error_stage = 'retention', updated_at = ?
               WHERE job_id = ?`,
              new Date().toISOString(),
              jobId,
            );
            this.recordEvent(jobId, "failed", "error", "digest-mismatch");
          });
          throw new RetentionViolationError(
            "digest-mismatch",
            `Evidence ${ev.evidenceId}: declared digest ${norm} does not match computed ${actualSha}`,
          );
        }
      }
    }

    this.db.transaction(() => {
      this.db.run(
        `UPDATE import_jobs SET stage = 'validated', model = ?, batch = ?, updated_at = ? WHERE job_id = ?`,
        incoming.model,
        incoming.batch,
        new Date().toISOString(),
        jobId,
      );
      this.recordEvent(jobId, "validated", "ok");
    });

    if (req.injectCrashAt === "after-validate") {
      throw new SimulatedCrashError("after-validate");
    }

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
        this.db.transaction(() => {
          this.db.run(
            `UPDATE import_jobs SET state = 'failed', stage = 'failed', error_code = 'version-conflict', error_stage = 'route', updated_at = ?
             WHERE job_id = ?`,
            new Date().toISOString(),
            jobId,
          );
          this.recordEvent(jobId, "failed", "error", "version-conflict");
        });
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

      this.db.transaction(() => {
        this.db.run(
          `UPDATE import_jobs SET stage = 'staged', staged_payload_json = ?, updated_at = ? WHERE job_id = ?`,
          JSON.stringify(staged),
          new Date().toISOString(),
          jobId,
        );
        this.recordEvent(jobId, "staged", "ok");
      });

      if (req.injectCrashAt === "after-stage") {
        throw new SimulatedCrashError("after-stage");
      }
      if (req.injectCrashAt === "before-commit") {
        throw new SimulatedCrashError("before-commit");
      }

      try {
        const outcome = this.commitStagedJob(jobId, false);
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
      this.db.run(
        `UPDATE import_jobs SET state = 'rolled_back', stage = 'rolled_back', staged_payload_json = NULL,
         error_code = ?, updated_at = ? WHERE job_id = ? AND state = 'running'`,
        code,
        new Date().toISOString(),
        jobId,
      );
      this.recordEvent(jobId, "rolled_back", "rolled_back", code);
    });
  }

  /**
   * Atomically commits a job currently in `stage = 'staged'` inside a single `BEGIN IMMEDIATE`
   * transaction. Used both for normal completion and for crash recovery (`recovered = true`).
   */
  private commitStagedJob(jobId: string, recovered: boolean): ImportJobOutcome {
    const activePolicy = this.policies.requireActive();

    let committed;
    try {
      committed = this.db.transaction(() => {
        const row = this.db.get<JobRow>(
          "SELECT * FROM import_jobs WHERE security_domain = ? AND job_id = ?",
          this.securityDomain,
          jobId,
        );
        if (!row || !row.staged_payload_json) {
          throw new Error(`Job ${jobId} has no durable staged payload to commit`);
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

        const committedAt = new Date().toISOString();
        const retention = resolveDatasetRetention(activePolicy.policy, staged.dataset, staged.statedClassification);
        const retentionUntil = computeRetentionUntil(staged.timeEnvelope.recordedAt, retention.retentionDays);

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

        this.db.run(
          `UPDATE import_jobs
           SET state = 'committed', stage = 'committed', result_version = ?, result_snapshot_digest = ?,
               staged_payload_json = NULL, error_code = NULL, error_stage = NULL,
               updated_at = ?, committed_at = ?
           WHERE job_id = ?`,
          snapshot.version,
          snapshot.digest,
          committedAt,
          committedAt,
          jobId,
        );
        this.recordEvent(jobId, "committed", recovered ? "recovered" : "ok");

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
  recoverPendingJobs(): RecoveryReport {
    const pending = this.db.query<JobRow>(
      "SELECT * FROM import_jobs WHERE security_domain = ? AND state = 'running' ORDER BY created_at ASC",
      this.securityDomain,
    );

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
                new Date().toISOString(),
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
            new Date().toISOString(),
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
