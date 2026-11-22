/**
 * Portable export and import of the central record (Cycle 4: criterion C4-08; UC-37 fixed element).
 *
 * The export is one canonical JSON file with every snapshot of one product model and batch, the digest of the contract
 * pack they were made with, and its own sha256. Importing checks the strict JSON syntax and the schema, then every digest
 * (the file's, each record's, each snapshot's, the links between versions and the pack's), and re-checks what the pinned
 * contract can re-check: each value's status and each assertion's flags are derived again, codes are looked up in the pinned
 * code lists, and numbers, ranges and units are checked as at ingress. A file that is inconsistent, or only partly changed, is
 * refused and nothing is stored. A file whose content was changed to other valid values and then sealed again consistently
 * (new sha256 values everywhere) cannot be told from a genuine one: that needs signing, which is out of scope (LEAN-DEF-07).
 * A version restored from a file records that origin. Only the operator role (ACT-01) may export or import, in this trusted
 * local context; nothing is sent anywhere.
 */
import { z } from "zod";
import { canonical, canonicalPretty, sha256Bytes, utf8 } from "./canonical";
import { FLAG_TEXT, IMPORT_ROLES, recheckRecord, type Flag } from "./ingress";
import type { ProfilePack } from "./profile";
import { sha256Hex } from "./profile";
import {
  MemoryRepository,
  OPERATOR,
  ORIGIN_IMPORTED,
  RepositoryError,
  checkAppend,
  verifySnapshot,
  type RecordRepository,
  type Snapshot,
} from "./recordRepository";
import { diffHistory } from "./correction";
import { parseStrictJson, toPlain } from "./strictJson";

export class CentralRecordError extends Error {
  override name = "CentralRecordError";
}

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const Role = z.enum(["erp", "lab", "correction"]);
const FLAGS = Object.keys(FLAG_TEXT) as [Flag, ...Flag[]];

const Assertion = z.strictObject({
  property: z.string(),
  member: z.string().optional(),
  qualifier: z.string().optional(),
  raw: z.string(),
  value: z.union([z.string(), z.number(), z.null()]),
  unit: z.string().nullable(),
  details: z.record(z.string(), z.string()).optional(),
  source: z.strictObject({ file: z.string(), role: Role, sha256: Sha, location: z.string(), row: z.number().int().optional() }),
  flags: z.array(z.enum(FLAGS)),
  correction: z.strictObject({ version: z.number().int().min(2), actor: z.string(), reason: z.string() }).optional(),
});
const RecordValue = z.strictObject({
  property: z.string(),
  member: z.string().optional(),
  qualifier: z.string().optional(),
  status: z.enum(["single", "agreeing", "challenged", "corrected"]),
  assertions: z.array(Assertion).min(1),
});
const ProductRecord = z.strictObject({
  model: z.string(),
  batch: z.string(),
  sources: z.array(z.strictObject({ name: z.string(), role: Role, mediaType: z.string(), sha256: Sha, size: z.number().int().min(0) })),
  values: z.array(RecordValue),
  digest: Sha,
});
const SnapshotSchema = z.strictObject({
  model: z.string(),
  batch: z.string(),
  version: z.number().int().min(1),
  supersedes: z.strictObject({ version: z.number().int().min(1), digest: Sha }).optional(),
  digest: Sha,
  actor: z.literal(OPERATOR),
  reason: z.string(),
  // a file may carry no origin or exactly the fixed text; anything else is not trusted and refuses the file
  origin: z.literal(ORIGIN_IMPORTED).optional(),
  sources: z.array(z.strictObject({ role: Role, name: z.string(), sha256: Sha })),
  record: ProductRecord,
});
const ExportSchema = z.strictObject({
  format: z.literal("dpp-central-record"),
  version: z.literal(1),
  model: z.string(),
  batch: z.string(),
  packManifestDigest: Sha,
  snapshots: z.array(SnapshotSchema).min(1),
  /** The field-level difference between each version and the next, derived from the snapshots (G09). A file without it is still read. */
  diffs: z.array(z.unknown()).optional(),
  sha256: Sha,
});

const requireOperator = (role: string, what: string) => {
  if (!(IMPORT_ROLES as readonly string[]).includes(role)) throw new CentralRecordError(`Only the operator role (${OPERATOR}) may ${what} the central record; ${role} may not.`);
};

/** sha256 of the file's content without its own `sha256` field. */
const contentDigest = (doc: Record<string, unknown>): Promise<string> => {
  const { sha256: _own, ...rest } = doc;
  return sha256Hex(canonical(rest));
};

export interface CentralRecordFile {
  fileName: string;
  mediaType: string;
  text: string;
  bytes: Uint8Array;
  /** Digest of the whole file's bytes, as a download would be checked. */
  fileSha256: string;
}

/** Every snapshot of one record, oldest first, as a portable file. Throws unless the role is the operator. */
export async function exportCentralRecord(repo: RecordRepository, pack: ProfilePack, model: string, batch: string, role: string = OPERATOR): Promise<CentralRecordFile> {
  requireOperator(role, "export");
  const snapshots = await repo.history(model, batch);
  if (!snapshots.length) throw new CentralRecordError(`There is no central record for ${model}, batch ${batch}.`);
  const body = { format: "dpp-central-record", version: 1, model, batch, packManifestDigest: pack.manifestDigest, snapshots, diffs: diffHistory(snapshots) };
  const doc = { ...body, sha256: await contentDigest(body) };
  const text = canonicalPretty(doc);
  const bytes = utf8(text);
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return { fileName: `central-record_${safe(model)}_${safe(batch)}.json`, mediaType: "application/json", text, bytes, fileSha256: await sha256Bytes(bytes) };
}

export interface ImportedCentralRecord {
  model: string;
  batch: string;
  packManifestDigest: string;
  snapshots: Snapshot[];
  /** A repository holding exactly these snapshots, ready to read. */
  repository: MemoryRepository;
}

/**
 * Reads a central-record file. Refuses it, with the reason, on bad JSON (a duplicate key included), a schema break, a changed
 * digest anywhere, a broken chain of versions, or a contract pack other than `pack`. Nothing is stored here.
 */
export async function importCentralRecord(bytes: Uint8Array, pack: ProfilePack, role: string = OPERATOR): Promise<ImportedCentralRecord> {
  requireOperator(role, "import");
  let plain: unknown;
  try {
    plain = toPlain(parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (e) {
    throw new CentralRecordError(`The file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = ExportSchema.safeParse(plain);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new CentralRecordError(`The file is not a central-record export: ${i.path.join(".") || "document"} ${i.message}`);
  }
  const doc = parsed.data;
  if ((await contentDigest(doc)) !== doc.sha256) throw new CentralRecordError("The file does not match its own sha256: it was changed.");
  if (doc.packManifestDigest !== pack.manifestDigest) throw new CentralRecordError("The record was made with another contract pack than the one loaded, so it is not imported.");
  const repository = new MemoryRepository();
  const seen: Snapshot[] = [];
  try {
    for (const s of doc.snapshots) {
      if (s.model !== doc.model || s.batch !== doc.batch) throw new RepositoryError(`${s.model} / ${s.batch} v${s.version} is another record than ${doc.model} / ${doc.batch}`);
      await verifySnapshot(s as Snapshot);
      const listed = (x: Array<{ role: string; name: string; sha256: string }>) => canonical(x.map(({ role, name, sha256 }) => ({ role, name, sha256 })));
      if (listed(s.sources) !== listed(s.record.sources)) throw new RepositoryError(`${s.model} / ${s.batch} v${s.version}: the snapshot's sources are not the record's sources`);
      // a correction in a version belongs to that version or an earlier one, and the version it made says why and by whom
      for (const v of s.record.values) {
        for (const a of v.assertions) {
          if (a.correction && a.correction.version > s.version) throw new RepositoryError(`${s.model} / ${s.batch} v${s.version}: it holds a correction from a later version`);
          if (a.correction && a.correction.version === s.version && (a.correction.reason !== s.reason || a.correction.actor !== s.actor)) throw new RepositoryError(`${s.model} / ${s.batch} v${s.version}: the correction's reason or actor is not the version's`);
        }
      }
      const problems = recheckRecord(pack, s.record as Snapshot["record"]);
      if (problems.length) throw new RepositoryError(`${s.model} / ${s.batch} v${s.version} does not pass the contract checks: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""}`);
      checkAppend(seen, s as Snapshot);
      seen.push(s as Snapshot);
      await repository.put(s as Snapshot);
    }
  } catch (e) {
    throw new CentralRecordError(`The file is inconsistent: ${e instanceof Error ? e.message : String(e)}`);
  }
  // The differences are derived data: a file whose differences are not the ones its own versions give has been changed
  if (doc.diffs !== undefined && canonical(doc.diffs) !== canonical(diffHistory(seen))) throw new CentralRecordError("The file is inconsistent: its version differences are not the differences of its versions.");
  return { model: doc.model, batch: doc.batch, packManifestDigest: doc.packManifestDigest, snapshots: seen, repository };
}

/**
 * Adds an imported record to `target`. A version the target already has must be identical (same digest) and is skipped;
 * one that differs is a conflict and nothing more is written. Versions the target lacks are appended in order.
 */
export async function restoreCentralRecord(target: RecordRepository, imported: ImportedCentralRecord): Promise<{ added: number; skipped: number }> {
  const have = await target.history(imported.model, imported.batch);
  let added = 0;
  let skipped = 0;
  for (const s of imported.snapshots) {
    const mine = have.find((h) => h.version === s.version);
    if (mine) {
      if (mine.digest !== s.digest) throw new CentralRecordError(`Version ${s.version} here differs from the imported version ${s.version}; nothing was changed beyond the versions before it.`);
      skipped++;
    } else {
      // whatever the file says, a version restored here records that it came from a file
      await target.put({ ...s, origin: ORIGIN_IMPORTED });
      added++;
    }
  }
  return { added, skipped };
}
