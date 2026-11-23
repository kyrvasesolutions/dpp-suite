// @vitest-environment node
/**
 * Layer 2 pre-implementation deterministic contract simulator for Cycle 8 (P05 + P06), decision D8-07.
 *
 * Calibrated against the pinned OPERATIONAL-LIMITS@1.0.0 of the real pack (`contracts/n`), then simulates:
 * 1. Every budget at limit and limit+1: OVER_LIMIT with no partial success (C8-02).
 * 2. The job deadline: TIMEOUT, with promotion revoked so a commit after the deadline throws.
 * 3. Cooperative cancellation within the poll bound, idempotent cancel, no cancel after commit.
 * 4. The job coordinator: per-domain slots, FIFO queue, global cap, queue_full, domain isolation.
 * 5. The egress decision table (D8-05).
 * 6. The six-field public log builder (D8-04).
 * 7. Drop-one-input checks: each required OPERATIONAL-LIMITS field breaks the pack load at the loader.
 * 8. The limit-code classification table.
 */
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { readPack } from "../../config/contractPack";
import {
  C8_ACTIONS,
  CancellationToken,
  JobBudget,
  JobCoordinatorModel,
  LIMIT_NAMES,
  LIMIT_OUTCOMES,
  LimitError,
  PUBLIC_LOG_FIELDS,
  PublicLogError,
  classifyLimitOutcome,
  coordinatorConfigFrom,
  decideEgress,
  mayCancelJob,
  toPublicLogLine,
  type LimitName,
  type OperationalLimits,
  type PublicLogEntry,
} from "../../src/model/c8Contracts";
import { ERROR_TEXT } from "../../src/model/ingress";
import { ProfileError, loadProfilePack } from "../../src/model/profile";
import { JsonSyntaxError, parseStrictJson } from "../../src/model/strictJson";
import { ROLE_ACTION_MATRIX, SERVER_ROLES } from "../../src/model/c7Contracts";
import { loadPack } from "../support/records";

let L: OperationalLimits;
beforeAll(async () => {
  L = (await loadPack()).operationalLimits;
});

// ---------------------------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------------------------

describe("calibration: the pinned pack carries the D8-01 values", () => {
  it("execution values are the S4 values", () => {
    expect(L.execution).toEqual({
      source_file_max_bytes: 10485760,
      source_pair_max_bytes: 20971520,
      max_nesting_depth: 12,
      max_records_per_job: 1,
      job_deadline_ms: 30000,
      max_parser_nodes_per_job: 100000,
      max_output_bytes_per_route: 10485760,
      total_staging_max_bytes: 67108864,
      execution_memory_max_bytes: 536870912,
      cancellation_poll_max_ms: 100,
      retry_count: 0,
    });
  });
  it("coordinator, http and target values are the design values", () => {
    expect(L.coordinator).toEqual({
      max_active_jobs_per_security_domain: 2,
      max_queued_jobs_per_security_domain: 8,
      max_active_jobs_total: 4,
      retry_after_seconds: 2,
    });
    expect(L.http).toEqual({
      headers_timeout_ms: 10000,
      request_timeout_ms: 60000,
      keep_alive_timeout_ms: 5000,
      max_connections: 256,
      max_request_body_bytes: 31457280,
      rate_limit_window_ms: 60000,
      rate_limit_read_per_window: 600,
      rate_limit_write_per_window: 120,
    });
    expect(L.targets).toEqual({
      import_job_p95_ms: 5000,
      read_p95_ms: 500,
      concurrent_clients: 16,
      volume_committed_batches: 1000,
      max_server_errors: 0,
      max_rss_bytes: 536870912,
    });
  });
  it("the pair cap holds two source files, the request cap holds a pair, and staging holds more than a pair", () => {
    expect(L.execution.source_pair_max_bytes).toBe(2 * L.execution.source_file_max_bytes);
    expect(L.http.max_request_body_bytes).toBeGreaterThan(L.execution.source_pair_max_bytes);
    expect(L.execution.total_staging_max_bytes).toBeGreaterThan(L.execution.source_pair_max_bytes);
    expect(L.http.request_timeout_ms).toBeGreaterThan(L.http.headers_timeout_ms);
  });
});

// ---------------------------------------------------------------------------------------------
// 1. Budget boundaries: OVER_LIMIT at limit+1, nothing promoted
// ---------------------------------------------------------------------------------------------

interface StagedRow {
  recordId: string;
  provenance: string[];
  bytes: number;
}

/** A job reduced to what the limits touch: it stages rows with provenance, then promotes them all or none. */
function runJob(rows: StagedRow[], checks: Array<{ name: LimitName; code: string; value: number; limit: number }>) {
  const staged: StagedRow[] = [];
  const promoted: StagedRow[] = [];
  let error: LimitError | null = null;
  try {
    for (const row of rows) staged.push(row);
    for (const c of checks) {
      if (c.value > c.limit) throw new LimitError("OVER_LIMIT", c.name, c.code);
    }
    promoted.push(...staged);
  } catch (e) {
    if (!(e instanceof LimitError)) throw e;
    error = e;
    staged.length = 0; // rollback
  }
  return { staged, promoted, error };
}

const rowsOf = (n: number, bytes = 1): StagedRow[] =>
  Array.from({ length: n }, (_, i) => ({ recordId: `REC-${i}`, provenance: [`src-erp#${i}`, `src-lab#${i}`], bytes }));

describe("1. budgets: exactly OVER_LIMIT at limit+1, with no partial success", () => {
  const table = () =>
    [
      { name: "source_file_max_bytes", code: "too-large", limit: L.execution.source_file_max_bytes },
      { name: "source_pair_max_bytes", code: "too-large", limit: L.execution.source_pair_max_bytes },
      { name: "max_records_per_job", code: "multiple-records", limit: L.execution.max_records_per_job },
      { name: "max_output_bytes_per_route", code: "too-large", limit: L.execution.max_output_bytes_per_route },
      { name: "total_staging_max_bytes", code: "too-large", limit: L.execution.total_staging_max_bytes },
      { name: "max_request_body_bytes", code: "too-large", limit: L.http.max_request_body_bytes },
    ] as const;

  it("passes at the limit and promotes every staged row", () => {
    for (const t of table()) {
      const result = runJob(rowsOf(3), [{ name: t.name, code: t.code, value: t.limit, limit: t.limit }]);
      expect(result.error, t.name).toBeNull();
      expect(result.promoted, t.name).toHaveLength(3);
    }
  });

  it("refuses at limit+1 with OVER_LIMIT naming the limit, and promotes nothing", () => {
    for (const t of table()) {
      const rows = rowsOf(3);
      const result = runJob(rows, [{ name: t.name, code: t.code, value: t.limit + 1, limit: t.limit }]);
      expect(result.error, t.name).toBeInstanceOf(LimitError);
      expect(result.error!.outcome, t.name).toBe("OVER_LIMIT");
      expect(result.error!.limit, t.name).toBe(t.name);
      expect(classifyLimitOutcome(result.error!.code), t.name).toBe("OVER_LIMIT");
      expect(result.promoted, t.name).toEqual([]);
      expect(result.staged, t.name).toEqual([]);
      // the message is fixed text: no value, no record id, no provenance
      expect(result.error!.message).not.toMatch(/REC-|src-erp|\d{4,}/);
    }
  });

  it("every listed budget name is a known LimitName", () => {
    for (const t of table()) expect(LIMIT_NAMES).toContain(t.name);
  });

  it("nesting depth: the real strict parser accepts exactly max_nesting_depth levels and refuses one more", () => {
    const nested = (n: number) => "[".repeat(n) + "]".repeat(n);
    const max = L.execution.max_nesting_depth;
    expect(() => parseStrictJson(nested(max), { maxDepth: max })).not.toThrow();
    let caught: unknown;
    try {
      parseStrictJson(nested(max + 1), { maxDepth: max });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JsonSyntaxError);
    expect((caught as JsonSyntaxError).code).toBe("too-deep");
    expect(classifyLimitOutcome((caught as JsonSyntaxError).code)).toBe("OVER_LIMIT");
  });

  it("parser nodes: exactly max_parser_nodes_per_job values pass, one more is too-many-nodes", () => {
    const max = L.execution.max_parser_nodes_per_job;
    // the array itself is one node, so max-1 numbers make exactly max nodes
    const doc = (numbers: number) => `[${Array.from({ length: numbers }, () => "1").join(",")}]`;
    expect(() => parseStrictJson(doc(max - 1), { maxNodes: max })).not.toThrow();
    let caught: unknown;
    try {
      parseStrictJson(doc(max), { maxNodes: max });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JsonSyntaxError);
    expect((caught as JsonSyntaxError).code).toBe("too-many-nodes");
    expect((caught as JsonSyntaxError).message).not.toMatch(/\b1,1\b/);
    expect(classifyLimitOutcome("too-many-nodes")).toBe("OVER_LIMIT");
  });

  it("parser nodes: strings, keys' values, booleans and null count, and nesting does not hide them", () => {
    expect(() => parseStrictJson('{"a":[1,"x",true,null]}', { maxNodes: 6 })).not.toThrow(); // object + array + 4 values
    expect(() => parseStrictJson('{"a":[1,"x",true,null]}', { maxNodes: 5 })).toThrow(JsonSyntaxError);
    expect(() => parseStrictJson("1", { maxNodes: 1 })).not.toThrow();
    expect(() => parseStrictJson("1", { maxNodes: 0 })).toThrow(JsonSyntaxError);
    expect(() => parseStrictJson("[" + "[],".repeat(9) + "[]]", { maxNodes: 11 })).not.toThrow();
    expect(() => parseStrictJson("[" + "[],".repeat(9) + "[]]", { maxNodes: 10 })).toThrow(JsonSyntaxError);
  });

  it("without maxNodes the parser is unchanged", () => {
    expect(() => parseStrictJson("[" + "1,".repeat(200000) + "1]")).not.toThrow();
  });

  it("the ingress error texts for the new codes never echo input", () => {
    for (const code of ["too-many-nodes", "cancelled"] as const) {
      expect(ERROR_TEXT[code].length).toBeGreaterThan(10);
      expect(ERROR_TEXT[code]).not.toMatch(/\{|\}|"/);
    }
  });

  it("queue_full, rate_window and max_connections are limits that return OVER_LIMIT, not a timeout or a cancel", () => {
    for (const code of ["queue-full", "rate-limited"]) expect(classifyLimitOutcome(code)).toBe("OVER_LIMIT");
    expect(LIMIT_NAMES).toEqual(expect.arrayContaining(["queue_full", "rate_window", "max_connections"]));
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Deadline: TIMEOUT and revoked promotion
// ---------------------------------------------------------------------------------------------

describe("2. the job deadline produces TIMEOUT and a late commit throws", () => {
  const make = () => {
    const clock = { t: 1_000 };
    const budget = new JobBudget({ deadlineMs: L.execution.job_deadline_ms, now: () => clock.t });
    return { clock, budget };
  };

  it("passes up to the deadline and throws TIMEOUT one millisecond after", () => {
    const { clock, budget } = make();
    clock.t = 1_000 + L.execution.job_deadline_ms - 1;
    expect(() => budget.check("parse")).not.toThrow();
    clock.t = 1_000 + L.execution.job_deadline_ms;
    expect(() => budget.check("parse")).not.toThrow();
    clock.t = 1_000 + L.execution.job_deadline_ms + 1;
    let caught: unknown;
    try {
      budget.check("semantics");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LimitError);
    const err = caught as LimitError;
    expect([err.outcome, err.limit, err.code, err.stage]).toEqual(["TIMEOUT", "job_deadline_ms", "deadline", "semantics"]);
    expect(classifyLimitOutcome(err.code)).toBe("TIMEOUT");
    expect(budget.promotionRevoked).toBe(true);
  });

  it("work that finished just before the deadline still cannot commit after it", () => {
    const { clock, budget } = make();
    clock.t = 1_000 + L.execution.job_deadline_ms - 1;
    budget.check("route"); // the last stage boundary passes
    const promoted: string[] = [];
    clock.t = 1_000 + L.execution.job_deadline_ms + 5; // the commit is reached late
    expect(() => {
      budget.assertMayCommit();
      promoted.push("REC-0");
    }).toThrow(LimitError);
    expect(promoted).toEqual([]);
    expect(() => budget.markCommitted()).toThrow(LimitError);
    expect(budget.committed).toBe(false);
  });

  it("a commit at or before the deadline is allowed and marks the job committed", () => {
    const { clock, budget } = make();
    clock.t = 1_000 + L.execution.job_deadline_ms;
    expect(() => budget.assertMayCommit()).not.toThrow();
    budget.markCommitted();
    expect(budget.committed).toBe(true);
  });

  it("revokePromotion alone blocks a later commit, even with time to spare", () => {
    const { budget } = make();
    budget.revokePromotion("TIMEOUT");
    let caught: unknown;
    try {
      budget.assertMayCommit();
    } catch (e) {
      caught = e;
    }
    expect((caught as LimitError).outcome).toBe("TIMEOUT");
    expect(budget.promotionRevoked).toBe(true);
  });

  it("the revocation is permanent: a clock that moves backwards cannot restore it", () => {
    const { clock, budget } = make();
    clock.t = 1_000 + L.execution.job_deadline_ms + 10;
    expect(() => budget.check("bytes")).toThrow(LimitError);
    clock.t = 1_000;
    expect(() => budget.assertMayCommit()).toThrow(LimitError);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Cancellation
// ---------------------------------------------------------------------------------------------

describe("3. cooperative cancellation", () => {
  it("is seen within cancellation_poll_max_ms of simulated ticks, for every cancel time", () => {
    const poll = L.execution.cancellation_poll_max_ms;
    for (let cancelAt = 0; cancelAt <= 1_000; cancelAt += 7) {
      const clock = { t: 0 };
      const budget = new JobBudget({ deadlineMs: L.execution.job_deadline_ms, now: () => clock.t });
      let seenAt: number | null = null;
      // the worker polls the token every `poll` ms (its worst case), the submitter cancels at cancelAt
      for (let t = 0; t <= 2_000 && seenAt === null; t++) {
        clock.t = t;
        if (t === cancelAt) expect(budget.cancel("operator asked")).toBe("cancelled");
        if (t % poll === 0) {
          try {
            budget.check("parse");
          } catch (e) {
            expect((e as LimitError).outcome).toBe("CANCELLED");
            seenAt = t;
          }
        }
      }
      expect(seenAt, `cancel at ${cancelAt}`).not.toBeNull();
      expect(seenAt! - cancelAt, `cancel at ${cancelAt}`).toBeLessThanOrEqual(poll);
    }
  });

  it("a cancelled job ends CANCELLED with nothing promoted and promotion revoked", () => {
    const budget = new JobBudget({ deadlineMs: 30_000, now: () => 0 });
    const promoted: StagedRow[] = [];
    const staged = rowsOf(2);
    budget.cancel("duplicate submission");
    try {
      budget.check("semantics");
      promoted.push(...staged);
    } catch (e) {
      expect((e as LimitError).outcome).toBe("CANCELLED");
      expect((e as LimitError).limit).toBe("cancellation");
      expect(classifyLimitOutcome((e as LimitError).code)).toBe("CANCELLED");
      // the reason stays out of the error
      expect((e as LimitError).message).not.toContain("duplicate");
    }
    expect(promoted).toEqual([]);
    expect(() => budget.assertMayCommit()).toThrow(LimitError);
  });

  it("is idempotent: the second cancel changes nothing and the first reason is kept", () => {
    const token = new CancellationToken();
    expect(token.isCancelled).toBe(false);
    expect(token.cancel("first")).toBe(true);
    expect(token.cancel("second")).toBe(false);
    expect(token.isCancelled).toBe(true);
    expect(token.reason).toBe("first");
    expect(() => token.throwIfCancelled("route")).toThrow(LimitError);
    const budget = new JobBudget({ deadlineMs: 1000, now: () => 0, token: new CancellationToken() });
    expect(budget.cancel("a")).toBe("cancelled");
    expect(budget.cancel("b")).toBe("already-cancelled");
  });

  it("an uncancelled token never throws", () => {
    expect(() => new CancellationToken().throwIfCancelled()).not.toThrow();
  });

  it("cancel after commit is not-cancellable and leaves the token untouched", () => {
    const budget = new JobBudget({ deadlineMs: 30_000, now: () => 0 });
    budget.markCommitted();
    expect(budget.cancel("too late")).toBe("not-cancellable");
    expect(budget.token.isCancelled).toBe(false);
    expect(() => budget.assertMayCommit()).not.toThrow();
  });

  it("cancel wins over a later deadline: the first stop is the one that is reported", () => {
    const clock = { t: 0 };
    const budget = new JobBudget({ deadlineMs: 100, now: () => clock.t });
    budget.cancel("stop");
    clock.t = 500;
    expect(() => budget.check("bytes")).toThrow(expect.objectContaining({ outcome: "CANCELLED" }));
  });

  it("only the submitter (ACT-01, same sub) or ADMIN may cancel; AUDITOR and others may not", () => {
    expect(mayCancelJob("ACT-01", "u1", "u1")).toBe(true);
    expect(mayCancelJob("ACT-01", "u2", "u1")).toBe(false);
    expect(mayCancelJob("ADMIN", "a1", "u1")).toBe(true);
    for (const role of ["ACT-06", "CURATOR", "AUDITOR", "NOBODY"]) expect(mayCancelJob(role, "u1", "u1"), role).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Coordinator
// ---------------------------------------------------------------------------------------------

describe("4. job coordinator", () => {
  const make = () => new JobCoordinatorModel(coordinatorConfigFrom(L));

  it("calibrates to 2 active per domain, 8 queued per domain, 4 active in total", () => {
    expect(make().config).toEqual({ maxActivePerDomain: 2, maxQueuedPerDomain: 8, maxActiveTotal: 4, retryAfterSeconds: 2 });
  });

  it("starts two jobs per domain, queues eight, and refuses the next with OVER_LIMIT queue_full and Retry-After", () => {
    const c = make();
    expect(c.admit("a1", "A").kind).toBe("started");
    expect(c.admit("a2", "A").kind).toBe("started");
    for (let i = 3; i <= 10; i++) {
      const d = c.admit(`a${i}`, "A");
      expect(d, `a${i}`).toEqual({ kind: "queued", jobId: `a${i}`, position: i - 2 });
    }
    const refused = c.admit("a11", "A");
    expect(refused).toEqual({ kind: "rejected", outcome: "OVER_LIMIT", limit: "queue_full", code: "queue-full", retryAfterSeconds: 2 });
    expect(classifyLimitOutcome(refused.kind === "rejected" ? refused.code : "")).toBe("OVER_LIMIT");
    expect(LIMIT_NAMES).toContain("queue_full");
    expect(c.stateOf("a11")).toBe("unknown"); // a refused job is not tracked
    expect(c.activeCount("A")).toBe(2);
    expect(c.queuedCount("A")).toBe(8);
  });

  it("is FIFO: finishing a job starts the oldest waiting job of its domain", () => {
    const c = make();
    c.admit("a1", "A");
    c.admit("a2", "A");
    c.admit("a3", "A");
    c.admit("a4", "A");
    c.admit("a5", "A");
    expect(c.queuedIds()).toEqual(["a3", "a4", "a5"]);
    expect(c.finish("a1")).toEqual({ kind: "finished", jobId: "a1", started: ["a3"] });
    expect(c.finish("a2")).toEqual({ kind: "finished", jobId: "a2", started: ["a4"] });
    expect(c.queuedIds()).toEqual(["a5"]);
    expect(c.finish("a3").kind).toBe("finished");
    expect(c.stateOf("a5")).toBe("active");
  });

  it("isolates domains: a full domain A does not block domain B until the global cap", () => {
    const c = make();
    for (let i = 1; i <= 10; i++) c.admit(`a${i}`, "A"); // 2 active, 8 queued
    expect(c.admit("b1", "B").kind).toBe("started");
    expect(c.admit("b2", "B").kind).toBe("started");
    expect(c.activeCount()).toBe(4); // the global cap is reached
    expect(c.admit("b3", "B")).toEqual({ kind: "queued", jobId: "b3", position: 9 });
    expect(c.admit("c1", "C")).toEqual({ kind: "queued", jobId: "c1", position: 10 });
    expect(c.activeCount("C")).toBe(0);
    // domain C's job only waits for the global cap, not for A or B
    expect(c.finish("b1")).toEqual({ kind: "finished", jobId: "b1", started: ["b3"] });
    expect(c.finish("b2").kind).toBe("finished");
    // a1 and a2 still hold A's slots, so the next in arrival order that fits is c1 (a3 is blocked by A's cap)
    expect(c.stateOf("c1")).toBe("active");
    expect(c.stateOf("a3")).toBe("queued");
  });

  it("never exceeds the caps over a deterministic random workload, and every admitted job is eventually run once", () => {
    const c = make();
    let seed = 20261123;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const domains = ["A", "B", "C", "D"];
    const admitted = new Set<string>();
    const ran: string[] = [];
    let n = 0;
    for (let step = 0; step < 2_000; step++) {
      const r = rnd();
      if (r < 0.5) {
        const id = `j${n++}`;
        const d = c.admit(id, domains[Math.floor(rnd() * domains.length)]!);
        if (d.kind !== "rejected") admitted.add(id);
        if (d.kind === "started") ran.push(id);
      } else {
        const activeIds = [...admitted].filter((id) => c.stateOf(id) === "active");
        if (activeIds.length) {
          const id = activeIds[Math.floor(rnd() * activeIds.length)]!;
          const out = r < 0.9 ? c.finish(id) : c.cancel(id);
          ran.push(...(out.kind === "finished" || out.kind === "cancelled" ? out.started : []));
        }
      }
      expect(c.activeCount()).toBeLessThanOrEqual(4);
      for (const d of domains) {
        expect(c.activeCount(d)).toBeLessThanOrEqual(2);
        expect(c.queuedCount(d)).toBeLessThanOrEqual(8);
      }
    }
    expect(new Set(ran).size).toBe(ran.length); // nothing started twice
  });

  it("cancel of a queued job frees its queue place without starting anything", () => {
    const c = make();
    for (const id of ["a1", "a2", "a3", "a4"]) c.admit(id, "A");
    expect(c.cancel("a4")).toEqual({ kind: "cancelled", jobId: "a4", wasActive: false, started: [] });
    expect(c.queuedIds()).toEqual(["a3"]);
  });

  it("cancel of an active job frees the slot and starts the next waiting job", () => {
    const c = make();
    for (const id of ["a1", "a2", "a3"]) c.admit(id, "A");
    expect(c.cancel("a1")).toEqual({ kind: "cancelled", jobId: "a1", wasActive: true, started: ["a3"] });
    expect(c.activeCount("A")).toBe(2);
  });

  it("a full queue admits again once a place is freed", () => {
    const c = make();
    for (let i = 1; i <= 10; i++) c.admit(`a${i}`, "A");
    expect(c.admit("x", "A").kind).toBe("rejected");
    c.finish("a1"); // a3 starts, one queue place frees
    expect(c.admit("x", "A")).toEqual({ kind: "queued", jobId: "x", position: 8 });
    expect(c.admit("y", "A").kind).toBe("rejected");
  });

  it("finish and cancel are not repeatable: a finished, cancelled or unknown job is not cancellable", () => {
    const c = make();
    c.admit("a1", "A");
    expect(c.finish("a1").kind).toBe("finished");
    expect(c.finish("a1").kind).toBe("unknown");
    expect(c.cancel("a1")).toEqual({ kind: "not-cancellable", jobId: "a1" });
    c.admit("a2", "A");
    expect(c.cancel("a2").kind).toBe("cancelled");
    expect(c.cancel("a2").kind).toBe("not-cancellable");
    expect(c.cancel("nope").kind).toBe("not-cancellable");
  });

  it("memory stays bounded: 10 000 admit and finish cycles leave nothing behind, and ids can be reused", () => {
    const c = make();
    for (let i = 0; i < 10_000; i++) {
      const d = i % 2 ? "A" : "B";
      expect(c.admit(`j${i}`, d).kind).toBe("started");
      if (i % 3 === 0) expect(c.cancel(`j${i}`).kind).toBe("cancelled");
      else expect(c.finish(`j${i}`).kind).toBe("finished");
    }
    expect(c.size).toBe(0);
    expect(c.activeCount()).toBe(0);
    expect(c.admit("j1", "A").kind).toBe("started"); // a finished id is gone, not remembered
    expect(c.size).toBe(1);
  });

  it("refuses a reused job id", () => {
    const c = make();
    c.admit("a1", "A");
    expect(() => c.admit("a1", "B")).toThrow();
  });

  it("the new server actions map to the intended roles, and every other Cycle 7 grant is untouched", () => {
    expect(C8_ACTIONS["job:cancel"].roles).toEqual(["ACT-01", "ADMIN"]);
    expect(C8_ACTIONS["metrics:read"].roles).toEqual(["ADMIN", "AUDITOR"]);
    // Cycle 8 (Layer 3) joined the two actions to the real matrix: exactly the roles above hold them, no other role does.
    for (const role of SERVER_ROLES) {
      const actions = ROLE_ACTION_MATRIX[role] as readonly string[];
      expect(actions.includes("job:cancel"), role).toBe((C8_ACTIONS["job:cancel"].roles as readonly string[]).includes(role));
      expect(actions.includes("metrics:read"), role).toBe((C8_ACTIONS["metrics:read"].roles as readonly string[]).includes(role));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Egress
// ---------------------------------------------------------------------------------------------

describe("5. egress decision", () => {
  const allow = ["api.example.org", "Svc.Internal.Example"];

  it("allows loopback in every spelling that is strictly loopback", () => {
    for (const h of ["127.0.0.1", "127.255.255.254", "127.1.2.3", "::1", "[::1]", "0:0:0:0:0:0:0:1", "localhost", "LOCALHOST", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      expect(decideEgress(h, []), h).toBe("allow");
    }
  });

  it("allows exactly the allow-listed hosts, ignoring ASCII case, and nothing near them", () => {
    expect(decideEgress("api.example.org", allow)).toBe("allow");
    expect(decideEgress("API.EXAMPLE.ORG", allow)).toBe("allow");
    expect(decideEgress("svc.internal.example", allow)).toBe("allow");
    for (const h of ["example.org", "x.api.example.org", "api.example.org.evil.test", "api.example.org.", "api-example.org", "api.example.org:443", "api.example.org/x", "user@api.example.org", "apiXexample.org"]) {
      expect(decideEgress(h, allow), h).toBe("deny");
    }
  });

  it("denies everything when the allow-list is empty, apart from loopback", () => {
    for (const h of ["api.example.org", "example.com", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "metadata.google.internal"]) {
      expect(decideEgress(h, []), h).toBe("deny");
    }
  });

  it("denies unspecified, link-local, metadata, private and mapped non-loopback addresses", () => {
    for (const h of [
      "0.0.0.0",
      "0.1.2.3",
      "::",
      "[::]",
      "169.254.169.254",
      "169.254.0.1",
      "fe80::1",
      "fe80::a00:27ff:fe4e:66a1",
      "10.0.0.1",
      "192.168.1.1",
      "172.16.0.1",
      "::ffff:10.0.0.1",
      "::ffff:8.8.8.8",
      "::ffff:a9fe:a9fe",
      "::ffff:0.0.0.0",
      "255.255.255.255",
    ]) {
      expect(decideEgress(h, []), h).toBe("deny");
    }
  });

  it("denies unspecified and link-local hosts even when they are on the allow-list", () => {
    for (const h of ["0.0.0.0", "169.254.169.254", "::", "fe80::1"]) expect(decideEgress(h, [h]), h).toBe("deny");
  });

  it("denies every non-canonical IPv4 spelling of loopback", () => {
    for (const h of ["127.1", "127.0.1", "2130706433", "0x7f.0.0.1", "0x7f000001", "0177.0.0.1", "127.000.000.001", "127.0.0.1.", "127.0.0.256", "1.2.3", "01.2.3.4", "localhost."]) {
      expect(decideEgress(h, []), h).toBe("deny");
    }
  });

  it("denies IDN and look-alike tricks", () => {
    for (const h of [
      "ｌｏｃａｌｈｏｓｔ", // full-width
      "ⅼocalhost", // Unicode small roman numeral l
      "localhоst", // Cyrillic o
      "１２７.０.０.１", // full-width digits
      "127。0。0。1",
      "xn--localhost-9ff",
      "localhost​",
      "api.example.org​",
      "аpi.example.org", // Cyrillic a
    ]) {
      expect(decideEgress(h, h.includes("example") ? allow : []), h).toBe("deny");
    }
    expect(decideEgress("exämple.org", ["exämple.org"])).toBe("deny"); // non-ASCII is never allowed, even when listed
  });

  it("denies hosts with ports, paths, userinfo, whitespace, control characters or empty names", () => {
    for (const h of ["localhost:8080", "127.0.0.1:80", "localhost/", "localhost\n", "local host", "127.0.0.1\u0000", "\t127.0.0.1", "http://127.0.0.1", "@localhost", "localhost@evil.test", "[::1", "::1]", "", " "]) {
      expect(decideEgress(h, [h]), JSON.stringify(h)).toBe("deny");
    }
  });

  it("does not accept a wildcard or suffix entry as a pattern", () => {
    expect(decideEgress("a.example.org", ["*.example.org"])).toBe("deny");
    expect(decideEgress("a.example.org", ["example.org"])).toBe("deny");
    expect(decideEgress("anything.test", ["*"])).toBe("deny");
  });

  it("is total: it never throws on hostile input", () => {
    const hostile = ["\u0000", "%00", "..", "...", "a..b", "-a.test", "a-.test", "a".repeat(300), "[".repeat(5), "::::", ":::1", "1::2::3", "::g", "ffff::1.2.3", "1.2.3.4.5", "999.1.1.1", "::1%eth0", "fe80::1%25eth0"];
    for (const h of hostile) expect(["allow", "deny"]).toContain(decideEgress(h, [h]));
    for (const h of hostile.slice(0, 10)) expect(decideEgress(h, []), h).toBe("deny");
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Public log
// ---------------------------------------------------------------------------------------------

describe("6. the six-field public log", () => {
  const good: PublicLogEntry = {
    ts: "2026-11-23T10:15:30.123Z",
    level: "info",
    event: "request",
    request_id: "req_7f3a9c1e2b",
    route: "POST /api/jobs/:id/cancel",
    status: 200,
  };

  it("the field list is exactly the six fields in the decided order", () => {
    expect([...PUBLIC_LOG_FIELDS]).toEqual(["ts", "level", "event", "request_id", "route", "status"]);
  });

  it("emits exactly those keys in that order, as one line that round-trips", () => {
    const shuffled = { status: 200, route: good.route, request_id: good.request_id, event: good.event, level: good.level, ts: good.ts } as PublicLogEntry;
    const line = toPublicLogLine(shuffled);
    expect(line.includes("\n") || line.includes("\r")).toBe(false);
    expect(Object.keys(JSON.parse(line))).toEqual([...PUBLIC_LOG_FIELDS]);
    expect(JSON.parse(line)).toEqual(good);
  });

  it("accepts the route templates of the server API and refuses raw paths", () => {
    for (const route of ["GET /", "GET /api/health", "POST /api/jobs/:id/cancel", "GET /api/admin/metrics", "GET /api/v1/records/:record_id", "PUT /api/config/packages/:id/approve"]) {
      expect(() => toPublicLogLine({ ...good, route }), route).not.toThrow();
    }
    for (const route of [
      "GET /api/jobs/3f2a9c1e-0000-4000-8000-000000000001",
      "GET /api/records/12345",
      "GET /api/records/REC-7",
      "GET /api/jobs?id=1",
      "GET /api/jobs?token=abc",
      "GET /api/jobs#frag",
      "GET /files/secret.pdf",
      "GET /api/../etc/passwd",
      "GET /api//jobs",
      "GET api/jobs",
      "get /api/jobs",
      "/api/jobs",
      "GET  /api/jobs",
      "GET /api/jobs ",
      "GET /api/jobs\n",
      "GET /api/jobs\r\nX: y",
      "GET /api/%6a%6fbs",
      "GET /api/jobs;x=1",
      "GET /api/jobs/:1",
      "GET /api/Jobs",
      "",
    ]) {
      expect(() => toPublicLogLine({ ...good, route }), JSON.stringify(route)).toThrow(PublicLogError);
    }
  });

  it("rejects extra fields and missing fields, naming the field without echoing a value", () => {
    expect(() => toPublicLogLine({ ...good, user: "alice" } as unknown as PublicLogEntry)).toThrow(PublicLogError);
    expect(() => toPublicLogLine({ ...good, path: "/api/jobs/1" } as unknown as PublicLogEntry)).toThrow(PublicLogError);
    expect(() => toPublicLogLine({ ...good, __proto__: { x: 1 }, constructor: 1 } as unknown as PublicLogEntry)).toThrow(PublicLogError);
    for (const key of PUBLIC_LOG_FIELDS) {
      const partial: Record<string, unknown> = { ...good };
      delete partial[key];
      expect(() => toPublicLogLine(partial as unknown as PublicLogEntry), key).toThrow(new RegExp(key));
    }
    try {
      toPublicLogLine({ ...good, route: "GET /api/jobs?secret=SUPERSECRET" });
    } catch (e) {
      expect((e as Error).message).not.toContain("SUPERSECRET");
      expect((e as PublicLogError).field).toBe("route");
    }
    try {
      toPublicLogLine({ ...good, secretField: "LEAK" } as unknown as PublicLogEntry);
    } catch (e) {
      expect((e as Error).message).not.toContain("secretField");
    }
  });

  it("rejects bad levels, statuses, timestamps, events and request ids", () => {
    const bad: Array<Partial<Record<keyof PublicLogEntry, unknown>>> = [
      { level: "debug" },
      { level: "INFO" },
      { level: 1 },
      { status: 99 },
      { status: 600 },
      { status: 200.5 },
      { status: "200" },
      { status: NaN },
      { ts: "2026-11-23" },
      { ts: "2026-11-23T10:15:30+01:00" },
      { ts: "now" },
      { event: "" },
      { event: "Request" },
      { event: "a b" },
      { event: "x".repeat(65) },
      { request_id: "short" },
      { request_id: "has space in it" },
      { request_id: "x".repeat(65) },
      { request_id: "id\nforged: line" },
    ];
    for (const patch of bad) expect(() => toPublicLogLine({ ...good, ...patch } as PublicLogEntry), JSON.stringify(patch)).toThrow(PublicLogError);
  });

  const HOSTILE = [
    "line1\nline2",
    "line1\rline2",
    "line1\r\nline2",
    "a\u2028b",
    "a\u2029b",
    "\u001b[31mred\u001b[0m",
    "\u001b]0;title\u0007",
    "\u009b31m",
    "a\u0000b",
    "a\u0085b",
    "a\u000bb",
    "a\u000cb",
    '{"injected":true}',
    '","level":"error","x":"',
    "\\n",
    "%0d%0a",
    "‮evil",
    "ünïcode",
    "😀",
    "../../etc/passwd",
    "'; DROP TABLE jobs;--",
    "<script>alert(1)</script>",
    "${jndi:ldap://x}",
    "a".repeat(10_000),
  ];

  it("never lets CR, LF, U+2028/9 or ANSI through in any field, for any hostile string", () => {
    const fields = ["ts", "event", "request_id", "route"] as const;
    for (const field of fields) {
      for (const hostile of HOSTILE) {
        for (const wrap of [hostile, `GET /api/${hostile}`, `${good[field]}${hostile}`, `${hostile}${good[field]}`]) {
          try {
            const line = toPublicLogLine({ ...good, [field]: wrap });
            // anything that did pass must be a single clean line that round-trips
            expect(line).not.toMatch(/[\r\n\u2028\u2029\u001b\u009b\u0000\u0085\u000b\u000c]/);
            expect(JSON.parse(line)[field]).toBe(wrap);
          } catch (e) {
            expect(e).toBeInstanceOf(PublicLogError);
          }
        }
      }
    }
  });

  it("fuzz: random strings in every field either throw PublicLogError or give a single line that round-trips", () => {
    let seed = 8;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const alphabet = ["a", "Z", "0", "9", "-", "_", ":", "/", " ", ".", "?", "=", "\n", "\r", "\u2028", "\u2029", "\u001b", "[", "\"", "\\", "\u0000", "é", "😀", "T", "GET", "POST /api/jobs"];
    const rnd1 = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
    const make = () => Array.from({ length: Math.floor(rnd() * 24) }, () => rnd1(alphabet)).join("");
    let passed = 0;
    for (let i = 0; i < 6_000; i++) {
      const entry = {
        ts: rnd() < 0.5 ? good.ts : make(),
        level: rnd() < 0.8 ? good.level : make(),
        event: rnd() < 0.5 ? good.event : make(),
        request_id: rnd() < 0.5 ? good.request_id : make(),
        route: rnd() < 0.5 ? good.route : `GET /${make()}`,
        status: rnd() < 0.8 ? 200 : Math.floor(rnd() * 1000),
      };
      try {
        const line = toPublicLogLine(entry as PublicLogEntry);
        passed++;
        expect(line.split(/[\r\n\u2028\u2029]/)).toHaveLength(1);
        expect(line).not.toMatch(/[\u001b\u0000-\u001f\u007f-\u009f]/);
        expect(JSON.parse(line)).toEqual(entry);
        expect(Object.keys(JSON.parse(line))).toEqual([...PUBLIC_LOG_FIELDS]);
      } catch (e) {
        expect(e).toBeInstanceOf(PublicLogError);
      }
    }
    expect(passed).toBeGreaterThan(100); // the fuzz does reach the accepting path
  });

  it("is not fooled by a prototype-polluted or non-object entry", () => {
    for (const bad of [null, undefined, 1, "x", [], [good]]) expect(() => toPublicLogLine(bad as unknown as PublicLogEntry)).toThrow(PublicLogError);
    const inherited = Object.create(good) as PublicLogEntry; // fields only on the prototype
    expect(() => toPublicLogLine(inherited)).toThrow(PublicLogError);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. Drop-one-input
// ---------------------------------------------------------------------------------------------

describe("7. drop-one-input: each required OPERATIONAL-LIMITS field breaks the pack load at the loader", () => {
  const PATH = "policy/OPERATIONAL-LIMITS@1.0.0.yaml";
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  /** Loads the real pack with the one policy edited and its digest re-pinned, so only the content can fail. */
  async function loadEdited(edit: (doc: any) => void) {
    const { parse, stringify } = await import("yaml");
    const source = readPack("contracts/n");
    const doc = parse(source.files[PATH]!);
    edit(doc);
    source.files[PATH] = stringify(doc);
    source.manifest.files[PATH] = sha(source.files[PATH]!);
    return loadProfilePack(source);
  }

  const leaves = (limits: OperationalLimits): Array<[string, string]> =>
    (["execution", "coordinator", "http", "targets"] as const).flatMap((g) => Object.keys((limits as any)[g]).map((k): [string, string] => [g, k]));

  it("the unedited pack loads (control)", async () => {
    const pack = await loadEdited(() => {});
    expect(pack.operationalLimits.execution.job_deadline_ms).toBe(30000);
    expect(pack.pins.map((p) => p.ref)).toContain("OPERATIONAL-LIMITS@1.0.0");
  });

  it("removing any single field fails the load, naming that field", async () => {
    const all = leaves(L);
    expect(all.length).toBe(11 + 4 + 8 + 6);
    for (const [group, key] of all) {
      let error: unknown;
      try {
        await loadEdited((d) => delete d[group][key]);
      } catch (e) {
        error = e;
      }
      expect(error, `${group}.${key}`).toBeInstanceOf(ProfileError);
      expect((error as Error).message, `${group}.${key}`).toContain(`${group}.${key}`);
      expect((error as Error).message).toContain(PATH);
    }
  });

  it("removing a whole group, the note, or the identity fails the load", async () => {
    for (const key of ["execution", "coordinator", "http", "targets", "note", "id", "version"]) {
      await expect(loadEdited((d) => delete d[key]), key).rejects.toBeInstanceOf(ProfileError);
    }
  });

  it("non-positive, fractional, text and null values fail, per positive-integer field", async () => {
    for (const [group, key] of leaves(L)) {
      if (key === "retry_count" || key === "max_server_errors") continue;
      for (const bad of [0, -1, 1.5, "10", null]) {
        await expect(loadEdited((d) => (d[group][key] = bad)), `${group}.${key}=${String(bad)}`).rejects.toThrow(new RegExp(`${group}\\.${key}`));
      }
    }
  });

  it("retry_count must be exactly 0, and max_server_errors exactly 0", async () => {
    for (const bad of [1, 2, -1, "0", null]) {
      await expect(loadEdited((d) => (d.execution.retry_count = bad))).rejects.toThrow(/execution\.retry_count/);
      await expect(loadEdited((d) => (d.targets.max_server_errors = bad))).rejects.toThrow(/targets\.max_server_errors/);
    }
  });

  it("an unknown extra field is refused (strict schema)", async () => {
    await expect(loadEdited((d) => (d.execution.max_depth_alias = 12))).rejects.toBeInstanceOf(ProfileError);
    await expect(loadEdited((d) => (d.surprise = true))).rejects.toBeInstanceOf(ProfileError);
  });

  it("a wrong policy id or a version that does not match its pin is refused", async () => {
    await expect(loadEdited((d) => (d.id = "LIMITS"))).rejects.toBeInstanceOf(ProfileError);
    await expect(loadEdited((d) => (d.version = "1.0.1"))).rejects.toBeInstanceOf(ProfileError);
  });

  it("a changed value without a re-pinned digest fails the pack digest check", async () => {
    const source = readPack("contracts/n");
    source.files[PATH] = source.files[PATH]!.replace("job_deadline_ms: 30000", "job_deadline_ms: 90000");
    await expect(loadProfilePack(source)).rejects.toThrow(/does not match its pinned digest/);
  });

  it("an unpinned operational policy (pin removed from the profile) fails the load", async () => {
    const source = readPack("contracts/n");
    const profilePath = `profile/${source.manifest.profile}.yaml`;
    const withoutPin = source.files[profilePath]!.replace(/^\s*- OPERATIONAL-LIMITS@1\.0\.0\n/m, "");
    expect(withoutPin).not.toBe(source.files[profilePath]);
    source.files[profilePath] = withoutPin;
    source.manifest.files[profilePath] = sha(withoutPin);
    await expect(loadProfilePack(source)).rejects.toThrow(/exactly one OPERATIONAL-LIMITS/);
  });

  it("a missing policy file fails the load", async () => {
    const source = readPack("contracts/n");
    delete source.files[PATH];
    await expect(loadProfilePack(source)).rejects.toThrow(/missing|OPERATIONAL-LIMITS/);
  });
});

// ---------------------------------------------------------------------------------------------
// 8. Classification table
// ---------------------------------------------------------------------------------------------

describe("8. classifyLimitOutcome", () => {
  it("maps each limit code to its outcome", () => {
    const table: Array<[string, "TIMEOUT" | "OVER_LIMIT" | "CANCELLED"]> = [
      ["too-large", "OVER_LIMIT"],
      ["too-deep", "OVER_LIMIT"],
      ["multiple-records", "OVER_LIMIT"],
      ["too-many-nodes", "OVER_LIMIT"],
      ["queue-full", "OVER_LIMIT"],
      ["rate-limited", "OVER_LIMIT"],
      ["deadline", "TIMEOUT"],
      ["cancelled", "CANCELLED"],
    ];
    for (const [code, outcome] of table) expect(classifyLimitOutcome(code), code).toBe(outcome);
  });

  it("returns null for every other ingress code and for hostile keys", () => {
    for (const code of Object.keys(ERROR_TEXT)) {
      const expected = ["too-large", "too-deep", "multiple-records", "too-many-nodes", "deadline", "cancelled"].includes(code);
      expect(classifyLimitOutcome(code) !== null, code).toBe(expected);
    }
    for (const code of ["", "TIMEOUT", "OVER_LIMIT", "CANCELLED", "toString", "constructor", "__proto__", "hasOwnProperty", "Too-Large", " too-large"]) {
      expect(classifyLimitOutcome(code), code).toBeNull();
    }
  });

  it("the outcome set is exactly the three decided classes", () => {
    expect([...LIMIT_OUTCOMES]).toEqual(["TIMEOUT", "OVER_LIMIT", "CANCELLED"]);
  });
});
