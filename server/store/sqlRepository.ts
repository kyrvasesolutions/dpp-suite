/**
 * Transactional relational central-record repository implementing `RecordRepository` (`src/model/recordRepository.ts`).
 *
 * Uses synchronous `BEGIN IMMEDIATE` transactions (`DbAdapter.transaction`) with optimistic
 * `expectedVersion` checks so concurrent operators cannot lose or duplicate assertions (C6-03).
 * Preserves all six distinct EV-5 time fields, half-open validity intervals `[valid_from, valid_to)`,
 * security-domain scoping, and pinned classification/retention policy enforcement (C6-02, LEAN-DEF-05).
 */
import { createHash } from "node:crypto";
import { canonicalSha256Sync } from "./streamDigest";
import { canonical } from "../../src/model/canonical";
import {
  baseAssertion,
  byRole,
  checkCorrectedValue,
  valueStatus,
  type Assertion,
  type ProductRecord,
  type SourceFile,
} from "../../src/model/ingress";
import {
  CorrectionError,
  correctionSourceName,
  REASON_MAX,
  type CorrectionRequest,
} from "../../src/model/correction";
import {
  computeRetentionUntil,
  ConcurrencyConflictError,
  DEFAULT_SECURITY_DOMAIN,
  resolveDatasetRetention,
  RetentionViolationError,
  validateEv5TimeEnvelope,
  type Ev5TimeEnvelope,
} from "../../src/model/pContracts";
import type { Classification } from "../../src/model/classification";
import type { ProfilePack } from "../../src/model/profile";
import {
  checkAppend,
  OPERATOR,
  REASON_FIRST,
  REASON_REIMPORT,
  RepositoryError,
  type RecordRepository,
  type Snapshot,
} from "../../src/model/recordRepository";
import type { DbAdapter } from "../db/adapter";
import { PolicyStore } from "./policyStore";

export interface SnapshotMetadata {
  securityDomain: string;
  model: string;
  batch: string;
  version: number;
  classification: Classification;
  retentionPolicyPin: string;
  retentionUntil: string;
  timeEnvelope: Ev5TimeEnvelope;
}

export interface AtomicWriteOptions {
  /** Expected latest version prior to write (`0` for first import). Throws `ConcurrencyConflictError` on mismatch. */
  expectedVersion?: number | null;
  reason?: string;
  actor?: typeof OPERATOR;
  dataset?: string;
  statedClassification?: string | null;
  timeEnvelope?: Ev5TimeEnvelope;
}

interface SnapshotRow {
  security_domain: string;
  model: string;
  batch: string;
  version: number;
  supersedes_version: number | null;
  supersedes_digest: string | null;
  record_digest: string;
  snapshot_digest: string;
  actor: string;
  reason: string;
  origin: string | null;
  classification: Classification;
  retention_policy_pin: string;
  retention_until: string;
  recorded_at: string;
  observed_at: string | null;
  declared_at: string | null;
  published_at: string | null;
  valid_from: string;
  valid_to: string | null;
  payload_json: string;
}

export function sha256Sync(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export function recordDigestSync(record: ProductRecord): string {
  const { digest: _digest, ...state } = record;
  return canonicalSha256Sync(state); // streamed: the canonical text of a large record is never built
}

export function snapshotDigestSync(snapshot: Omit<Snapshot, "digest"> | Snapshot): string {
  const { digest: _digest, origin: _origin, ...rest } = snapshot as Snapshot;
  return canonicalSha256Sync(rest);
}

export function verifySnapshotSync(snapshot: Snapshot): void {
  const name = `${snapshot.model} / ${snapshot.batch} v${snapshot.version}`;
  if (recordDigestSync(snapshot.record) !== snapshot.record.digest) {
    throw new RepositoryError(`${name}: the record does not match its digest`);
  }
  if (snapshotDigestSync(snapshot) !== snapshot.digest) {
    throw new RepositoryError(`${name}: the snapshot does not match its digest`);
  }
  if (snapshot.record.model !== snapshot.model || snapshot.record.batch !== snapshot.batch) {
    throw new RepositoryError(`${name}: the record is another model or batch`);
  }
}

export function defaultTimeEnvelope(nowIso: string = new Date().toISOString()): Ev5TimeEnvelope {
  return {
    recordedAt: nowIso,
    observedAt: null,
    declaredAt: null,
    publishedAt: null,
    validFrom: nowIso,
    validTo: null,
  };
}

export class SqlRecordRepository implements RecordRepository {
  private readonly policies: PolicyStore;

  constructor(
    private readonly db: DbAdapter,
    public readonly securityDomain: string = DEFAULT_SECURITY_DOMAIN,
  ) {
    if (!securityDomain.trim()) {
      throw new RetentionViolationError("domain-missing", "securityDomain is required for relational repository");
    }
    this.policies = new PolicyStore(db, securityDomain);
  }

  /** Synchronous version history for `(securityDomain, model, batch)`, oldest first. */
  historySync(model: string, batch: string): Snapshot[] {
    const rows = this.db.query<{ payload_json: string }>(
      `SELECT payload_json FROM snapshots
       WHERE security_domain = ? AND model = ? AND batch = ?
       ORDER BY version ASC`,
      this.securityDomain,
      model,
      batch,
    );
    return rows.map((r) => JSON.parse(r.payload_json) as Snapshot);
  }

  latestSync(model: string, batch: string): Snapshot | undefined {
    const row = this.db.get<{ payload_json: string }>(
      `SELECT payload_json FROM snapshots
       WHERE security_domain = ? AND model = ? AND batch = ?
       ORDER BY version DESC LIMIT 1`,
      this.securityDomain,
      model,
      batch,
    );
    return row ? (JSON.parse(row.payload_json) as Snapshot) : undefined;
  }

  getSync(model: string, batch: string, version: number): Snapshot | undefined {
    const row = this.db.get<{ payload_json: string }>(
      `SELECT payload_json FROM snapshots
       WHERE security_domain = ? AND model = ? AND batch = ? AND version = ?`,
      this.securityDomain,
      model,
      batch,
      version,
    );
    return row ? (JSON.parse(row.payload_json) as Snapshot) : undefined;
  }

  getSnapshotMeta(model: string, batch: string, version: number): SnapshotMetadata | undefined {
    const row = this.db.get<SnapshotRow>(
      `SELECT * FROM snapshots
       WHERE security_domain = ? AND model = ? AND batch = ? AND version = ?`,
      this.securityDomain,
      model,
      batch,
      version,
    );
    if (!row) return undefined;
    return {
      securityDomain: row.security_domain,
      model: row.model,
      batch: row.batch,
      version: Number(row.version),
      classification: row.classification,
      retentionPolicyPin: row.retention_policy_pin,
      retentionUntil: row.retention_until,
      timeEnvelope: {
        recordedAt: row.recorded_at,
        observedAt: row.observed_at,
        declaredAt: row.declared_at,
        publishedAt: row.published_at,
        validFrom: row.valid_from,
        validTo: row.valid_to,
      },
    };
  }

  recordsSync(): Array<{ model: string; batch: string }> {
    const rows = this.db.query<{ model: string; batch: string }>(
      `SELECT DISTINCT model, batch FROM snapshots
       WHERE security_domain = ?
       ORDER BY model ASC, batch ASC`,
      this.securityDomain,
    );
    return rows.map((r) => ({ model: r.model, batch: r.batch }));
  }

  /**
   * Appends a pre-built verified snapshot atomically under the active retention policy.
   * Closes the previous version's half-open `[valid_from, valid_to)` interval when superseding.
   */
  putSync(
    snapshot: Snapshot,
    options: {
      dataset?: string;
      statedClassification?: string | null;
      timeEnvelope?: Ev5TimeEnvelope;
    } = {},
  ): SnapshotMetadata {
    verifySnapshotSync(snapshot);
    const active = this.policies.requireActive();
    const resolved = resolveDatasetRetention(
      active.policy,
      options.dataset ?? "central-record-snapshot",
      options.statedClassification,
    );
    const envelope = validateEv5TimeEnvelope(options.timeEnvelope ?? defaultTimeEnvelope());
    const retentionUntil = computeRetentionUntil(envelope.recordedAt, resolved.retentionDays);

    return this.db.transaction(() => {
      const hist = this.historySync(snapshot.model, snapshot.batch);
      checkAppend(hist, snapshot);

      const prev = hist[hist.length - 1];
      if (prev) {
        // Ensure half-open interval monotonicity: valid_to > prev.valid_from
        const prevRow = this.db.get<{ valid_from: string }>(
          "SELECT valid_from FROM snapshots WHERE security_domain = ? AND model = ? AND batch = ? AND version = ?",
          this.securityDomain,
          snapshot.model,
          snapshot.batch,
          prev.version,
        );
        let closingAt = envelope.validFrom;
        if (prevRow && Date.parse(closingAt) <= Date.parse(prevRow.valid_from)) {
          closingAt = new Date(Date.parse(prevRow.valid_from) + 1).toISOString();
          envelope.validFrom = closingAt;
        }
        this.db.run(
          `UPDATE snapshots SET valid_to = ?
           WHERE security_domain = ? AND model = ? AND batch = ? AND version = ? AND valid_to IS NULL`,
          closingAt,
          this.securityDomain,
          snapshot.model,
          snapshot.batch,
          prev.version,
        );
      }

      this.db.run(
        `INSERT INTO snapshots (
          security_domain, model, batch, version, supersedes_version, supersedes_digest,
          record_digest, snapshot_digest, actor, reason, origin,
          classification, retention_policy_pin, retention_until,
          recorded_at, observed_at, declared_at, published_at, valid_from, valid_to,
          payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        this.securityDomain,
        snapshot.model,
        snapshot.batch,
        snapshot.version,
        snapshot.supersedes?.version ?? null,
        snapshot.supersedes?.digest ?? null,
        snapshot.record.digest,
        snapshot.digest,
        snapshot.actor,
        snapshot.reason,
        snapshot.origin ?? null,
        resolved.classification,
        resolved.policyPin,
        retentionUntil,
        envelope.recordedAt,
        envelope.observedAt,
        envelope.declaredAt,
        envelope.publishedAt,
        envelope.validFrom,
        envelope.validTo,
        JSON.stringify(snapshot),
      );

      return {
        securityDomain: this.securityDomain,
        model: snapshot.model,
        batch: snapshot.batch,
        version: snapshot.version,
        classification: resolved.classification,
        retentionPolicyPin: resolved.policyPin,
        retentionUntil,
        timeEnvelope: envelope,
      };
    });
  }

  /**
   * Atomically stores `record` as the next snapshot version inside a single `BEGIN IMMEDIATE` transaction.
   * Checks `expectedVersion` (if provided), applies idempotency when latest digest matches, and never loses
   * or duplicates concurrent updates (C6-03).
   */
  storeRecordAtomic(
    record: ProductRecord,
    options: AtomicWriteOptions = {},
  ): { stored: boolean; snapshot: Snapshot; metadata: SnapshotMetadata } {
    return this.db.transaction(() => {
      const latest = this.latestSync(record.model, record.batch);
      const currentVersion = latest?.version ?? 0;
      if (
        options.expectedVersion !== undefined &&
        options.expectedVersion !== null &&
        options.expectedVersion !== currentVersion
      ) {
        throw new ConcurrencyConflictError(
          "version-conflict",
          `Record ${record.model} / ${record.batch}: expected version ${options.expectedVersion} but latest is ${currentVersion}`,
        );
      }

      if (latest && latest.record.digest === record.digest) {
        const meta = this.getSnapshotMeta(record.model, record.batch, latest.version)!;
        return { stored: false, snapshot: latest, metadata: meta };
      }

      const body: Omit<Snapshot, "digest"> = {
        model: record.model,
        batch: record.batch,
        version: currentVersion + 1,
        ...(latest ? { supersedes: { version: latest.version, digest: latest.digest } } : {}),
        actor: options.actor ?? OPERATOR,
        reason: options.reason ?? (latest ? REASON_REIMPORT : REASON_FIRST),
        sources: record.sources.map((s) => ({ role: s.role, name: s.name, sha256: s.sha256 })),
        record: structuredClone(record),
      };
      const snapshot: Snapshot = { ...body, digest: snapshotDigestSync(body) };
      const metadata = this.putSync(snapshot, {
        dataset: options.dataset ?? "central-record-snapshot",
        statedClassification: options.statedClassification,
        timeEnvelope: options.timeEnvelope,
      });
      return { stored: true, snapshot, metadata };
    });
  }

  /**
   * Transactional operator correction mirroring `correctRecord()` (`src/model/correction.ts`) inside
   * a single `BEGIN IMMEDIATE` transaction with optimistic `expectedVersion` checking (C6-03).
   */
  correctRecordAtomic(
    pack: ProfilePack,
    request: CorrectionRequest,
    options: { actor?: string; expectedVersion?: number | null; timeEnvelope?: Ev5TimeEnvelope } = {},
  ): { snapshot: Snapshot; metadata: SnapshotMetadata } {
    const actor = options.actor ?? OPERATOR;
    if (actor !== OPERATOR) {
      throw new CorrectionError(`Only the operator role (${OPERATOR}) may correct a record; ${actor} may not.`);
    }
    const reason = request.reason.trim();
    if (!reason) throw new CorrectionError("A correction needs a reason.");
    if (reason.length > REASON_MAX || /[\u0000-\u001f\u007f]/.test(reason)) {
      throw new CorrectionError(`The reason must be one line of at most ${REASON_MAX} characters.`);
    }

    return this.db.transaction(() => {
      const latest = this.latestSync(request.model, request.batch);
      if (!latest) {
        throw new CorrectionError(`There is no record ${request.model}, batch ${request.batch} to correct.`);
      }
      if (
        options.expectedVersion !== undefined &&
        options.expectedVersion !== null &&
        options.expectedVersion !== latest.version
      ) {
        throw new ConcurrencyConflictError(
          "version-conflict",
          `Record ${request.model} / ${request.batch}: expected version ${options.expectedVersion} but latest is ${latest.version}`,
        );
      }

      const record: ProductRecord = structuredClone(latest.record);
      const value = record.values.find(
        (v) => v.property === request.property && v.member === request.member && v.qualifier === request.qualifier,
      );
      if (!value) {
        throw new CorrectionError("That value is not in the record. A correction changes a value the record already has.");
      }
      if ([byRole(pack, "model"), byRole(pack, "batch"), byRole(pack, "evidence")].includes(value.property)) {
        throw new CorrectionError("The identifiers of the record and its evidence references cannot be corrected by hand.");
      }
      const base = baseAssertion(value);
      if (!base) throw new CorrectionError("That value has nothing to correct.");
      const checked = checkCorrectedValue(pack, base, request.raw);
      if (!checked.ok) throw new CorrectionError(checked.reason);

      const standing = value.assertions[0];
      if (
        value.status !== "challenged" &&
        (standing.raw === request.raw || (typeof standing.value === "number" && standing.value === checked.value))
      ) {
        throw new CorrectionError("The corrected value is the same as the current value, so there is nothing to correct.");
      }

      const version = latest.version + 1;
      const name = correctionSourceName(version);
      const content = {
        actor,
        batch: request.batch,
        member: request.member ?? null,
        model: request.model,
        property: request.property,
        qualifier: request.qualifier ?? null,
        raw: request.raw,
        reason,
        version,
      };
      const sha256 = sha256Sync(canonical(content));
      const assertion: Assertion = {
        property: value.property,
        ...(value.member ? { member: value.member } : {}),
        ...(value.qualifier ? { qualifier: value.qualifier } : {}),
        raw: request.raw,
        value: checked.value,
        unit: base.unit,
        ...(base.details ? { details: { ...base.details } } : {}),
        source: { file: name, role: "correction", sha256, location: `${name}, value` },
        flags: ["corrected"],
        correction: { version, actor, reason },
      };
      value.assertions = [
        assertion,
        ...value.assertions.map((a) =>
          a.flags.includes("source-changed") ? { ...a, flags: a.flags.filter((f) => f !== "source-changed") } : a,
        ),
      ];
      value.status = valueStatus(value.assertions);
      const source: SourceFile = { name, role: "correction", mediaType: "application/json", sha256, size: 0 };
      record.sources = [...record.sources, source];
      record.digest = recordDigestSync(record);

      const { snapshot, metadata } = this.storeRecordAtomic(record, {
        expectedVersion: latest.version,
        reason,
        actor,
        timeEnvelope: options.timeEnvelope,
      });
      return { snapshot, metadata };
    });
  }

  // RecordRepository async interface methods (S2-05: identical contract to IdbRepository/MemoryRepository)

  async put(snapshot: Snapshot): Promise<void> {
    this.putSync(snapshot);
  }

  async get(model: string, batch: string, version: number): Promise<Snapshot | undefined> {
    return this.getSync(model, batch, version);
  }

  async history(model: string, batch: string): Promise<Snapshot[]> {
    return this.historySync(model, batch);
  }

  async latest(model: string, batch: string): Promise<Snapshot | undefined> {
    return this.latestSync(model, batch);
  }

  async records(): Promise<Array<{ model: string; batch: string }>> {
    return this.recordsSync();
  }
}
