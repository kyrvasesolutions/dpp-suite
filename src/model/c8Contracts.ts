/**
 * Cycle 8 contracts (P05 bounded load, input limits and retry behaviour; P06 security and confidentiality hardening).
 *
 * Pure: no DOM, no Node imports. Layer 2 simulates these contracts and the server later wraps them.
 *
 *  - the pinned OPERATIONAL-LIMITS@1.0.0 schema (D8-01),
 *  - the meaning of TIMEOUT, OVER_LIMIT and CANCELLED and the code mapping (D8-02),
 *  - the job coordinator state machine, cancellation token and job budget (LEAN-DEF-08, LEAN-DEF-09),
 *  - the six-field public log line (D8-04),
 *  - the egress decision (D8-05),
 *  - the two new server actions (job:cancel, metrics:read).
 *
 * The values here are ARTIFICIAL-DEMO design values read from the pinned pack; they are not measured limits.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// OPERATIONAL-LIMITS@1.0.0 (D8-01)
// ---------------------------------------------------------------------------------------------

const PosInt = z.number().int().positive();

export const OperationalLimitsSchema = z
  .object({
    id: z.literal("OPERATIONAL-LIMITS"),
    version: z.string().min(1),
    status: z.enum(["FROZEN", "HOLD"]).optional(),
    execution: z
      .object({
        source_file_max_bytes: PosInt,
        source_pair_max_bytes: PosInt,
        max_nesting_depth: PosInt,
        max_records_per_job: PosInt,
        job_deadline_ms: PosInt,
        max_parser_nodes_per_job: PosInt,
        max_output_bytes_per_route: PosInt,
        total_staging_max_bytes: PosInt,
        execution_memory_max_bytes: PosInt,
        cancellation_poll_max_ms: PosInt,
        /** The server never retries on its own; clients retry with the same idempotency key. */
        retry_count: z.literal(0),
      })
      .strict(),
    coordinator: z
      .object({
        max_active_jobs_per_security_domain: PosInt,
        max_queued_jobs_per_security_domain: PosInt,
        max_active_jobs_total: PosInt,
        retry_after_seconds: PosInt,
      })
      .strict(),
    http: z
      .object({
        headers_timeout_ms: PosInt,
        request_timeout_ms: PosInt,
        keep_alive_timeout_ms: PosInt,
        max_connections: PosInt,
        max_request_body_bytes: PosInt,
        rate_limit_window_ms: PosInt,
        rate_limit_read_per_window: PosInt,
        rate_limit_write_per_window: PosInt,
      })
      .strict(),
    targets: z
      .object({
        import_job_p95_ms: PosInt,
        read_p95_ms: PosInt,
        concurrent_clients: PosInt,
        volume_committed_batches: PosInt,
        max_server_errors: z.literal(0),
        max_rss_bytes: PosInt,
      })
      .strict(),
    note: z.string().min(1),
  })
  .strict();

export type OperationalLimits = z.infer<typeof OperationalLimitsSchema>;

// ---------------------------------------------------------------------------------------------
// Limit outcomes (D8-02)
// ---------------------------------------------------------------------------------------------

export const LIMIT_OUTCOMES = ["TIMEOUT", "OVER_LIMIT", "CANCELLED"] as const;
export type LimitOutcome = (typeof LIMIT_OUTCOMES)[number];

/** Every declared budget a response can name (`limit: "<name>"`), without echoing any input value. */
export const LIMIT_NAMES = [
  "source_file_max_bytes",
  "source_pair_max_bytes",
  "max_nesting_depth",
  "max_records_per_job",
  "max_parser_nodes_per_job",
  "max_output_bytes_per_route",
  "total_staging_max_bytes",
  "max_request_body_bytes",
  "queue_full",
  "rate_window",
  "max_connections",
  "job_deadline_ms",
  "request_timeout_ms",
] as const;
export type LimitName = (typeof LIMIT_NAMES)[number];

const CODE_OUTCOME: Readonly<Record<string, LimitOutcome>> = {
  "too-large": "OVER_LIMIT",
  "too-deep": "OVER_LIMIT",
  "multiple-records": "OVER_LIMIT",
  "too-many-nodes": "OVER_LIMIT",
  "queue-full": "OVER_LIMIT",
  "rate-limited": "OVER_LIMIT",
  deadline: "TIMEOUT",
  cancelled: "CANCELLED",
};

/** The outcome class of an existing ingress or HTTP code, or null when the code is not a limit code. */
export function classifyLimitOutcome(code: string): LimitOutcome | null {
  return Object.hasOwn(CODE_OUTCOME, code) ? CODE_OUTCOME[code]! : null;
}

const OUTCOME_TEXT: Record<LimitOutcome, string> = {
  OVER_LIMIT: "A declared limit was exceeded. Nothing was committed.",
  TIMEOUT: "The job passed its time limit. Nothing was committed.",
  CANCELLED: "The job was cancelled. Nothing was committed.",
};

/** A limit stop. The message is fixed per outcome and never carries an input value. */
export class LimitError extends Error {
  override name = "LimitError";
  constructor(
    readonly outcome: LimitOutcome,
    readonly limit: LimitName | "cancellation",
    readonly code: string,
    readonly stage?: string,
  ) {
    super(OUTCOME_TEXT[outcome]);
  }
}

// ---------------------------------------------------------------------------------------------
// Cancellation token and job budget (LEAN-DEF-09)
// ---------------------------------------------------------------------------------------------

export class CancellationToken {
  #cancelled = false;
  #reason: string | null = null;

  /** Cancels once. Returns true on the first call and false on every repeat (idempotent). */
  cancel(reason: string): boolean {
    if (this.#cancelled) return false;
    this.#cancelled = true;
    this.#reason = reason;
    return true;
  }
  get isCancelled(): boolean {
    return this.#cancelled;
  }
  /** For the access-controlled execution log only; never for the public log or a response. */
  get reason(): string | null {
    return this.#reason;
  }
  throwIfCancelled(stage?: string): void {
    if (this.#cancelled) throw new LimitError("CANCELLED", "cancellation", "cancelled", stage);
  }
}

export type CancelResult = "cancelled" | "already-cancelled" | "not-cancellable";

export interface JobBudgetOptions {
  deadlineMs: number;
  /** Injected clock in milliseconds. */
  now: () => number;
  token?: CancellationToken;
}

/** The deadline and the token of one job. `check` is called at every stage boundary and at parser ticks. */
export class JobBudget {
  readonly token: CancellationToken;
  readonly #startedAt: number;
  readonly #deadlineMs: number;
  readonly #now: () => number;
  #revoked: "TIMEOUT" | "CANCELLED" | null = null;
  #committed = false;

  constructor(options: JobBudgetOptions) {
    this.token = options.token ?? new CancellationToken();
    this.#deadlineMs = options.deadlineMs;
    this.#now = options.now;
    this.#startedAt = options.now();
  }

  get elapsedMs(): number {
    return this.#now() - this.#startedAt;
  }
  get promotionRevoked(): boolean {
    return this.#revoked !== null;
  }
  get committed(): boolean {
    return this.#committed;
  }

  /** Throws CANCELLED when the token is cancelled, TIMEOUT when the deadline has passed. A stop revokes promotion. */
  check(stage: string): void {
    if (this.token.isCancelled) {
      this.#revoked ??= "CANCELLED";
      this.token.throwIfCancelled(stage);
    }
    if (this.elapsedMs > this.#deadlineMs) {
      this.#revoked ??= "TIMEOUT";
      throw new LimitError("TIMEOUT", "job_deadline_ms", "deadline", stage);
    }
  }

  /** Revokes the permission to promote staged rows, as a stop does before commit. */
  revokePromotion(outcome: "TIMEOUT" | "CANCELLED" = "CANCELLED"): void {
    this.#revoked ??= outcome;
  }

  /** Called immediately before the commit. Throws when promotion was revoked or the deadline or token tripped since the last check. */
  assertMayCommit(): void {
    if (this.#revoked) throw this.#stop(this.#revoked);
    this.check("commit");
  }

  #stop(outcome: "TIMEOUT" | "CANCELLED"): LimitError {
    return outcome === "TIMEOUT"
      ? new LimitError("TIMEOUT", "job_deadline_ms", "deadline", "commit")
      : new LimitError("CANCELLED", "cancellation", "cancelled", "commit");
  }

  markCommitted(): void {
    this.assertMayCommit();
    this.#committed = true;
  }

  /** Cancel by the submitter or an ADMIN. A committed job is not cancellable. Repeats are idempotent. */
  cancel(reason: string): CancelResult {
    if (this.#committed) return "not-cancellable";
    return this.token.cancel(reason) ? "cancelled" : "already-cancelled";
  }
}

// ---------------------------------------------------------------------------------------------
// Job coordinator model (LEAN-DEF-08)
// ---------------------------------------------------------------------------------------------

export interface CoordinatorConfig {
  maxActivePerDomain: number;
  maxQueuedPerDomain: number;
  maxActiveTotal: number;
  retryAfterSeconds: number;
}

export function coordinatorConfigFrom(limits: OperationalLimits): CoordinatorConfig {
  const c = limits.coordinator;
  return {
    maxActivePerDomain: c.max_active_jobs_per_security_domain,
    maxQueuedPerDomain: c.max_queued_jobs_per_security_domain,
    maxActiveTotal: c.max_active_jobs_total,
    retryAfterSeconds: c.retry_after_seconds,
  };
}

export type AdmitDecision =
  | { kind: "started"; jobId: string }
  | { kind: "queued"; jobId: string; position: number }
  | { kind: "rejected"; outcome: "OVER_LIMIT"; limit: "queue_full"; code: "queue-full"; retryAfterSeconds: number };

export type FinishDecision = { kind: "finished"; jobId: string; started: string[] } | { kind: "unknown"; jobId: string };

export type CancelDecision =
  | { kind: "cancelled"; jobId: string; wasActive: boolean; started: string[] }
  | { kind: "not-cancellable"; jobId: string };

type JobState = "queued" | "active" | "finished" | "cancelled";

interface JobEntry {
  jobId: string;
  domain: string;
  state: JobState;
}

/**
 * Deterministic coordinator: per-security-domain active slots, a FIFO queue, and a global active cap.
 * A job starts at once when its domain and the total have room, else it waits in arrival order. A waiting job of a
 * blocked domain never holds back a job of a free domain (domains are isolated until the global cap).
 */
export class JobCoordinatorModel {
  /** Queued and active jobs only: a finished or cancelled job is dropped at once, so memory and counting stay bounded by live work. */
  readonly #entries = new Map<string, JobEntry>();
  readonly #activeByDomain = new Map<string, number>();
  #activeTotal = 0;
  /** Arrival order of waiting jobs. */
  #queue: string[] = [];

  constructor(readonly config: CoordinatorConfig) {}

  activeCount(domain?: string): number {
    return domain === undefined ? this.#activeTotal : (this.#activeByDomain.get(domain) ?? 0);
  }
  /** Number of jobs the model still holds (queued plus active). */
  get size(): number {
    return this.#entries.size;
  }
  #deactivate(e: JobEntry): void {
    this.#activeTotal--;
    const n = (this.#activeByDomain.get(e.domain) ?? 1) - 1;
    if (n <= 0) this.#activeByDomain.delete(e.domain);
    else this.#activeByDomain.set(e.domain, n);
  }
  queuedCount(domain?: string): number {
    return this.#queue.filter((id) => domain === undefined || this.#entries.get(id)!.domain === domain).length;
  }
  queuedIds(): string[] {
    return [...this.#queue];
  }
  stateOf(jobId: string): JobState | "unknown" {
    return this.#entries.get(jobId)?.state ?? "unknown";
  }

  #canStart(domain: string): boolean {
    return this.activeCount(domain) < this.config.maxActivePerDomain && this.activeCount() < this.config.maxActiveTotal;
  }

  /** Admits a job: starts it, queues it, or refuses it with OVER_LIMIT `queue_full` (HTTP 429 with Retry-After). */
  admit(jobId: string, domain: string): AdmitDecision {
    if (this.#entries.has(jobId)) throw new Error("job id already admitted");
    if (!this.#canStart(domain) && this.queuedCount(domain) >= this.config.maxQueuedPerDomain) {
      return { kind: "rejected", outcome: "OVER_LIMIT", limit: "queue_full", code: "queue-full", retryAfterSeconds: this.config.retryAfterSeconds };
    }
    this.#entries.set(jobId, { jobId, domain, state: "queued" });
    this.#queue.push(jobId);
    const started = this.start();
    if (started.includes(jobId)) return { kind: "started", jobId };
    return { kind: "queued", jobId, position: this.#queue.indexOf(jobId) + 1 };
  }

  /** Starts every waiting job that now fits, in arrival order, and returns their ids. */
  start(): string[] {
    const started: string[] = [];
    for (const id of [...this.#queue]) {
      if (this.activeCount() >= this.config.maxActiveTotal) break;
      const e = this.#entries.get(id)!;
      if (this.activeCount(e.domain) >= this.config.maxActivePerDomain) continue;
      e.state = "active";
      this.#activeTotal++;
      this.#activeByDomain.set(e.domain, (this.#activeByDomain.get(e.domain) ?? 0) + 1);
      this.#queue = this.#queue.filter((q) => q !== id);
      started.push(id);
    }
    return started;
  }

  /** An active job ended (committed, failed or rolled back). Frees its slot and starts what fits. */
  finish(jobId: string): FinishDecision {
    const e = this.#entries.get(jobId);
    if (!e || e.state !== "active") return { kind: "unknown", jobId };
    this.#deactivate(e);
    this.#entries.delete(jobId);
    return { kind: "finished", jobId, started: this.start() };
  }

  /** Cancels a queued or active job. A finished or unknown job is not cancellable. */
  cancel(jobId: string): CancelDecision {
    const e = this.#entries.get(jobId);
    if (!e) return { kind: "not-cancellable", jobId };
    const wasActive = e.state === "active";
    if (wasActive) this.#deactivate(e);
    this.#entries.delete(jobId);
    this.#queue = this.#queue.filter((q) => q !== jobId);
    return { kind: "cancelled", jobId, wasActive, started: this.start() };
  }
}

// ---------------------------------------------------------------------------------------------
// Six-field public log (D8-04)
// ---------------------------------------------------------------------------------------------

export const PUBLIC_LOG_FIELDS = ["ts", "level", "event", "request_id", "route", "status"] as const;
export type PublicLogField = (typeof PUBLIC_LOG_FIELDS)[number];

export interface PublicLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  request_id: string;
  /** The route template, for example `POST /api/jobs/:id/cancel`. Never a raw path or a query string. */
  route: string;
  status: number;
}

export class PublicLogError extends Error {
  override name = "PublicLogError";
  /** The field at fault. The value is never echoed. */
  constructor(readonly field: string, reason: string) {
    super(`public log: ${field} ${reason}`);
  }
}

const LOG_PATTERN: Record<Exclude<PublicLogField, "status" | "level">, RegExp> = {
  ts: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
  event: /^[a-z][a-z0-9_.-]{0,63}$/,
  request_id: /^[A-Za-z0-9_-]{8,64}$/,
  // Method, one space, then segments: a lowercase word (letters and hyphens, or v1..v99) or a `:param`. No digits in a literal
  // segment, so a raw numeric or hex identifier cannot pass as part of the template.
  route: /^[A-Z]{3,7} \/(?:(?:[a-z][a-z-]*|v\d{1,2}|:[a-z][a-z0-9_]*)(?:\/(?:[a-z][a-z-]*|v\d{1,2}|:[a-z][a-z0-9_]*))*)?$/,
};

/** One JSON line with exactly the six public fields, in order. Anything else throws and the value is never echoed. */
export function toPublicLogLine(entry: PublicLogEntry): string {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new PublicLogError("entry", "must be an object");
  const record = entry as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(PUBLIC_LOG_FIELDS as readonly string[]).includes(key)) throw new PublicLogError("(unknown field)", "is not a public log field");
  }
  for (const key of PUBLIC_LOG_FIELDS) {
    if (!Object.hasOwn(record, key)) throw new PublicLogError(key, "is missing");
  }
  const text = (key: "ts" | "event" | "request_id" | "route"): string => {
    const v = record[key];
    if (typeof v !== "string") throw new PublicLogError(key, "must be a string");
    if (v.length > 160 || !LOG_PATTERN[key].test(v)) throw new PublicLogError(key, "has a form that is not allowed");
    return v;
  };
  const level = record.level;
  if (level !== "info" && level !== "warn" && level !== "error") throw new PublicLogError("level", "has a form that is not allowed");
  const status = record.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) throw new PublicLogError("status", "must be an HTTP status");
  const ordered = { ts: text("ts"), level, event: text("event"), request_id: text("request_id"), route: text("route"), status };
  // Every value passed a strict pattern, so no CR, LF, U+2028, U+2029 or ANSI escape can be present. Escape the separators anyway.
  return JSON.stringify(ordered).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// ---------------------------------------------------------------------------------------------
// Egress decision (D8-05)
// ---------------------------------------------------------------------------------------------

export type EgressDecision = "allow" | "deny";

/** Strict dotted-quad IPv4: four decimal octets, no leading zeros. Anything else (octal, hex, short forms) is not parsed. */
function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map((p) => (p.length > 1 && p.startsWith("0") ? NaN : Number(p)));
  return octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255) ? octets : null;
}

/** IPv6 to eight 16-bit groups, or null when it is not a plain IPv6 literal (zone ids are refused). */
function parseIPv6(host: string): number[] | null {
  if (!/^[0-9a-f:.]+$/.test(host) || !host.includes(":")) return null;
  let text = host;
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (tail) {
    const v4 = parseIPv4(tail[1]!);
    if (!v4) return null;
    text = text.slice(0, -tail[1]!.length) + ((v4[0]! << 8) | v4[1]!).toString(16) + ":" + ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const side = (s: string) => (s === "" ? [] : s.split(":"));
  const head = side(halves[0]!);
  const rest = halves.length === 2 ? side(halves[1]!) : [];
  const all = [...head, ...rest];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  if (halves.length === 1) return head.length === 8 ? head.map((g) => parseInt(g, 16)) : null;
  if (head.length + rest.length > 7) return null;
  const zeros = new Array<number>(8 - head.length - rest.length).fill(0);
  return [...head.map((g) => parseInt(g, 16)), ...zeros, ...rest.map((g) => parseInt(g, 16))];
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Only loopback and exact allow-list hosts may be reached. Everything else is denied: unspecified (0.0.0.0, ::), link-local
 * and cloud-metadata ranges (169.254/16, fe80::/10), private ranges, IPv4-mapped IPv6 of a non-loopback address, short or
 * octal IPv4 forms, non-ASCII (IDN, full-width) names, names with ports, paths, userinfo or whitespace.
 * The allow-list is compared exactly (case-insensitive ASCII); there are no wildcards or suffix matches.
 */
export function decideEgress(host: string, allowlist: string[]): EgressDecision {
  if (typeof host !== "string" || host.length === 0 || host.length > 255) return "deny";
  if (!/^[\x21-\x7e]+$/.test(host)) return "deny"; // printable ASCII only: no whitespace, control or non-ASCII (IDN) characters
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  else if (h.includes("[") || h.includes("]")) return "deny";

  const v4 = parseIPv4(h);
  if (v4) return decideV4(v4, h, allowlist);
  const v6 = parseIPv6(h);
  if (v6) {
    const isZero = v6.every((g) => g === 0);
    if (isZero) return "deny";
    if (v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1) return "allow";
    const mapped = v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff;
    if (mapped) {
      const dotted = [v6[6]! >> 8, v6[6]! & 255, v6[7]! >> 8, v6[7]! & 255];
      return decideV4(dotted, dotted.join("."), []);
    }
    if ((v6[0]! & 0xffc0) === 0xfe80) return "deny";
    return allowlistHas(h, allowlist) ? "allow" : "deny";
  }
  if (h === "localhost") return "allow";
  if (!HOSTNAME.test(h)) return "deny";
  // an all-numeric or dotted-number name that is not a strict quad (2130706433, 127.1, 0x7f.1) is an IP spelling, never a name
  if (/^[0-9.x]+$/.test(h)) return "deny";
  return allowlistHas(h, allowlist) ? "allow" : "deny";
}

function decideV4(o: number[], text: string, allowlist: string[]): EgressDecision {
  if (o[0] === 127) return "allow";
  if (o[0] === 0) return "deny";
  if (o[0] === 169 && o[1] === 254) return "deny";
  return allowlistHas(text, allowlist) ? "allow" : "deny";
}

function allowlistHas(host: string, allowlist: string[]): boolean {
  return allowlist.some((a) => typeof a === "string" && a.length > 0 && a.toLowerCase() === host);
}

// ---------------------------------------------------------------------------------------------
// New server actions (to join the Cycle 7 role matrix)
// ---------------------------------------------------------------------------------------------

export const C8_ACTIONS = {
  /** The submitter (ACT-01, same `sub`) may cancel its own jobs; ADMIN may cancel any job. */
  "job:cancel": { roles: ["ACT-01", "ADMIN"], ownJobsOnly: ["ACT-01"] },
  /** Counters only, never values. */
  "metrics:read": { roles: ["ADMIN", "AUDITOR"], ownJobsOnly: [] },
} as const satisfies Record<string, { roles: readonly string[]; ownJobsOnly: readonly string[] }>;

export type C8Action = keyof typeof C8_ACTIONS;

export function mayCancelJob(role: string, callerSub: string, jobOwnerSub: string): boolean {
  const rule = C8_ACTIONS["job:cancel"];
  if (!(rule.roles as readonly string[]).includes(role)) return false;
  if ((rule.ownJobsOnly as readonly string[]).includes(role)) return callerSub === jobOwnerSub;
  return true;
}
