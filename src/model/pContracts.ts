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
    status: z.enum(["frozen", "draft"]),
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
      | "domain-missing",
    message: string,
  ) {
    super(message);
  }
}

export class ConcurrencyConflictError extends Error {
  override name = "ConcurrencyConflictError";
  constructor(
    public readonly code: "version-conflict" | "idempotency-conflict",
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

/** Validates an EV-5 time envelope, enforcing half-open `[validFrom, validTo)` semantics (`validFrom < validTo`). */
export function validateEv5TimeEnvelope(envelope: Ev5TimeEnvelope): Ev5TimeEnvelope {
  const parsed = Ev5TimeEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new TimeEnvelopeError("invalid-timestamp", `Invalid time envelope: ${parsed.error.issues[0]?.message ?? "malformed"}`);
  }
  const start = Date.parse(parsed.data.validFrom);
  if (Number.isNaN(start)) throw new TimeEnvelopeError("invalid-timestamp", "validFrom is not a valid ISO timestamp");
  if (parsed.data.validTo !== null) {
    const end = Date.parse(parsed.data.validTo);
    if (Number.isNaN(end)) throw new TimeEnvelopeError("invalid-timestamp", "validTo is not a valid ISO timestamp");
    if (end <= start) {
      throw new TimeEnvelopeError("invalid-interval", `Half-open interval [validFrom, validTo) requires validFrom < validTo`);
    }
  }
  return parsed.data;
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
