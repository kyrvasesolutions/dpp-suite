/**
 * Typed domain contracts for bounded production onboarding, durable relational persistence,
 * staged recoverable jobs, classification/retention enforcement, and evidence integrity.
 *
 * Pure TypeScript + Zod only (no DOM, no Node built-ins) so both the browser client and the
 * Node 24 service share one canonical contract set.
 */
import { z } from "zod";
import { CLASSIFICATIONS, classify, DEFAULT_CLASSIFICATION, type Classification } from "./classification";

export const DEFAULT_SECURITY_DOMAIN = "default";

/** The six distinct time fields and half-open validity interval `[validFrom, validTo)` for durable snapshots. */
export const Ev5TimeEnvelopeSchema = z
  .object({
    recordedAt: z.string().datetime({ offset: true }),
    observedAt: z.string().datetime({ offset: true }).nullable(),
    declaredAt: z.string().datetime({ offset: true }).nullable(),
    publishedAt: z.string().datetime({ offset: true }).nullable(),
    validFrom: z.string().datetime({ offset: true }),
    validTo: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export type Ev5TimeEnvelope = z.infer<typeof Ev5TimeEnvelopeSchema>;

export const RetentionRuleSchema = z
  .object({
    dataset: z.string().min(1),
    classification: z.enum(CLASSIFICATIONS),
    retention_days: z.number().int().positive(),
    legal_hold_permitted: z.boolean(),
    description: z.string().min(1),
  })
  .strict();

export type RetentionRule = z.infer<typeof RetentionRuleSchema>;

export const RetentionPolicySchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    status: z.enum(["FROZEN", "HOLD"]).optional(),
    default_classification: z.literal(DEFAULT_CLASSIFICATION),
    default_retention_days: z.number().int().positive(),
    require_policy_before_ingest: z.literal(true),
    legal_hold_blocks_deletion: z.literal(true),
    datasets: z.array(RetentionRuleSchema).min(1),
  })
  .strict();

export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export const ExceptionRuleSchema = z
  .object({
    id: z.string().min(1),
    category: z.enum(["encoding", "structure", "numeric", "code-list", "conflict", "attachment", "evidence", "output", "classification"]),
    source: z.enum(["erp", "lab", "pair", "output", "evidence"]),
    expected_stage: z.enum(["bytes", "parse", "structure", "semantics", "readiness", "output", "retention"]),
    expected_outcome: z.enum(["accepted", "rejected", "held", "default-restricted"]),
    expected_code: z.string().min(1),
    handling: z.string().min(1),
    fixture: z.string().min(1).optional(),
  })
  .strict();

export type ExceptionRule = z.infer<typeof ExceptionRuleSchema>;

export const ExceptionCatalogueSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    status: z.enum(["FROZEN", "HOLD"]),
    exceptions: z.array(ExceptionRuleSchema).min(1),
  })
  .strict();

export type ExceptionCatalogue = z.infer<typeof ExceptionCatalogueSchema>;

export const JOB_STAGES = ["received", "classified", "validated", "staged", "committed", "rolled_back", "failed"] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export const JOB_STATES = ["running", "committed", "rolled_back", "failed"] as const;
export type JobState = (typeof JOB_STATES)[number];

export const CRASH_POINTS = [
  "after-receive",
  "after-classify",
  "after-validate",
  "after-stage",
  "before-commit",
  "after-commit",
] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export interface StagedImportJob {
  jobId: string;
  idempotencyKey: string;
  securityDomain: string;
  actor: string;
  state: JobState;
  stage: JobStage;
  classification: Classification;
  retentionPolicyPin: string;
  erpSha256: string | null;
  labSha256: string | null;
  model: string | null;
  batch: string | null;
  expectedVersion: number | null;
  resultVersion: number | null;
  resultSnapshotDigest: string | null;
  errorCode: string | null;
  errorStage: string | null;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
}

export interface JobEvent {
  seq: number;
  jobId: string;
  securityDomain: string;
  stage: JobStage;
  outcome: "ok" | "error" | "recovered" | "rolled_back";
  code: string | null;
  recordedAt: string;
}

export interface EvidenceRetentionMetadata {
  sha256: string;
  securityDomain: string;
  evidenceId: string;
  issuer: string;
  revision: string;
  recordKind: string;
  dataset: string;
  classification: Classification;
  policyPin: string;
  retentionDays: number;
  storedAt: string;
  retentionUntil: string;
  legalHold: boolean;
  sizeBytes: number;
  mediaType: string;
}

export interface UpdateReceipt {
  receiptId: string;
  jobId: string;
  idempotencyKey: string;
  securityDomain: string;
  model: string;
  batch: string;
  version: number;
  recordDigest: string;
  snapshotDigest: string;
  recordedAt: string;
  stored: boolean;
  classification: Classification;
  retentionUntil: string;
  policyPin: string;
}

export class RetentionViolationError extends Error {
  override name = "RetentionViolationError";
  constructor(
    public readonly code:
      | "policy-missing"
      | "policy-invalid"
      | "digest-mismatch"
      | "retention-active"
      | "legal-hold-active"
      | "legal-hold-forbidden"
      | "legal-hold-release-refused"
      | "policy-untrusted"
      | "policy-conflict"
      | "domain-missing",
    message: string,
  ) {
    super(message);
  }
}

export class ConcurrencyConflictError extends Error {
  override name = "ConcurrencyConflictError";
  constructor(
    public readonly code: "version-conflict" | "idempotency-conflict" | "idempotency-in-progress",
    message: string,
  ) {
    super(message);
  }
}

export class TimeEnvelopeError extends Error {
  override name = "TimeEnvelopeError";
  constructor(
    public readonly code: "invalid-timestamp" | "invalid-interval" | "collapsed-time-fields",
    message: string,
  ) {
    super(message);
  }
}

/** Normalizes any valid ISO-8601 timestamp (with offset or varying fractional seconds) to canonical fixed-width UTC `YYYY-MM-DDTHH:mm:ss.sssZ`. */
export function canonicalUtcIso(ts: string): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) {
    throw new TimeEnvelopeError("invalid-timestamp", `Invalid ISO-8601 timestamp: "${ts}"`);
  }
  return new Date(ms).toISOString();
}

/**
 * Validates and canonicalizes an EV-5 time envelope, enforcing half-open `[validFrom, validTo)`
 * semantics (`validFrom < validTo`) and normalizing all non-null timestamps to fixed-width UTC `.sssZ`
 * so database lexicographical comparisons always agree with chronological order.
 */
export function validateEv5TimeEnvelope(envelope: Ev5TimeEnvelope): Ev5TimeEnvelope {
  const parsed = Ev5TimeEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new TimeEnvelopeError("invalid-timestamp", `Invalid time envelope: ${parsed.error.issues[0]?.message ?? "malformed"}`);
  }
  const normalized: Ev5TimeEnvelope = {
    recordedAt: canonicalUtcIso(parsed.data.recordedAt),
    observedAt: parsed.data.observedAt !== null ? canonicalUtcIso(parsed.data.observedAt) : null,
    declaredAt: parsed.data.declaredAt !== null ? canonicalUtcIso(parsed.data.declaredAt) : null,
    publishedAt: parsed.data.publishedAt !== null ? canonicalUtcIso(parsed.data.publishedAt) : null,
    validFrom: canonicalUtcIso(parsed.data.validFrom),
    validTo: parsed.data.validTo !== null ? canonicalUtcIso(parsed.data.validTo) : null,
  };
  const start = Date.parse(normalized.validFrom);
  if (normalized.validTo !== null) {
    const end = Date.parse(normalized.validTo);
    if (end <= start) {
      throw new TimeEnvelopeError("invalid-interval", `Half-open interval [validFrom, validTo) requires validFrom < validTo`);
    }
  }
  return normalized;
}

/** Earliest source time a caller may claim for observedAt, declaredAt or validFrom. */
export const EARLIEST_CALLER_TIME = "2000-01-01T00:00:00.000Z";
/** How far past the server clock a caller-supplied time may be (clock skew between operator and server). */
export const MAX_CALLER_SKEW_MS = 5 * 60_000;

/**
 * Builds the EV-5 time envelope of a write. The server assigns `recordedAt` (the retention anchor) from its own
 * clock; a caller may only state when the data was observed, declared and valid from, within sane bounds. A caller's
 * `recordedAt`, `publishedAt` and `validTo` are ignored, so no client can shorten a retention horizon or close an
 * interval. The same function is used by the HTTP layer, the job runner and the correction path.
 */
export type CallerTimeEnvelope = Partial<Record<keyof Ev5TimeEnvelope, string | null>>;

export function resolveCallerTimeEnvelope(
  caller: CallerTimeEnvelope | null | undefined,
  nowIso: string,
): Ev5TimeEnvelope {
  const now = canonicalUtcIso(nowIso);
  const nowMs = Date.parse(now);
  const bounded = (field: "observedAt" | "declaredAt" | "validFrom"): string | null => {
    const raw = caller?.[field];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") throw new TimeEnvelopeError("invalid-timestamp", `${field} must be an ISO-8601 timestamp`);
    const iso = canonicalUtcIso(raw);
    const ms = Date.parse(iso);
    if (ms < Date.parse(EARLIEST_CALLER_TIME)) {
      throw new TimeEnvelopeError("invalid-timestamp", `${field} is before ${EARLIEST_CALLER_TIME}`);
    }
    if (ms > nowMs + MAX_CALLER_SKEW_MS) {
      throw new TimeEnvelopeError("invalid-timestamp", `${field} is in the future`);
    }
    return iso;
  };
  return validateEv5TimeEnvelope({
    recordedAt: now,
    observedAt: bounded("observedAt"),
    declaredAt: bounded("declaredAt"),
    publishedAt: null,
    validFrom: bounded("validFrom") ?? now,
    validTo: null,
  });
}

/** Adds `retentionDays` to an ISO-8601 UTC timestamp deterministically. */
export function computeRetentionUntil(storedAtIso: string, retentionDays: number): string {
  const base = Date.parse(storedAtIso);
  if (Number.isNaN(base) || !Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new RetentionViolationError("policy-invalid", "Retention horizon requires a valid timestamp and positive retentionDays");
  }
  return new Date(base + retentionDays * 86_400_000).toISOString();
}

/**
 * Resolves confidentiality class and retention horizon for a dataset against the active policy.
 * Unlisted datasets fall back to `default_classification` (`restricted`) and `default_retention_days`.
 */
export function resolveDatasetRetention(
  policy: RetentionPolicy | null | undefined,
  dataset: string,
  statedClassification?: string | null,
): { classification: Classification; retentionDays: number; legalHoldPermitted: boolean; policyPin: string } {
  if (!policy) {
    throw new RetentionViolationError("policy-missing", "A pinned classification and retention policy must be loaded before accepting data");
  }
  const rule = policy.datasets.find((d) => d.dataset === dataset);
  const baseClass = rule ? rule.classification : policy.default_classification;
  const resolvedClass = statedClassification !== undefined ? classify(statedClassification) : baseClass;
  // Never downgrade a dataset below its policy classification
  const stricterClass =
    CLASSIFICATIONS.indexOf(resolvedClass) >= CLASSIFICATIONS.indexOf(baseClass) ? resolvedClass : baseClass;
  return {
    classification: stricterClass,
    retentionDays: rule ? rule.retention_days : policy.default_retention_days,
    legalHoldPermitted: rule ? rule.legal_hold_permitted : true,
    policyPin: `${policy.id}@${policy.version}`,
  };
}
