/**
 * Optional HTTP client adapters (`RemoteRecordRepository` and `RemoteLogStore`) connecting the
 * browser UI to the Cycle 6 Node 24 relational API when `VITE_API_BASE` is configured (ADR-0004).
 *
 * When `VITE_API_BASE` is empty (default static build and GitHub Pages), this module is never called
 * and the app continues using local IndexedDB with zero network requests.
 */
import type { LogEntry, LogStore } from "./log";
import { RepositoryError, type RecordRepository, type Snapshot } from "./recordRepository";

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json()) as T & { message?: string };
  if (!res.ok) {
    throw new RepositoryError(data.message ?? `Server returned HTTP ${res.status}`);
  }
  return data;
}

export class RemoteRecordRepository implements RecordRepository {
  private readonly base: string;
  constructor(apiBase: string) {
    this.base = apiBase.replace(/\/+$/, "");
  }

  async put(snapshot: Snapshot): Promise<void> {
    await apiJson(
      `${this.base}/api/records/${encodeURIComponent(snapshot.model)}/${encodeURIComponent(snapshot.batch)}/snapshots`,
      { method: "POST", body: JSON.stringify({ snapshot }) },
    );
  }

  async history(model: string, batch: string): Promise<Snapshot[]> {
    const res = await apiJson<{ history: Snapshot[] }>(
      `${this.base}/api/records/${encodeURIComponent(model)}/${encodeURIComponent(batch)}/history`,
    );
    return res.history;
  }

  async get(model: string, batch: string, version: number): Promise<Snapshot | undefined> {
    const all = await this.history(model, batch);
    return all.find((s) => s.version === version);
  }

  async latest(model: string, batch: string): Promise<Snapshot | undefined> {
    const all = await this.history(model, batch);
    return all[all.length - 1];
  }

  async records(): Promise<Array<{ model: string; batch: string }>> {
    const res = await apiJson<{ records: Array<{ model: string; batch: string }> }>(`${this.base}/api/records`);
    return res.records;
  }
}

export class RemoteLogStore implements LogStore {
  private readonly base: string;
  constructor(apiBase: string) {
    this.base = apiBase.replace(/\/+$/, "");
  }

  async add(entry: Omit<LogEntry, "seq">): Promise<number> {
    const res = await apiJson<{ seq: number }>(`${this.base}/api/log`, {
      method: "POST",
      body: JSON.stringify({ entry }),
    });
    return res.seq;
  }

  async all(): Promise<LogEntry[]> {
    const res = await apiJson<{ entries: LogEntry[] }>(`${this.base}/api/log`);
    return res.entries;
  }
}
