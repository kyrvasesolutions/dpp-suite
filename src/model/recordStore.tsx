/**
 * The record state shared between screens (Cycle 3): the Import screen writes it, the Readiness screen reads it.
 * It also holds the verified contract pack, so every screen reads the same profile. Nothing is stored beyond
 * this page session, and nothing leaves the device.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import pack from "virtual:contract-pack";
import type { RecordState } from "./ingress";
import { ExecutionLog, IdbLogStore, MemoryLogStore, type LogInput } from "./log";
import { loadProfilePack, type ProfilePack } from "./profile";
import { IdbRepository, MemoryRepository, storeRecord, type RecordRepository } from "./recordRepository";

/** What storing one imported record did: a new version, or nothing because the latest version already holds it. */
export interface StoredNote {
  model: string;
  batch: string;
  version: number;
  stored: boolean;
  supersedes?: number;
}

interface RecordStore {
  /** The verified pack, or null while it loads or if it could not be verified (then `error` says why). */
  profile: ProfilePack | null;
  error: string | null;
  state: RecordState | null;
  setState: (next: RecordState | null) => void;
  /** The central record: append-only snapshots kept in this browser. */
  repository: RecordRepository;
  /** Stores each record of an accepted import as a snapshot (the Import screen calls this; nothing else does). */
  saveImport: (state: RecordState) => Promise<StoredNote[]>;
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

  useEffect(() => {
    loadProfilePack(pack).then(setProfile, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // IndexedDB where the browser has it; otherwise the central record lives for this page session only
  const repository = useMemo<RecordRepository>(() => (typeof indexedDB === "undefined" ? new MemoryRepository() : new IdbRepository()), []);
  const log = useMemo(() => new ExecutionLog(typeof indexedDB === "undefined" ? new MemoryLogStore() : new IdbLogStore()), []);
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
    async (next: RecordState): Promise<StoredNote[]> => {
      const notes: StoredNote[] = [];
      for (const record of next.records) {
        const { stored, snapshot } = await storeRecord(repository, record);
        notes.push({ model: record.model, batch: record.batch, version: snapshot.version, stored, ...(snapshot.supersedes ? { supersedes: snapshot.supersedes.version } : {}) });
      }
      return notes;
    },
    [repository],
  );

  const value = useMemo(
    () => ({ profile, error, state, setState, repository, saveImport, log, logVersion, record }),
    [profile, error, state, repository, saveImport, log, logVersion, record],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useRecordStore(): RecordStore {
  const store = useContext(Context);
  if (!store) throw new Error("useRecordStore needs a RecordStoreProvider above it");
  return store;
}
