/**
 * The record state shared between screens (Cycle 3): the Import screen writes it, the Readiness screen reads it.
 * It also holds the verified contract pack, so every screen reads the same profile. Nothing is stored beyond
 * this page session, and nothing leaves the device.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import pack from "virtual:contract-pack";
import type { RecordState } from "./ingress";
import { loadProfilePack, type ProfilePack } from "./profile";

interface RecordStore {
  /** The verified pack, or null while it loads or if it could not be verified (then `error` says why). */
  profile: ProfilePack | null;
  error: string | null;
  state: RecordState | null;
  setState: (next: RecordState | null) => void;
}

const Context = createContext<RecordStore | null>(null);

export function RecordStoreProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<ProfilePack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<RecordState | null>(null);

  useEffect(() => {
    loadProfilePack(pack).then(setProfile, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const value = useMemo(() => ({ profile, error, state, setState }), [profile, error, state]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useRecordStore(): RecordStore {
  const store = useContext(Context);
  if (!store) throw new Error("useRecordStore needs a RecordStoreProvider above it");
  return store;
}
