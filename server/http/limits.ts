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
  /** Most keys held for authenticated subjects, and (separately) for anonymous callers. The least recently used key is evicted first. */
  maxKeys: number;
  clock: () => number;
}

interface Bucket {
  start: number;
  count: number;
}

/** An address as a limiter key: an IPv4 address as is, an IPv6 address by its /64, an IPv4-mapped IPv6 address as the IPv4 it holds. */
export function addressKey(address: string | undefined): string {
  const a = (address ?? "unknown").toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1]!;
  if (!a.includes(":")) return a;
  // expand "::" and keep the first four groups
  const [head, tail = ""] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = a.includes("::") ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** An LRU map of fixed-window buckets. Expired buckets at the cold end are dropped as time passes; the size is capped. */
class BucketPool {
  readonly #map = new Map<string, Bucket>();
  constructor(
    readonly maxKeys: number,
    readonly windowMs: number,
  ) {}
  get size(): number {
    return this.#map.size;
  }
  /** Drops expired buckets from the cold end. */
  sweep(now: number, keep?: string): void {
    for (const [k, v] of this.#map) {
      if (k !== keep && now - v.start >= this.windowMs) this.#map.delete(k);
      else break;
    }
  }
  touch(key: string, now: number): Bucket {
    let b = this.#map.get(key);
    if (b) this.#map.delete(key); // re-inserted below: most recently used goes to the end
    if (!b || now - b.start >= this.windowMs) b = { start: now, count: 0 };
    this.#map.set(key, b);
    this.sweep(now, key);
    while (this.#map.size > this.maxKeys) this.#map.delete(this.#map.keys().next().value as string);
    return b;
  }
}

/**
 * Fixed windows keyed by (kind, subject, remote address) for authenticated subjects, and by (kind, address) for anonymous callers.
 * The two have separate capped pools, so a flood of anonymous keys can never evict or lock out a real subject (V2-03).
 */
export class RateLimiter {
  readonly #auth: BucketPool;
  readonly #anon: BucketPool;

  constructor(readonly options: RateLimiterOptions) {
    this.#auth = new BucketPool(options.maxKeys, options.windowMs);
    this.#anon = new BucketPool(options.maxKeys, options.windowMs);
  }

  /** Number of keys held now (for the bounded-memory test; never the keys themselves). */
  get size(): number {
    return this.#auth.size + this.#anon.size;
  }

  hit(kind: RateKind, subject: string, address: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.options.clock();
    const anonymous = subject === "anon";
    const pool = anonymous ? this.#anon : this.#auth;
    (anonymous ? this.#auth : this.#anon).sweep(now);
    const bucket = pool.touch(anonymous ? `${kind}\u0000${addressKey(address)}` : `${kind}\u0000${subject}\u0000${addressKey(address)}`, now);
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
  "GET /api/admin/alerts",
  "GET /api/admin/backups",
  "POST /api/admin/backups",
  "POST /api/admin/migration/export",
  "POST /api/admin/migration/import",
  "GET /api/admin/content-acceptance",
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
  // The same normalisation the router applies (WHATWG URL: dot segments and %2e collapse), so the template is the route that was served.
  let path: string;
  try {
    path = new URL(rawUrl ?? "/", "http://127.0.0.1").pathname;
  } catch {
    path = "/api/";
  }
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
  readonly #recent5xx: number[] = [];
  readonly #recentRateLimited: number[] = [];
  readonly #recentTimeouts: number[] = [];
  readonly #windowMs: number;
  readonly #clock: () => number;
  #total = 0;

  constructor(options: { windowMs?: number; clock?: () => number } = {}) {
    this.#windowMs = options.windowMs ?? 15 * 60_000;
    this.#clock = options.clock ?? (() => Date.now());
  }

  private pruneWindow(arr: number[], now: number): number {
    const cutoff = now - this.#windowMs;
    while (arr.length > 0 && arr[0]! < cutoff) arr.shift();
    return arr.length;
  }

  recordRequest(status: number): void {
    this.#total++;
    const klass = `${Math.floor(status / 100)}xx`;
    this.#byClass.set(klass, (this.#byClass.get(klass) ?? 0) + 1);
    if (status >= 500 && status < 600) {
      const now = this.#clock();
      this.#recent5xx.push(now);
      this.pruneWindow(this.#recent5xx, now);
    }
  }

  recordLimit(outcome: LimitOutcome, limit: string): void {
    const key = `${outcome}\u0000${limit}`;
    this.#limits.set(key, (this.#limits.get(key) ?? 0) + 1);
    const now = this.#clock();
    if (
      outcome === "OVER_LIMIT" &&
      (limit === "rate_window" || limit.includes("rate_limit") || limit === "max_connections" || limit.includes("queue"))
    ) {
      this.#recentRateLimited.push(now);
      this.pruneWindow(this.#recentRateLimited, now);
    }
    if (outcome === "TIMEOUT") {
      this.#recentTimeouts.push(now);
      this.pruneWindow(this.#recentTimeouts, now);
    }
  }

  /** Rolling-window value-free counters fed into AlertMonitor so transient faults self-resolve once the window clears. */
  faultCounters(): { errors5xx: number; rateLimitedCount: number; jobTimeouts: number } {
    const now = this.#clock();
    return {
      errors5xx: this.pruneWindow(this.#recent5xx, now),
      rateLimitedCount: this.pruneWindow(this.#recentRateLimited, now),
      jobTimeouts: this.pruneWindow(this.#recentTimeouts, now),
    };
  }

  snapshot(jobs: { activeTotal: number; queuedTotal: number; byDomain?: Record<string, { active: number; queued: number }> }) {
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
