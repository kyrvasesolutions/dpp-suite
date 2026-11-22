/**
 * HTTP client for the Cycle 6 Node 24 relational API (ADR-0004): read-only adapters for the central record and the
 * execution log, a probe that finds the server, and the call that submits an import as a durable job.
 *
 * The server serves this app on its own origin, so the base is empty (same origin) and the content security policy
 * (`connect-src 'self'`) needs no exception. The static build (GitHub Pages) finds no server and keeps using local
 * IndexedDB. Snapshots and log entries are written by the server only: this client has no raw write.
 */
import { CorrectionError, type CorrectionRequest } from "./correction";
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

  async put(_snapshot: Snapshot): Promise<void> {
    throw new RepositoryError("Snapshots are created by import jobs on the server; the browser cannot write one directly.");
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

  async add(_entry: Omit<LogEntry, "seq">): Promise<number> {
    throw new RepositoryError("The execution log is written by the server only.");
  }

  async all(): Promise<LogEntry[]> {
    const res = await apiJson<{ entries: LogEntry[] }>(`${this.base}/api/log`);
    return res.entries;
  }
}

/** What `/api/health` says about a server that is there. */
export interface ServerHealth {
  status: "ok";
  schemaVersion: number;
  activeRetentionPolicy: string | null;
}

/**
 * Looks for the DPP server on the same origin. Anything that is not its JSON health answer (a 404 on a static host,
 * the app shell a dev server returns for unknown paths, a network error) means there is no server.
 */
export async function probeServer(base = ""): Promise<ServerHealth | null> {
  try {
    if (typeof fetch === "undefined") return null;
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/health`, { headers: { Accept: "application/json" } });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return null;
    const body = (await res.json()) as Partial<ServerHealth>;
    return body.status === "ok" && typeof body.schemaVersion === "number" ? (body as ServerHealth) : null;
  } catch {
    return null;
  }
}

export interface ImportJobFile {
  bytes: Uint8Array;
  name: string;
  type: string;
}

/** The part of the server's job outcome the screens use. */
export interface ImportJobResult {
  ok: boolean;
  job?: { jobId: string; state: string };
  receipt?: { version: number; stored: boolean; model: string; batch: string };
  snapshot?: { model: string; batch: string; version: number; supersedes?: { version: number } };
  carried?: number;
  disputed?: number;
  errors?: Array<{ stage: string; code: string; message: string }>;
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** Submits the two source files as one staged, idempotent, durable import job and returns the server's outcome. */
export async function submitImportJob(
  base: string,
  files: { erp: ImportJobFile; lab?: ImportJobFile },
  idempotencyKey: string = crypto.randomUUID(),
): Promise<ImportJobResult> {
  const part = (f: ImportJobFile) => ({ name: f.name, type: f.type || "application/octet-stream", base64: toBase64(f.bytes) });
  const res = await fetch(`${base.replace(/\/+$/, "")}/api/jobs/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ erp: part(files.erp), ...(files.lab ? { lab: part(files.lab) } : {}) }),
  });
  const data = (await res.json()) as ImportJobResult & { message?: string };
  if (!res.ok && res.status !== 422) throw new RepositoryError(data.message ?? `Server returned HTTP ${res.status}`);
  return data;
}

/** Corrects one value on the server, which stores the result as the next version inside one transaction. */
export async function correctOnServer(base: string, request: CorrectionRequest): Promise<{ model: string; batch: string; version: number }> {
  const url = `${base.replace(/\/+$/, "")}/api/records/${encodeURIComponent(request.model)}/${encodeURIComponent(request.batch)}/correct`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ property: request.property, member: request.member, qualifier: request.qualifier, raw: request.raw, reason: request.reason }),
  });
  const data = (await res.json()) as { snapshot?: { model: string; batch: string; version: number }; code?: string; message?: string };
  if (!res.ok || !data.snapshot) {
    if (data.code === "correction-invalid") throw new CorrectionError(data.message ?? "The correction was refused.");
    throw new RepositoryError(data.message ?? `Server returned HTTP ${res.status}`);
  }
  return { model: data.snapshot.model, batch: data.snapshot.batch, version: data.snapshot.version };
}
