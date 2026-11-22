/**
 * Operator correction of one value of the selected record, and the field-level difference between two versions of a
 * record (Cycle 5: FUNC-005, FUNC-076 slices; criterion C5-01; G03, G09).
 *
 * A correction never edits anything. It makes the next version of the same product model and batch, in which the corrected
 * value carries a new first assertion: the operator's text, from the source `Operator correction vN`, flagged
 * `corrected`, with the actor and the reason. The earlier assertions stay in the value, so the earlier text is still
 * readable; the value's status is `corrected`, never silent. Readiness counts the value as present, and lineage points to the
 * correction. A correction cannot touch another record (it names one model and batch and changes only that record's latest
 * version), the pack, or a code list (a coded value must already be in its list), and it needs a reason. The identifiers of
 * the record and its evidence references are not corrected by hand, because they decide what the record is and what it rests on.
 */
import { canonical } from "./canonical";
import { baseAssertion, byRole, checkCorrectedValue, sameAssertion, valueStatus, type Assertion, type ProductRecord, type RecordValue, type SourceFile } from "./ingress";
import { sha256Hex, type ProfilePack } from "./profile";
import { OPERATOR, REASON_FIRST, REASON_REIMPORT, recordDigest, storeRecord, type RecordRepository, type Snapshot } from "./recordRepository";

export class CorrectionError extends Error {
  override name = "CorrectionError";
}

export interface CorrectionRequest {
  /** The record being corrected: one model and batch. */
  model: string;
  batch: string;
  /** The value to correct, by the keys the record uses. */
  property: string;
  member?: string;
  qualifier?: string;
  /** The corrected text, as the operator states it. */
  raw: string;
  reason: string;
}

export const REASON_MAX = 500;

/** The name a correction goes by as a source: the version of the record it makes. */
export const correctionSourceName = (version: number) => `Operator correction v${version}`;

const sameKey = (v: RecordValue, r: { property: string; member?: string; qualifier?: string }) => v.property === r.property && v.member === r.member && v.qualifier === r.qualifier;

/**
 * Corrects one value of the latest version of the record and stores the result as the next version.
 * Throws CorrectionError, and changes nothing, unless the actor is the operator, the reason is given, the record and the
 * value exist, the value is not an identifier or evidence reference, and the corrected text passes the checks ingress applies.
 */
export async function correctRecord(pack: ProfilePack, repo: RecordRepository, request: CorrectionRequest, actor: string = OPERATOR): Promise<Snapshot> {
  if (actor !== OPERATOR) throw new CorrectionError(`Only the operator role (${OPERATOR}) may correct a record; ${actor} may not.`);
  const reason = request.reason.trim();
  if (!reason) throw new CorrectionError("A correction needs a reason.");
  if (reason.length > REASON_MAX || /[\u0000-\u001f\u007f]/.test(reason)) throw new CorrectionError(`The reason must be one line of at most ${REASON_MAX} characters.`);

  const latest = await repo.latest(request.model, request.batch);
  if (!latest) throw new CorrectionError(`There is no record ${request.model}, batch ${request.batch} to correct.`);
  const record: ProductRecord = structuredClone(latest.record);
  const value = record.values.find((v) => sameKey(v, request));
  if (!value) throw new CorrectionError("That value is not in the record. A correction changes a value the record already has.");
  if ([byRole(pack, "model"), byRole(pack, "batch"), byRole(pack, "evidence")].includes(value.property)) {
    throw new CorrectionError("The identifiers of the record and its evidence references cannot be corrected by hand.");
  }
  const base = baseAssertion(value);
  if (!base) throw new CorrectionError("That value has nothing to correct.");
  const checked = checkCorrectedValue(pack, base, request.raw);
  if (!checked.ok) throw new CorrectionError(checked.reason);
  // Stating the value it already has is no correction. (A challenged value may be settled on either of its two values.)
  const standing = value.assertions[0];
  if (value.status !== "challenged" && (standing.raw === request.raw || (typeof standing.value === "number" && standing.value === checked.value))) {
    throw new CorrectionError("The corrected value is the same as the current value, so there is nothing to correct.");
  }

  const version = latest.version + 1;
  const name = correctionSourceName(version);
  const content = { actor, batch: request.batch, member: request.member ?? null, model: request.model, property: request.property, qualifier: request.qualifier ?? null, raw: request.raw, reason, version };
  const sha256 = await sha256Hex(canonical(content));
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
  // a correction settles a value whose source had changed after an earlier correction: the flag that held it is no longer needed
  value.assertions = [assertion, ...value.assertions.map((a) => (a.flags.includes("source-changed") ? { ...a, flags: a.flags.filter((f) => f !== "source-changed") } : a))];
  value.status = valueStatus(value.assertions);
  const source: SourceFile = { name, role: "correction", mediaType: "application/json", sha256, size: 0 };
  record.sources = [...record.sources, source];
  record.digest = await recordDigest(record);
  const { snapshot } = await storeRecord(repo, record, reason);
  return snapshot;
}

// ---------- The difference between two versions ----------

export interface FieldChange {
  field: "value" | "unit" | "status" | "flags" | "sources" | "correction";
  before: string | null;
  after: string | null;
}

export interface ValueDiff {
  property: string;
  member?: string;
  qualifier?: string;
  change: "added" | "removed" | "changed";
  fields: FieldChange[];
}

export interface VersionDiff {
  from: number;
  to: number;
  fromDigest: string;
  toDigest: string;
  changes: ValueDiff[];
}

const keyOf = (v: { property: string; member?: string; qualifier?: string }) => `${v.property}|${v.member ?? ""}|${v.qualifier ?? ""}`;

/** What a value says now, field by field, as text. After a correction the standing value is the correction's. */
const summary = (v: RecordValue): Record<FieldChange["field"], string | null> => {
  const standing = v.status === "corrected" ? v.assertions.slice(0, 1) : v.assertions;
  const correction = v.assertions.find((a) => a.correction)?.correction;
  return {
    value: standing.map((a) => a.raw).join(" / "),
    unit: [...new Set(standing.map((a) => a.unit ?? ""))].join(" / ") || null,
    status: v.status,
    flags: [...new Set(v.assertions.flatMap((a) => a.flags))].sort().join(", "),
    sources: v.assertions.map((a) => a.source.location).join("; "),
    correction: correction ? `version ${correction.version}, ${correction.actor}: ${correction.reason}` : null,
  };
};

const FIELDS = ["value", "unit", "status", "flags", "sources", "correction"] as const;

/** Every value that differs between two versions of a record, field by field, in a fixed order. Deterministic. */
export function diffSnapshots(a: Snapshot, b: Snapshot): VersionDiff {
  const before = new Map(a.record.values.map((v) => [keyOf(v), v]));
  const after = new Map(b.record.values.map((v) => [keyOf(v), v]));
  const changes: ValueDiff[] = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const x = before.get(key);
    const y = after.get(key);
    const id = (y ?? x)!;
    const at = { property: id.property, ...(id.member ? { member: id.member } : {}), ...(id.qualifier ? { qualifier: id.qualifier } : {}) };
    if (!x) changes.push({ ...at, change: "added", fields: FIELDS.map((f) => ({ field: f, before: null, after: summary(y!)[f] })) });
    else if (!y) changes.push({ ...at, change: "removed", fields: FIELDS.map((f) => ({ field: f, before: summary(x)[f], after: null })) });
    else {
      const sx = summary(x);
      const sy = summary(y);
      const fields = FIELDS.filter((f) => sx[f] !== sy[f]).map((f) => ({ field: f, before: sx[f], after: sy[f] }));
      if (fields.length) changes.push({ ...at, change: "changed", fields });
    }
  }
  return { from: a.version, to: b.version, fromDigest: a.digest, toDigest: b.digest, changes };
}

/** The difference between each version and the next, oldest first (exported with the record). */
export const diffHistory = (history: Snapshot[]): VersionDiff[] => history.slice(1).map((s, i) => diffSnapshots(history[i], s));

// ---------- A re-import after a correction ----------

export interface CarryResult {
  record: ProductRecord;
  /** Corrections carried forward unchanged onto the new version. */
  carried: number;
  /** Corrected values whose source now says something else: both are kept and the value is challenged. */
  disputed: number;
}

/**
 * A re-import must never silently undo a correction. For every corrected value of the latest version:
 * - the new source still says what the correction replaced: the correction is carried onto the new version, still flagged, and the
 *   new source values become the earlier values it replaces;
 * - the new source has come to say what the correction says: the source confirms the correction, which stays flagged `corrected`
 *   with lineage to both;
 * - the new source says something else, or no longer has the value: the correction and the source values (for a dropped value,
 *   what it replaced attributed to its earlier file version) are kept with `source-changed`, and the value is challenged so the
 *   routes hold until the operator decides.
 */
export async function carryCorrections(latest: Snapshot | undefined, incoming: ProductRecord): Promise<CarryResult> {
  if (!latest) return { record: incoming, carried: 0, disputed: 0 };
  const record: ProductRecord = structuredClone(incoming);
  const sources = [...record.sources];
  const addSource = (s: SourceFile) => {
    if (!sources.some((x) => x.role === s.role && x.name === s.name && x.sha256 === s.sha256)) sources.push(s);
  };
  let carried = 0;
  let disputed = 0;
  for (const old of latest.record.values.filter((v) => v.status === "corrected" || v.assertions.some((a) => a.source.role === "correction"))) {
    const corrections = old.assertions.filter((a) => a.source.role === "correction");
    const replaced = old.assertions.filter((a) => a.source.role !== "correction").map((a) => ({ ...a, flags: a.flags.filter((f) => f !== "source-changed") }));
    const now = record.values.find((v) => sameKey(v, old));
    const noLongerDisputed = replaced.length > 0 && now && now.assertions.length === replaced.length && now.assertions.every((a, i) => sameAssertion(a, replaced[i]));
    for (const c of corrections) addSource(latest.record.sources.find((s) => s.role === "correction" && s.name === c.source.file)!);
    if (!now) {
      // The new source dropped the value. That is a change of the source: the correction stays, what it replaced stays attributed to the
      // file version it came from, and the value is challenged so the routes hold until the operator decides.
      for (const a of replaced) addSource(latest.record.sources.find((s) => s.role === a.source.role && s.name === a.source.file && s.sha256 === a.source.sha256)!);
      const assertions = [...structuredClone(corrections), ...replaced.map((a) => ({ ...structuredClone(a), flags: [...a.flags.filter((f) => f !== "challenged"), "source-changed" as const] }))];
      record.values.push({ property: old.property, ...(old.member ? { member: old.member } : {}), ...(old.qualifier ? { qualifier: old.qualifier } : {}), status: valueStatus(assertions), assertions });
      disputed++;
      continue;
    }
    const details = baseAssertion(now)?.details;
    const kept = corrections.map((c) => ({ ...structuredClone(c), ...(details ? { details: { ...details } } : {}) }));
    // a source that has come to say what the correction says confirms it: the value is corrected and agreed, with lineage to both
    const confirmed = corrections.length > 0 && now.assertions.every((a) => sameAssertion(a, corrections[0]));
    if (confirmed) {
      now.assertions = [...kept, ...now.assertions];
      now.status = valueStatus(now.assertions);
      carried++;
      continue;
    }
    // an earlier dispute stays until the operator settles it, even if the source goes back to what it said then
    const wasDisputed = old.assertions.some((a) => a.flags.includes("source-changed"));
    if (noLongerDisputed && !wasDisputed) {
      now.assertions = [...kept, ...now.assertions];
      now.status = valueStatus(now.assertions);
      carried++;
      continue;
    }
    // the source changed: both stay, the value is challenged
    now.assertions = [...kept, ...now.assertions.map((a) => ({ ...a, flags: [...a.flags.filter((f) => f !== "challenged"), "source-changed" as const] }))];
    now.status = valueStatus(now.assertions);
    disputed++;
  }
  record.sources = sources;
  record.values.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  record.digest = await recordDigest(record);
  return { record, carried, disputed };
}

/**
 * Stores an imported record as the next version, carrying corrections forward (see carryCorrections), with an honest label:
 * "First import", "Re-import", or a re-import that says what it did to the corrections. Identical files store nothing.
 */
export async function storeImport(repo: RecordRepository, incoming: ProductRecord, label?: string): Promise<{ stored: boolean; snapshot: Snapshot; carried: number; disputed: number }> {
  const latest = await repo.latest(incoming.model, incoming.batch);
  const { record, carried, disputed } = await carryCorrections(latest, incoming);
  const reason =
    label ?? (!latest ? REASON_FIRST : disputed ? `${REASON_REIMPORT}: the source changed after a correction, so the value is challenged` : carried ? `${REASON_REIMPORT}: corrections carried forward` : REASON_REIMPORT);
  const result = await storeRecord(repo, record, reason);
  return { ...result, carried, disputed };
}
