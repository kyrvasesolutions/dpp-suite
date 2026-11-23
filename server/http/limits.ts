/**
 * HTTP-side operational limits for Cycle 8 (C8-02, D8-02): fixed-window rate limiting with bounded memory, the route
 * template of a request (for the public log and the metrics), and counters-only request metrics.
 *
 * Nothing here holds or returns a request value: keys stay inside the limiter, and the metrics carry counts only.
 */
import { LIMIT_OUTCOMES, type LimitOutcome } from "../../src/model/c8Contracts";

// ---------------------------------------------------------------------------------------------
// Rate limit (T12)
// ---------------------------------------------------------------------------------------------

export type RateKind = "read" | "write";

export interface RateLimiterOptions {
  windowMs: number;
  readPerWindow: number;
  writePerWindow: number;
  /** Most distinct keys held at once. Past it, new keys share one overflow bucket per kind, so memory stays bounded. */
  maxKeys: number;
  clock: () => number;
}

interface Bucket {
  start: number;
  count: number;
}

const OVERFLOW_KEY = "\u0000overflow";

/** Fixed windows keyed by (kind, subject, remote address). Expired keys are evicted; the key map is capped. */
export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  #lastSweep: number;

  constructor(readonly options: RateLimiterOptions) {
    this.#lastSweep = options.clock();
  }

  /** Number of keys held now (for the bounded-memory test and the metrics; never the keys themselves). */
  get size(): number {
    return this.#buckets.size;
  }

  #sweep(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.start >= this.options.windowMs) this.#buckets.delete(key);
    }
    this.#lastSweep = now;
  }

  hit(kind: RateKind, subject: string, address: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.options.clock();
    // Evict expired keys once per window (or once a second when the map is full and a new key arrives).
    if (now - this.#lastSweep >= Math.min(this.options.windowMs, 1000) && (this.#buckets.size >= this.options.maxKeys || now - this.#lastSweep >= this.options.windowMs)) {
      this.#sweep(now);
    }
    let key = `${kind}\u0000${subject}\u0000${address}`;
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      if (this.#buckets.size >= this.options.maxKeys) key = `${kind}${OVERFLOW_KEY}`;
      bucket = this.#buckets.get(key);
    }
    if (!bucket || now - bucket.start >= this.options.windowMs) {
      bucket = { start: now, count: 0 };
      this.#buckets.set(key, bucket);
    }
    bucket.count++;
    const budget = kind === "read" ? this.options.readPerWindow : this.options.writePerWindow;
    if (bucket.count <= budget) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.start + this.options.windowMs - now) / 1000)) };
  }
}

// ---------------------------------------------------------------------------------------------
// Route templates (D8-04): the public log and the metrics never carry a raw path
// ---------------------------------------------------------------------------------------------

const TEMPLATES = [
  "GET /api/health",
  "GET /api/auth/me",
  "GET /api/customer/records",
  "GET /api/customer/records/:model/:batch",
  "POST /api/customer/records/:model/:batch/release",
  "GET /api/admin/users",
  "POST /api/admin/users",
  "POST /api/admin/users/:sub/roles",
  "POST /api/admin/users/:sub/roles/revoke",
  "DELETE /api/admin/users/:sub/roles/:role",
  "POST /api/admin/users/:sub/deactivate",
  "GET /api/admin/audit",
  "GET /api/admin/metrics",
  "GET /api/config-releases",
  "POST /api/config-releases/propose",
  "POST /api/config-releases/rollback",
  "POST /api/config-releases/:release_id/approve",
  "POST /api/config-releases/:release_id/reject",
  "POST /api/config-releases/:release_id/activate",
  "GET /api/config-releases/:release_id",
  "GET /api/policy/retention",
  "GET /api/policy/exceptions",
  "POST /api/jobs/import",
  "POST /api/jobs/recover",
  "GET /api/jobs",
  "GET /api/jobs/:id",
  "POST /api/jobs/:id/cancel",
  "GET /api/records",
  "GET /api/records/:model/:batch/history",
  "POST /api/records/:model/:batch/snapshots",
  "POST /api/records/:model/:batch/correct",
  "POST /api/records/:model/:batch/release",
  "GET /api/evidence",
  "GET /api/evidence/:sha256",
  "POST /api/evidence/:sha256/legal-hold",
  "DELETE /api/evidence/:sha256",
  "GET /api/log",
  "POST /api/log",
] as const;

const PARAM_PATTERN: Record<string, string> = { sha256: "[0-9a-fA-F]{64}" };

const COMPILED = TEMPLATES.map((t) => {
  const [method, path] = t.split(" ") as [string, string];
  const source = path
    .split("/")
    .map((seg) => (seg.startsWith(":") ? (PARAM_PATTERN[seg.slice(1)] ?? "[^/]+") : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return { method, template: t, re: new RegExp(`^${source}$`) };
});

const KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** The matched route template, for example `POST /api/jobs/:id/cancel`, or a fixed template for an unmatched path. */
export function routeTemplate(methodInput: string | undefined, rawUrl: string | undefined): string {
  const method = KNOWN_METHODS.has(methodInput ?? "") ? methodInput! : "OTHER";
  const queryAt = (rawUrl ?? "").search(/[?#]/);
  const path = queryAt === -1 ? (rawUrl ?? "/") : (rawUrl ?? "/").slice(0, queryAt);
  const lookup = method === "HEAD" ? "GET" : method;
  for (const c of COMPILED) if (c.method === lookup && c.re.test(path)) return `${method} ${c.template.split(" ")[1]}`;
  if (path === "/api" || path.startsWith("/api/")) return `${method} /api/:unmatched`;
  return method === "GET" || method === "HEAD" ? `${method} /:static` : `${method} /:unmatched`;
}

// ---------------------------------------------------------------------------------------------
// Counters only (T23)
// ---------------------------------------------------------------------------------------------

export class ServerMetrics {
  readonly #startedAt = Date.now();
  readonly #byClass = new Map<string, number>();
  readonly #limits = new Map<string, number>();
  #total = 0;

  recordRequest(status: number): void {
    this.#total++;
    const klass = `${Math.floor(status / 100)}xx`;
    this.#byClass.set(klass, (this.#byClass.get(klass) ?? 0) + 1);
  }

  recordLimit(outcome: LimitOutcome, limit: string): void {
    const key = `${outcome}\u0000${limit}`;
    this.#limits.set(key, (this.#limits.get(key) ?? 0) + 1);
  }

  snapshot(jobs: { activeTotal: number; queuedTotal: number; byDomain: Record<string, { active: number; queued: number }> }) {
    const limitOutcomes = [...this.#limits.entries()]
      .map(([key, count]) => {
        const [outcome, limit] = key.split("\u0000") as [LimitOutcome, string];
        return { outcome, limit, count };
      })
      .sort((a, b) => (a.outcome + a.limit).localeCompare(b.outcome + b.limit));
    const byOutcome: Record<string, number> = Object.fromEntries(LIMIT_OUTCOMES.map((o) => [o, 0]));
    for (const l of limitOutcomes) byOutcome[l.outcome] = (byOutcome[l.outcome] ?? 0) + l.count;
    return {
      requests: { total: this.#total, byStatusClass: Object.fromEntries([...this.#byClass.entries()].sort()) },
      limitOutcomes,
      limitOutcomeTotals: byOutcome,
      jobs,
      process: { rssBytes: process.memoryUsage().rss, uptimeSeconds: Math.round((Date.now() - this.#startedAt) / 1000) },
    };
  }
}
