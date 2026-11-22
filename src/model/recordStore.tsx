/**
 * The record state shared between screens (Cycle 3): the Import screen writes it, the Readiness screen reads it.
 * It also holds the verified contract pack, so every screen reads the same profile. Nothing is stored beyond
 * this page session, and nothing leaves the device.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import pack from "virtual:contract-pack";
import type { ImportResult, RecordState } from "./ingress";
import { ExecutionLog, IdbLogStore, MemoryLogStore, type LogInput } from "./log";
import { loadProfilePack, type ProfilePack } from "./profile";
import { storeImport } from "./correction";
import { IdbRepository, MemoryRepository, type RecordRepository, type Snapshot } from "./recordRepository";
import { RemoteLogStore, RemoteRecordRepository } from "./remoteStore";

/** What storing one imported record did: a new version, or nothing because the latest version already holds it. */
export interface StoredNote {
  model: string;
  batch: string;
  version: number;
  stored: boolean;
  supersedes?: number;
  /** Corrections of the latest version that a re-import carried forward, and corrected values it left challenged. */
  carried?: number;
  disputed?: number;
}

/** The input files picked so far on the Import screen, kept while the operator looks at other screens. */
export interface PickedInput {
  bytes: Uint8Array;
  name: string;
  type: string;
}

interface RecordStore {
  /** The verified pack, or null while it loads or if it could not be verified (then `error` says why). */
  profile: ProfilePack | null;
  error: string | null;
  state: RecordState | null;
  setState: (next: RecordState | null) => void;
  /** The files of the latest import attempt with the result of each, so the Record screen can show accepted and rejected sources. */
  imports: { erp?: ImportResult; lab?: ImportResult };
  setImports: (next: { erp?: ImportResult; lab?: ImportResult }) => void;
  /** The central record: append-only snapshots kept in this browser. */
  repository: RecordRepository;
  /** Stores each record of an accepted import as a snapshot (the Import screen calls this; nothing else does). `label` names an explicit store. */
  saveImport: (state: RecordState, label?: string) => Promise<StoredNote[]>;
  /** The files picked so far (the pair is stored only once both are in and accepted). */
  inputs: { erp?: PickedInput; lab?: PickedInput };
  setInputs: (next: { erp?: PickedInput; lab?: PickedInput }) => void;
  /** The record every screen shows: one model and batch, always read at its latest version unless a screen offers an older one. */
  selected: { model: string; batch: string } | null;
  setSelected: (next: { model: string; batch: string } | null) => void;
  /** Changes whenever a version is added to the central record. */
  repoVersion: number;
  touch: () => void;
  /** The local execution log (public fields only) and a counter that changes whenever an entry is appended. */
  log: ExecutionLog;
  logVersion: number;
  /** Appends entries to the log. Logging never stops the work it records: a failure is swallowed. */
  record: (events: LogInput[] | Promise<LogInput[]>) => Promise<void>;
}

const Context = createContext<RecordStore | null>(null);

export function RecordStoreProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<ProfilePack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<RecordState | null>(null);
  const [imports, setImports] = useState<{ erp?: ImportResult; lab?: ImportResult }>({});
  const [inputs, setInputs] = useState<{ erp?: PickedInput; lab?: PickedInput }>({});
  const [selected, setSelected] = useState<{ model: string; batch: string } | null>(null);
  const [repoVersion, setRepoVersion] = useState(0);
  const touch = useCallback(() => setRepoVersion((n) => n + 1), []);

  useEffect(() => {
    loadProfilePack(pack).then(setProfile, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Optional Node 24 API backend when VITE_API_BASE is configured; otherwise IndexedDB (or memory fallback)
  const apiBase = (import.meta.env.VITE_API_BASE as string | undefined)?.trim() || "";
  const repository = useMemo<RecordRepository>(
    () => (apiBase ? new RemoteRecordRepository(apiBase) : typeof indexedDB === "undefined" ? new MemoryRepository() : new IdbRepository()),
    [apiBase],
  );
  const log = useMemo(
    () => new ExecutionLog(apiBase ? new RemoteLogStore(apiBase) : typeof indexedDB === "undefined" ? new MemoryLogStore() : new IdbLogStore()),
    [apiBase],
  );
  const [logVersion, setLogVersion] = useState(0);
  const record = useCallback(
    async (events: LogInput[] | Promise<LogInput[]>) => {
      try {
        for (const e of await events) await log.append(e);
      } catch {
        // the log is bookkeeping: it must never stop an import or an export
      }
      setLogVersion((n) => n + 1);
    },
    [log],
  );
  const saveImport = useCallback(
    async (next: RecordState, label?: string): Promise<StoredNote[]> => {
      const notes: StoredNote[] = [];
      for (const record of next.records) {
        const { stored, snapshot, carried, disputed } = await storeImport(repository, record, label);
        notes.push({ model: record.model, batch: record.batch, version: snapshot.version, stored, ...(snapshot.supersedes ? { supersedes: snapshot.supersedes.version } : {}), carried, disputed });
      }
      const last = next.records[next.records.length - 1];
      if (last) setSelected({ model: last.model, batch: last.batch });
      touch();
      return notes;
    },
    [repository, touch],
  );

  const value = useMemo(
    () => ({ profile, error, state, setState, imports, setImports, inputs, setInputs, selected, setSelected, repoVersion, touch, repository, saveImport, log, logVersion, record }),
    [profile, error, state, imports, inputs, selected, repoVersion, touch, repository, saveImport, log, logVersion, record],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useRecordStore(): RecordStore {
  const store = useContext(Context);
  if (!store) throw new Error("useRecordStore needs a RecordStoreProvider above it");
  return store;
}

/**
 * The records of the central record and the latest version of the selected one, for every screen that shows "the record":
 * Readiness, Record and Outputs all read this, so a correction or a re-import shows everywhere at once.
 */
export function useLatestSnapshot(): { records: Array<{ model: string; batch: string }>; selected: { model: string; batch: string } | null; latest: Snapshot | null } {
  const { repository, selected, setSelected, state, repoVersion, logVersion } = useRecordStore();
  const [records, setRecords] = useState<Array<{ model: string; batch: string }>>([]);
  const [latest, setLatest] = useState<Snapshot | null>(null);

  useEffect(() => {
    let live = true;
    repository.records().then((r) => live && setRecords(r), () => live && setRecords([]));
    return () => {
      live = false;
    };
  }, [repository, repoVersion, logVersion]);

  const chosen = selected && records.some((r) => r.model === selected.model && r.batch === selected.batch) ? selected : null;
  const fallback = chosen ?? state?.records.map((r) => ({ model: r.model, batch: r.batch })).find((r) => records.some((x) => x.model === r.model && x.batch === r.batch)) ?? records[0] ?? null;
  useEffect(() => {
    if (!chosen && fallback) setSelected(fallback);
  }, [chosen, fallback, setSelected]);

  useEffect(() => {
    let live = true;
    if (!fallback) {
      setLatest(null);
      return;
    }
    repository.latest(fallback.model, fallback.batch).then((s) => live && setLatest(s ?? null));
    return () => {
      live = false;
    };
  }, [repository, fallback?.model, fallback?.batch, repoVersion, logVersion]);

  return { records, selected: fallback, latest };
}
