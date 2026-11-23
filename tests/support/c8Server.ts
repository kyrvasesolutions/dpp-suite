/**
 * Cycle 8 Layer 3 helpers: a real `createDppServer` on an ephemeral port over a temp SQLite file, with the pinned
 * OPERATIONAL-LIMITS patched where a boundary has to be reached without large inputs or real waiting.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrantStore } from "../../server/auth/grantStore";
import { SqliteAdapter } from "../../server/db/adapter";
import { computeStoreChecksum, migrateUp } from "../../server/db/migrations";
import { createDppServer, type DppServerOptions } from "../../server/http/api";
import { PolicyStore } from "../../server/store/policyStore";
import type { OperationalLimits } from "../../src/model/c8Contracts";
import type { DeploymentSurface, ServerRole } from "../../src/model/c7Contracts";
import type { ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "./fixtures";
import { createTestIdp, type TestIdp } from "./oidc";
import { CLEAN, loadPack } from "./records";
import { TEST_SOFTWARE } from "./release";

export const NOW = "2026-11-22T12:00:00.000Z";

export type LimitsPatch = {
  [K in keyof OperationalLimits]?: OperationalLimits[K] extends object ? Partial<OperationalLimits[K]> : OperationalLimits[K];
};

/** A copy of the pinned limits with some values replaced. The pinned pack is never changed. */
export function limitsWith(pack: ProfilePack, patch: LimitsPatch = {}): OperationalLimits {
  const base = pack.operationalLimits;
  return {
    ...base,
    execution: { ...base.execution, ...(patch.execution ?? {}) },
    coordinator: { ...base.coordinator, ...(patch.coordinator ?? {}) },
    http: { ...base.http, ...(patch.http ?? {}) },
    targets: { ...base.targets, ...(patch.targets ?? {}) },
  };
}

/** Rate windows large enough that a suite that is not about rate limits never meets one. */
export const NO_RATE_PRESSURE: LimitsPatch = { http: { rate_limit_read_per_window: 1_000_000, rate_limit_write_per_window: 1_000_000 } as OperationalLimits["http"] };

export interface TestUser {
  sub: string;
  roles: ServerRole[];
  domain?: string;
}

export interface C8Server {
  baseUrl: string;
  port: number;
  db: SqliteAdapter;
  pack: ProfilePack;
  idp: TestIdp;
  limits: OperationalLimits;
  token(sub: string): string;
  close(): Promise<void>;
  /** Everything a partial commit could touch, in one comparable value. */
  state(): { checksum: string; snapshots: number; receipts: number; evidence: number; logEntries: number };
}

export interface StartOptions {
  mode?: "local-dev" | "oidc";
  surface?: DeploymentSurface;
  patch?: LimitsPatch;
  users?: TestUser[];
  /** Security domains whose retention policy is activated (the default domain always is). */
  domains?: string[];
  extra?: Partial<DppServerOptions>;
}

export async function startC8Server(options: StartOptions = {}): Promise<C8Server> {
  const pack = await loadPack();
  const dir = mkdtempSync(join(tmpdir(), "dpp-c8-"));
  const db = new SqliteAdapter({ path: join(dir, "c8.sqlite") });
  migrateUp(db);
  new PolicyStore(db).activate(pack.policy.retention, NOW);
  for (const d of options.domains ?? []) new PolicyStore(db, d).activate(pack.policy.retention, NOW);

  const idp = createTestIdp();
  const mode = options.mode ?? "local-dev";
  if (mode === "oidc") {
    for (const u of options.users ?? []) {
      const grants = new GrantStore(db, u.domain, { now: () => NOW });
      grants.upsertUser({ sub: u.sub, displayName: `Test ${u.sub}`, roles: u.roles, actorSub: "bootstrap", reason: "Cycle 8 test user" });
    }
  }
  const limits = limitsWith(pack, options.patch);
  const server = createDppServer({
    db,
    pack,
    software: TEST_SOFTWARE,
    now: () => NOW,
    limits,
    authMode: mode,
    surface: options.surface ?? "all",
    ...(mode === "oidc" ? { oidc: idp.oidcConfig } : {}),
    ...(options.extra ?? {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    db,
    pack,
    idp,
    limits,
    token: (sub) => idp.signRs256({ sub }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
    state: () => {
      const n = (table: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
      return {
        checksum: computeStoreChecksum(db),
        snapshots: n("snapshots"),
        receipts: n("update_receipts"),
        evidence: n("evidence_store"),
        logEntries: n("execution_log"),
      };
    },
  };
}

export const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export interface ImportParts {
  key: string;
  erp?: string;
  lab?: string | null;
  evidence?: Array<{ evidenceId: string; bytes: Uint8Array }>;
}

/** The JSON body of an import of digest-checked N fixtures (`CLEAN` unless named). */
export function importBody(parts: ImportParts): string {
  const erpName = parts.erp ?? CLEAN.erp;
  const labName = parts.lab === undefined ? CLEAN.lab : parts.lab;
  return JSON.stringify({
    idempotencyKey: parts.key,
    erp: { name: erpName, type: "text/csv", base64: b64(fixtureBytes("n", erpName)) },
    ...(labName ? { lab: { name: labName, type: "application/json", base64: b64(fixtureBytes("n", labName)) } } : {}),
    ...(parts.evidence?.length
      ? {
          evidence: parts.evidence.map((e) => ({
            evidenceId: e.evidenceId,
            issuer: "Demo Lab",
            revision: "1",
            recordKind: "test-report",
            base64: b64(e.bytes),
          })),
        }
      : {}),
  });
}

export const fixtureSize = (name: string) => fixtureBytes("n", name).byteLength;

export function headers(token?: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

export async function post(server: C8Server, path: string, body: string | object, token?: string, extra: Record<string, string> = {}) {
  return fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: headers(token, extra),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export async function get(server: C8Server, path: string, token?: string, extra: Record<string, string> = {}) {
  return fetch(`${server.baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}`, ...extra } : extra });
}

/** A gate a test opens when it wants a held stage to go on. */
export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `fn` returns a truthy value, or fails after `timeoutMs`. */
export async function until<T>(fn: () => T | Promise<T>, timeoutMs = 5000, stepMs = 5): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(stepMs);
  }
}
