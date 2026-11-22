/**
 * The central record: append-only, versioned snapshots of a product record (Cycle 4: FUNC-063 and FUNC-022
 * slices; criterion C4-06).
 *
 * A snapshot freezes one version of the record for one product model and batch, with the source files it
 * came from. Importing a corrected file for the same model and batch makes version n+1, linked to version n by
 * its digest. Nothing is ever overwritten or deleted: writing a version that exists throws, and so does writing
 * a version that does not follow the latest one. A record identical to the latest version is not stored again.
 * Everything stays in this browser (IndexedDB) or in memory; nothing is sent anywhere.
 */
import { idbSnapshotAdd, idbSnapshotKeys, idbSnapshotRange } from "../db/idb";
import { canonical } from "./canonical";
import type { ProductRecord, SourceFile } from "./ingress";
import { sha256Hex } from "./profile";

/** The only role that may write the central record or export it in the local N build (trusted local context). */
export const OPERATOR = "ACT-01";

export interface SnapshotSource {
  role: SourceFile["role"];
  name: string;
  sha256: string;
}

export interface Snapshot {
  model: string;
  batch: string;
  /** 1 for the first import of this model and batch, then one more each time a changed record is stored. */
  version: number;
  /** The version this one replaces, with its digest. Absent only for version 1. */
  supersedes?: { version: number; digest: string };
  /** sha256 of the canonical snapshot without this field. */
  digest: string;
  actor: typeof OPERATOR;
  reason: string;
  /**
   * Where this copy of the version came from, when it was not made here: set when it is restored from a central-record file.
   * It is not part of the digest, because the digest names the content; it says how this browser came to hold it.
   */
  origin?: string;
  sources: SnapshotSource[];
  record: ProductRecord;
}

/** The honest labels of a version: the first import, a later import of changed files, a correction (the operator's own reason), or a file. */
export const REASON_FIRST = "First import";
export const REASON_REIMPORT = "Re-import";

/** The origin recorded for a version restored from a central-record file. */
export const ORIGIN_IMPORTED = "Imported from a central-record file";

export class RepositoryError extends Error {
  override name = "RepositoryError";
}

export interface RecordRepository {
  /** Appends a snapshot. Throws if the version exists, does not follow the latest, or does not link to it. */
  put(snapshot: Snapshot): Promise<void>;
  get(model: string, batch: string, version: number): Promise<Snapshot | undefined>;
  /** Every version, oldest first. */
  history(model: string, batch: string): Promise<Snapshot[]>;
  latest(model: string, batch: string): Promise<Snapshot | undefined>;
  /** Every model and batch that has a snapshot, in sorted order. */
  records(): Promise<Array<{ model: string; batch: string }>>;
}

/** What the digest of a snapshot covers: everything but the digest itself and the origin of this copy. */
export const snapshotDigest = (snapshot: Omit<Snapshot, "digest"> | Snapshot): Promise<string> => {
  const { digest: _digest, origin: _origin, ...rest } = snapshot as Snapshot;
  return sha256Hex(canonical(rest));
};

/** The digest the record itself must have: it covers the model, batch, sources and values (see buildRecords). */
export const recordDigest = (record: ProductRecord): Promise<string> => {
  const { digest: _digest, ...state } = record;
  return sha256Hex(canonical(state));
};

/** Throws a RepositoryError unless the snapshot's own digests are right. */
export async function verifySnapshot(snapshot: Snapshot): Promise<void> {
  const name = `${snapshot.model} / ${snapshot.batch} v${snapshot.version}`;
  if ((await recordDigest(snapshot.record)) !== snapshot.record.digest) throw new RepositoryError(`${name}: the record does not match its digest`);
  if ((await snapshotDigest(snapshot)) !== snapshot.digest) throw new RepositoryError(`${name}: the snapshot does not match its digest`);
  if (snapshot.record.model !== snapshot.model || snapshot.record.batch !== snapshot.batch) throw new RepositoryError(`${name}: the record is another model or batch`);
}

/** Throws unless `next` is exactly the version that may follow `history` (no gap, no rewrite, linked by digest). */
export function checkAppend(history: Snapshot[], next: Snapshot): void {
  const name = `${next.model} / ${next.batch} v${next.version}`;
  if (history.some((s) => s.version === next.version)) throw new RepositoryError(`${name} already exists; snapshots are append-only`);
  const last = history[history.length - 1];
  if (!last) {
    if (next.version !== 1 || next.supersedes) throw new RepositoryError(`${name}: the first snapshot is version 1 and replaces nothing`);
    return;
  }
  if (next.version !== last.version + 1) throw new RepositoryError(`${name} does not follow version ${last.version}`);
  if (next.supersedes?.version !== last.version || next.supersedes.digest !== last.digest) throw new RepositoryError(`${name} must link to version ${last.version} by its digest`);
}

/** The place snapshots are kept. `add` must fail if the key exists, so a version can never be overwritten. */
export interface SnapshotStore {
  add(model: string, batch: string, version: number, snapshot: Snapshot): Promise<void>;
  range(model: string, batch: string): Promise<Snapshot[]>;
  keys(): Promise<Array<{ model: string; batch: string }>>;
}

const clone = <T>(x: T): T => structuredClone(x);

/** The repository on top of a store: the append rules live here, so every store obeys them. */
export class StoreRepository implements RecordRepository {
  constructor(protected readonly store: SnapshotStore) {}

  async put(snapshot: Snapshot): Promise<void> {
    await verifySnapshot(snapshot);
    checkAppend(await this.history(snapshot.model, snapshot.batch), snapshot);
    await this.store.add(snapshot.model, snapshot.batch, snapshot.version, clone(snapshot));
  }

  async history(model: string, batch: string): Promise<Snapshot[]> {
    return (await this.store.range(model, batch)).map(clone).sort((a, b) => a.version - b.version);
  }

  async get(model: string, batch: string, version: number) {
    return (await this.history(model, batch)).find((s) => s.version === version);
  }

  async latest(model: string, batch: string) {
    const all = await this.history(model, batch);
    return all[all.length - 1];
  }

  async records() {
    return [...(await this.store.keys())].sort((a, b) => (a.model + "\0" + a.batch < b.model + "\0" + b.batch ? -1 : 1));
  }
}

/** Snapshots held in memory only, for tests and as the target of an import. */
export class MemoryRepository extends StoreRepository {
  constructor() {
    const rows = new Map<string, Snapshot>();
    const key = (m: string, b: string, v: number) => JSON.stringify([m, b, v]);
    super({
      async add(m, b, v, s) {
        if (rows.has(key(m, b, v))) throw new RepositoryError(`${m} / ${b} v${v} already exists; snapshots are append-only`);
        rows.set(key(m, b, v), s);
      },
      async range(m, b) {
        return [...rows.values()].filter((s) => s.model === m && s.batch === b);
      },
      async keys() {
        return [...new Map([...rows.values()].map((s) => [JSON.stringify([s.model, s.batch]), { model: s.model, batch: s.batch }])).values()];
      },
    });
  }
}

/**
 * Stores `record` as the next version of its model and batch, unless the latest version holds the same record
 * (same digest), in which case nothing is written and the latest version is returned: re-importing is idempotent.
 */
export async function storeRecord(
  repo: RecordRepository,
  record: ProductRecord,
  reason?: string,
): Promise<{ stored: boolean; snapshot: Snapshot }> {
  const latest = await repo.latest(record.model, record.batch);
  if (latest && latest.record.digest === record.digest) return { stored: false, snapshot: latest };
  const body = {
    model: record.model,
    batch: record.batch,
    version: latest ? latest.version + 1 : 1,
    ...(latest ? { supersedes: { version: latest.version, digest: latest.digest } } : {}),
    actor: OPERATOR,
    reason: reason ?? (latest ? REASON_REIMPORT : REASON_FIRST),
    sources: record.sources.map((s) => ({ role: s.role, name: s.name, sha256: s.sha256 })),
    record: structuredClone(record),
  } satisfies Omit<Snapshot, "digest">;
  const snapshot: Snapshot = { ...body, digest: await snapshotDigest(body) };
  await repo.put(snapshot);
  return { stored: true, snapshot };
}

/** Snapshots kept in this browser's IndexedDB (object store `snapshots`, added by the version 2 upgrade). */
export class IdbRepository extends StoreRepository {
  constructor() {
    super({
      add: (m, b, v, s) => idbSnapshotAdd(m, b, v, s).then(() => undefined),
      range: async (m, b) => (await idbSnapshotRange(m, b)) as Snapshot[],
      keys: async () => {
        const seen = new Map<string, { model: string; batch: string }>();
        for (const k of await idbSnapshotKeys()) {
          const [model, batch] = k as [string, string, number];
          seen.set(JSON.stringify([model, batch]), { model, batch });
        }
        return [...seen.values()];
      },
    });
  }
}
