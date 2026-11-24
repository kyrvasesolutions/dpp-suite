// @vitest-environment node
/**
 * Cycle 8 Layer 3 (P05 bounded load, input limits and retry behaviour; decisions D8-01, D8-02, D8-04): the real server, an
 * ephemeral port and a temp SQLite file, with fixtures from `fixtures/n`. It mirrors the Layer 2 behaviour of
 * `tests/simulation/cycle8Sim.test.ts` on the real server:
 *
 *  - every budget at the limit and at limit + 1 (OVER_LIMIT, no partial success),
 *  - the request body cap enforced while streaming (T13) and the HTTP timeouts and connection cap (T11),
 *  - the rate limit (T12), the queue and the slots of the job coordinator (T12, T21),
 *  - cooperative cancellation and TIMEOUT with no partial commit (T20), the audited cancel (T22), metrics (T23),
 *  - request ids and the six-field public log hook, and the migration 0007 round trip.
 *
 * Limits are patched copies of the pinned OPERATIONAL-LIMITS so a boundary is reached with the real fixtures and no real
 * 30 s wait. The server reads only its own options; nothing in a request can change a limit.
 */
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../server/db/adapter";
import { computeStoreChecksum, currentMigrationVersion, migrateDown, migrateUp } from "../../server/db/migrations";
import { RateLimiter, addressKey, routeTemplate } from "../../server/http/limits";
import { ImportJobRunner } from "../../server/jobs/importJobRunner";
import { PolicyStore } from "../../server/store/policyStore";
import { JobBudget, toPublicLogLine, type PublicLogEntry } from "../../src/model/c8Contracts";
import { ROLE_ACTION_MATRIX } from "../../src/model/c7Contracts";
import { parseStrictJson } from "../../src/model/strictJson";
import { OPERATOR } from "../../src/model/recordRepository";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, loadPack } from "../support/records";
import {
  NOW,
  NO_RATE_PRESSURE,
  b64,
  fixtureSize,
  gate,
  get,
  headers,
  importBody,
  post,
  sleep,
  startC8Server,
  until,
  type C8Server,
  type LimitsPatch,
} from "../support/c8Server";

const text = (name: string) => new TextDecoder().decode(fixtureBytes("n", name));
const json = async (res: Response) => (await res.json()) as Record<string, any>;

const open: C8Server[] = [];
async function start(options: Parameters<typeof startC8Server>[0] = {}): Promise<C8Server> {
  const s = await startC8Server({ ...options, patch: mergePatch(NO_RATE_PRESSURE, options.patch) });
  open.push(s);
  return s;
}
function mergePatch(a: LimitsPatch, b: LimitsPatch = {}): LimitsPatch {
  return {
    execution: { ...(a.execution ?? {}), ...(b.execution ?? {}) } as never,
    coordinator: { ...(a.coordinator ?? {}), ...(b.coordinator ?? {}) } as never,
    http: { ...(a.http ?? {}), ...(b.http ?? {}) } as never,
  };
}
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

// ---------------------------------------------------------------------------------------------
// 1. Budgets: the limit passes, limit + 1 is OVER_LIMIT, and nothing is committed (C8-02)
// ---------------------------------------------------------------------------------------------

describe("1. execution budgets at the limit and at limit + 1", () => {
  const erpSize = fixtureSize(CLEAN.erp);
  const labSize = fixtureSize(CLEAN.lab);

  /** The smallest value of a budget at which a real parse passes, found by running the real parser. */
  const smallest = (probe: (v: number) => void) => {
    for (let v = 1; v < 5000; v++) {
      try {
        probe(v);
        return v;
      } catch {
        /* too small */
      }
    }
    throw new Error("no passing value");
  };
  const labNodes = smallest((n) => parseStrictJson(text(CLEAN.lab), { maxNodes: n }));
  const labDepth = smallest((d) => parseStrictJson(text(CLEAN.lab), { maxDepth: d }));

  type Case = {
    name: string;
    limit: string;
    code: string;
    patch: (v: number) => LimitsPatch;
    atLimit: number;
    body?: (key: string) => string;
  };
  const ev = new TextEncoder().encode("c8 staging evidence");
  const cases: Case[] = [
    { name: "one source file", limit: "source_file_max_bytes", code: "too-large", atLimit: Math.max(erpSize, labSize), patch: (v) => ({ execution: { source_file_max_bytes: v } as never }) },
    { name: "the pair of source files", limit: "source_pair_max_bytes", code: "too-large", atLimit: erpSize + labSize, patch: (v) => ({ execution: { source_pair_max_bytes: v } as never }) },
    {
      name: "everything one job stages",
      limit: "total_staging_max_bytes",
      code: "too-large",
      atLimit: erpSize + labSize + ev.byteLength,
      patch: (v) => ({ execution: { total_staging_max_bytes: v } as never }),
      body: (key) => importBody({ key, evidence: [{ evidenceId: "EV-C8-1", bytes: ev }] }),
    },
    { name: "JSON nesting depth", limit: "max_nesting_depth", code: "too-deep", atLimit: labDepth, patch: (v) => ({ execution: { max_nesting_depth: v } as never }) },
    { name: "parser nodes per job", limit: "max_parser_nodes_per_job", code: "too-many-nodes", atLimit: labNodes, patch: (v) => ({ execution: { max_parser_nodes_per_job: v } as never }) },
  ];

  for (const c of cases) {
    it(`${c.name}: exactly ${c.limit} commits, one less is refused with OVER_LIMIT and nothing is stored`, async () => {
      const s = await start({ patch: c.patch(c.atLimit) });
      const ok = await post(s, "/api/jobs/import", (c.body ?? ((key) => importBody({ key })))("at-limit"));
      expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(200);
      expect((await json(ok)).ok).toBe(true);
      await s.close();
      open.pop();

      const t = await start({ patch: c.patch(c.atLimit - 1) });
      const before = t.state();
      const refused = await post(t, "/api/jobs/import", (c.body ?? ((key) => importBody({ key })))("over-limit"));
      const body = await json(refused);
      expect(refused.status).toBe(422); // the N status of an import refusal is unchanged
      expect(body.ok).toBe(false);
      expect(body.outcome).toBe("OVER_LIMIT");
      expect(body.limit).toBe(c.limit);
      expect(body.errors[0].code).toBe(c.code);
      const after = t.state();
      expect(after.snapshots).toBe(before.snapshots);
      expect(after.receipts).toBe(before.receipts);
      expect(after.evidence).toBe(before.evidence);
      // the response names the limit and never echoes the content of the files
      expect(JSON.stringify(body)).not.toContain(b64(fixtureBytes("n", CLEAN.erp)).slice(0, 40));
    });
  }

  it("records per job: one data row commits, two are refused with OVER_LIMIT multiple-records", async () => {
    const s = await start();
    const one = await post(s, "/api/jobs/import", importBody({ key: "rows-1", lab: null }));
    expect(one.status).toBe(200);
    const before = s.state();
    const two = await post(s, "/api/jobs/import", importBody({ key: "rows-2", erp: "erp-two-rows.csv", lab: null }));
    const body = await json(two);
    expect(two.status).toBe(422);
    expect(body).toMatchObject({ ok: false, outcome: "OVER_LIMIT", limit: "max_records_per_job" });
    expect(body.errors[0].code).toBe("multiple-records");
    const after = s.state();
    expect(after.snapshots).toBe(before.snapshots);
    expect(after.receipts).toBe(before.receipts);
  });

  it("the browser limits are unchanged: without a job budget the N parser is not node-limited", async () => {
    const pack = await loadPack();
    expect(pack.policy.limits).toMatchObject({ max_file_bytes: 10 * 1024 * 1024, max_json_depth: 12, job_deadline_ms: 30000, max_erp_data_rows: 1 });
    expect(() => parseStrictJson(text(CLEAN.lab))).not.toThrow();
  });

  it("an output of exactly max_output_bytes_per_route is released, one byte more is refused with nothing logged", async () => {
    const probe = await start();
    const imported = await json(await post(probe, "/api/jobs/import", importBody({ key: "out-1" })));
    const { model, batch } = imported.snapshot;
    const released = await json(await post(probe, `/api/records/${model}/${batch}/release`, {}));
    const sizes: number[] = released.files.map((f: { base64: string }) => Buffer.from(f.base64, "base64").byteLength);
    const largest = Math.max(...sizes);
    expect(largest).toBeGreaterThan(100);
    const customer = await json(await post(probe, `/api/customer/records/${model}/${batch}/release`, {}));
    const customerSize = customer.file ? Buffer.from(customer.file.base64, "base64").byteLength : 0;
    await probe.close();
    open.pop();

    const atLimit = Math.max(largest, customerSize);
    const s = await start({ patch: { execution: { max_output_bytes_per_route: atLimit } as never } });
    const imp = await json(await post(s, "/api/jobs/import", importBody({ key: "out-2" })));
    const route = `/api/records/${imp.snapshot.model}/${imp.snapshot.batch}`;
    expect((await post(s, `${route}/release`, {})).status).toBe(200);
    expect((await post(s, `/api/customer${route.slice(4)}/release`, {})).status).toBe(200);
    await s.close();
    open.pop();

    const t = await start({ patch: { execution: { max_output_bytes_per_route: atLimit - 1 } as never } });
    const imp2 = await json(await post(t, "/api/jobs/import", importBody({ key: "out-3" })));
    const route2 = `/api/records/${imp2.snapshot.model}/${imp2.snapshot.batch}`;
    const before = t.state();
    const refused = await post(t, `${route2}/release`, {});
    const body = await json(refused);
    expect(refused.status).toBe(422);
    expect(body).toMatchObject({ code: "too-large", outcome: "OVER_LIMIT", limit: "max_output_bytes_per_route" });
    expect(t.state().logEntries).toBe(before.logEntries); // no release event for an output that was not released
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Request body cap enforced while streaming (T13)
// ---------------------------------------------------------------------------------------------

describe("2. body cap while streaming (T13)", () => {
  const CAP = 4096;
  const body = (bytes: number) => JSON.stringify({ reason: "x".repeat(bytes - JSON.stringify({ reason: "" }).length) });

  it("a body of exactly max_request_body_bytes is read, one byte more is 413 OVER_LIMIT", async () => {
    const s = await start({ patch: { http: { max_request_body_bytes: CAP } as never } });
    expect(Buffer.byteLength(body(CAP))).toBe(CAP);
    const at = await post(s, "/api/jobs/JOB-none/cancel", body(CAP));
    expect(at.status).toBe(400); // read in full; then the over-long reason is refused (not a size refusal)
    expect((await json(at)).code).toBe("reason-required");
    const over = await post(s, "/api/jobs/JOB-none/cancel", body(CAP + 1));
    expect(over.status).toBe(413);
    expect(await json(over)).toMatchObject({ code: "too-large", outcome: "OVER_LIMIT", limit: "max_request_body_bytes" });
  });

  it("a declared length over the cap is refused before the body is sent", async () => {
    const s = await start({ patch: { http: { max_request_body_bytes: CAP } as never } });
    const { status, sentBeforeAnswer } = await rawPost(s.port, { contentLength: 500_000_000, chunkBytes: 1024, chunks: 3 });
    expect(status).toBe(413);
    expect(sentBeforeAnswer).toBeLessThan(CAP * 4);
  });

  it("an undeclared (chunked) body is cut off as soon as the cap is crossed, without reading the rest", async () => {
    const s = await start({ patch: { http: { max_request_body_bytes: CAP } as never } });
    const result = await new Promise<{ status: number; written: number; code: string }>((resolve, reject) => {
      let written = 0;
      let answered = false;
      const req = httpRequest(
        { host: "127.0.0.1", port: s.port, method: "POST", path: "/api/jobs/JOB-none/cancel", headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" } },
        (res) => {
          answered = true;
          let data = "";
          res.on("data", (d) => (data += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, written, code: JSON.parse(data).code }));
        },
      );
      req.on("error", (e) => (answered ? undefined : reject(e)));
      req.write('{"reason":"');
      const timer = setInterval(() => {
        if (answered || written > 4_000_000) {
          clearInterval(timer);
          req.destroy();
          return;
        }
        written += 1024;
        req.write("y".repeat(1024));
      }, 2);
    });
    expect(result.status).toBe(413);
    expect(result.code).toBe("too-large");
    // a few buffers may already be in flight, but nowhere near the 4 MB the sender was ready to push
    expect(result.written).toBeLessThan(2_000_000); // far from the 4 MB the sender was ready to push, even on a loaded machine
  });

  it("the route cap never exceeds the transport cap: an import larger than the transport cap is 413", async () => {
    const s = await start({ patch: { http: { max_request_body_bytes: 2000 } as never } });
    const res = await post(s, "/api/jobs/import", importBody({ key: "big" }));
    expect(res.status).toBe(413);
    expect(await json(res)).toMatchObject({ outcome: "OVER_LIMIT", limit: "max_request_body_bytes" });
  });
});

/** POSTs headers that declare a huge body, trickles a little, and returns the first status line seen. */
function rawPost(port: number, o: { contentLength: number; chunkBytes: number; chunks: number; path?: string }): Promise<{ status: number; sentBeforeAnswer: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let sent = 0;
    let buf = "";
    let done = false;
    socket.on("data", (d) => {
      buf += d.toString("latin1");
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m && !done) {
        done = true;
        resolve({ status: Number(m[1]), sentBeforeAnswer: sent });
        socket.destroy();
      }
    });
    socket.on("error", (e) => (done ? undefined : reject(e)));
    socket.on("connect", () => {
      socket.write(`POST ${o.path ?? "/api/jobs/JOB-none/cancel"} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${o.contentLength}\r\n\r\n`);
      let i = 0;
      const timer = setInterval(() => {
        if (done || i++ >= o.chunks) {
          clearInterval(timer);
          return;
        }
        sent += o.chunkBytes;
        socket.write("z".repeat(o.chunkBytes));
      }, 20);
    });
    setTimeout(() => (done ? undefined : reject(new Error("no answer"))), 5000);
  });
}

// ---------------------------------------------------------------------------------------------
// 3. HTTP timeouts and connection cap (T11)
// ---------------------------------------------------------------------------------------------

describe("3. HTTP timeouts and connection cap (T11)", () => {
  const SMALL = { headers_timeout_ms: 300, request_timeout_ms: 1000, keep_alive_timeout_ms: 500 };

  /** Resolves with what the server did to a socket: the status line it sent (if any) and when it closed. */
  function observe(socket: ReturnType<typeof connect>): Promise<{ status: number | null; closedAfterMs: number }> {
    const t0 = Date.now();
    return new Promise((resolve) => {
      let buf = "";
      socket.on("data", (d) => (buf += d.toString("latin1")));
      socket.on("error", () => undefined);
      socket.on("close", () => resolve({ status: /^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ? Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)![1]) : null, closedAfterMs: Date.now() - t0 }));
    });
  }

  it("headers trickled past headers_timeout_ms get 408 and the socket is closed", async () => {
    const s = await start({ patch: { http: SMALL as never } });
    const socket = connect(s.port, "127.0.0.1");
    const seen = observe(socket);
    socket.write("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    const drip = setInterval(() => socket.writable && socket.write("X-Slow: a\r\n"), 100);
    const r = await seen;
    clearInterval(drip);
    // cut by the HEADERS timeout, not by the longer request timeout (V2-07): answered 408 and closed before request_timeout_ms
    expect(r.status).toBe(408);
    expect(r.closedAfterMs).toBeGreaterThanOrEqual(SMALL.headers_timeout_ms - 50);
    expect(r.closedAfterMs).toBeLessThan(SMALL.request_timeout_ms);
  });

  it("a body trickled past request_timeout_ms is cut off", async () => {
    const s = await start({ patch: { http: SMALL as never } });
    const socket = connect(s.port, "127.0.0.1");
    const seen = observe(socket);
    socket.write("POST /api/jobs/JOB-none/cancel HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{");
    const drip = setInterval(() => socket.writable && socket.write(" "), 100);
    const r = await seen;
    clearInterval(drip);
    expect([408, null]).toContain(r.status);
    expect(r.closedAfterMs).toBeLessThan(SMALL.request_timeout_ms + 1500);
  });

  it("an idle keep-alive connection is closed after keep_alive_timeout_ms", async () => {
    const s = await start({ patch: { http: { ...SMALL, keep_alive_timeout_ms: 300 } as never } });
    const socket = connect(s.port, "127.0.0.1");
    const seen = observe(socket);
    socket.write("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    const r = await seen;
    expect(r.status).toBe(200);
    expect(r.closedAfterMs).toBeLessThan(3000);
  });

  it("connections over max_connections are refused at once and a freed place is usable again", async () => {
    const s = await start({ patch: { http: { max_connections: 2 } as never } });
    const a = connect(s.port, "127.0.0.1");
    const b = connect(s.port, "127.0.0.1");
    await Promise.all([new Promise((r) => a.once("connect", r)), new Promise((r) => b.once("connect", r))]);
    await sleep(50);
    const c = connect(s.port, "127.0.0.1");
    c.on("error", () => undefined);
    const closed = await new Promise<boolean>((resolve) => {
      c.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 1500);
    });
    expect(closed).toBe(true); // the third connection never got a place
    expect(a.destroyed || b.destroyed).toBe(false); // the two before it are untouched
    a.destroy();
    b.destroy();
    await sleep(100);
    const again = await fetch(`${s.baseUrl}/api/health`);
    expect(again.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Rate limit (T12)
// ---------------------------------------------------------------------------------------------

describe("4. rate limit (T12)", () => {
  const clockAt = (t: { ms: number }) => ({ extra: { clock: () => t.ms } });

  it("reads and writes have separate fixed-window budgets, 429 carries Retry-After, health is exempt, and the window resets", async () => {
    const t = { ms: 1_000_000 };
    const s = await start({ patch: { http: { rate_limit_window_ms: 60_000, rate_limit_read_per_window: 5, rate_limit_write_per_window: 3 } as never }, ...clockAt(t) });
    for (let i = 0; i < 5; i++) expect((await get(s, "/api/jobs")).status).toBe(200);
    const limited = await get(s, "/api/jobs");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await json(limited)).toMatchObject({ code: "rate-limited", outcome: "OVER_LIMIT", limit: "rate_window" });
    t.ms += 30_000;
    const later = await get(s, "/api/jobs");
    expect(later.status).toBe(429);
    expect(later.headers.get("retry-after")).toBe("30");
    // health is never limited, however many probes
    for (let i = 0; i < 40; i++) expect((await get(s, "/api/health")).status).toBe(200);
    // the write budget is separate: three writes pass although the read budget is spent
    for (let i = 0; i < 3; i++) expect((await post(s, "/api/jobs/JOB-none/cancel", { reason: "r" })).status).toBe(404);
    const writeLimited = await post(s, "/api/jobs/JOB-none/cancel", { reason: "r" });
    expect(writeLimited.status).toBe(429);
    expect(Number(writeLimited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    t.ms += 60_000; // both windows have passed
    expect((await get(s, "/api/jobs")).status).toBe(200);
    expect((await post(s, "/api/jobs/JOB-none/cancel", { reason: "r" })).status).toBe(404);
  });

  it("the budget is per authenticated subject: one subject cannot spend another's", async () => {
    const s = await start({
      mode: "oidc",
      users: [
        { sub: "op-1", roles: ["ACT-01"] },
        { sub: "op-2", roles: ["ACT-01"] },
      ],
      patch: { http: { rate_limit_read_per_window: 3 } as never },
    });
    const t1 = s.token("op-1");
    for (let i = 0; i < 3; i++) expect((await get(s, "/api/auth/me", t1)).status).toBe(200);
    expect((await get(s, "/api/auth/me", t1)).status).toBe(429);
    expect((await get(s, "/api/auth/me", s.token("op-2"))).status).toBe(200);
    // callers without a valid token share the anonymous key of their address, and are refused with 401 until it is spent
    for (let i = 0; i < 3; i++) expect((await get(s, "/api/auth/me")).status).toBe(401);
    expect((await get(s, "/api/auth/me")).status).toBe(429);
  });

  it("memory stays bounded, and a flood of anonymous keys never locks out a subject that was never seen (V2-03)", () => {
    const t = { ms: 0 };
    const limiter = new RateLimiter({ windowMs: 60_000, readPerWindow: 600, writePerWindow: 120, maxKeys: 10_000, clock: () => t.ms });
    for (let i = 0; i < 50_000; i++) limiter.hit("read", "anon", `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    expect(limiter.size).toBeLessThanOrEqual(10_000); // capped, with least-recently-used eviction
    // a brand-new authenticated subject is served at once, with a full budget
    for (let i = 0; i < 600; i++) expect(limiter.hit("read", "never-seen-subject", "192.0.2.1").allowed).toBe(true);
    expect(limiter.hit("read", "never-seen-subject", "192.0.2.1").allowed).toBe(false);
    // and so is a brand-new anonymous address
    expect(limiter.hit("read", "anon", "198.51.100.7").allowed).toBe(true);
    // authenticated keys are capped too
    for (let i = 0; i < 30_000; i++) limiter.hit("read", `sub-${i}`, "192.0.2.1");
    expect(limiter.size).toBeLessThanOrEqual(20_000);
    t.ms += 120_000;
    limiter.hit("read", "after-expiry", "192.0.2.1");
    expect(limiter.size).toBeLessThanOrEqual(2);
  });

  it("anonymous callers are keyed by IPv4 address and by IPv6 /64, so a /64 cannot mint endless keys", () => {
    const t = { ms: 0 };
    const limiter = new RateLimiter({ windowMs: 60_000, readPerWindow: 3, writePerWindow: 3, maxKeys: 100, clock: () => t.ms });
    for (let i = 0; i < 3; i++) expect(limiter.hit("read", "anon", `2001:db8:1:2:${i.toString(16)}::${i}`).allowed).toBe(true);
    expect(limiter.hit("read", "anon", "2001:db8:1:2:ffff:ffff:ffff:ffff").allowed).toBe(false); // same /64
    expect(limiter.hit("read", "anon", "2001:db8:1:3::1").allowed).toBe(true); // another /64
    expect(addressKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(limiter.size).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Job coordinator, cancellation and TIMEOUT on one OIDC server (T12, T20, T21, T22, T23)
// ---------------------------------------------------------------------------------------------

describe("5. job coordinator, cancel and timeout (OIDC server)", () => {
  type Hook = (stage: string, ctx: { jobId: string; budget: JobBudget }) => void | Promise<void>;
  const hook: { current: Hook | null } = { current: null };
  let S: C8Server;
  let admin: string;
  let op1: string;
  let op2: string;
  let aud: string;
  let cur: string;
  let cust: string;
  let opB: string;

  beforeAll(async () => {
    S = await startC8Server({
      mode: "oidc",
      domains: ["dom-b"],
      users: [
        { sub: "admin-1", roles: ["ADMIN"] },
        { sub: "op-1", roles: ["ACT-01"] },
        { sub: "op-2", roles: ["ACT-01"] },
        { sub: "aud-1", roles: ["AUDITOR"] },
        { sub: "cur-1", roles: ["CURATOR"] },
        { sub: "cust-1", roles: ["ACT-06"] },
        { sub: "op-b", roles: ["ACT-01"], domain: "dom-b" },
      ],
      patch: {
        ...NO_RATE_PRESSURE,
        execution: { job_deadline_ms: 2000 } as never,
        coordinator: { max_active_jobs_per_security_domain: 1, max_queued_jobs_per_security_domain: 2, max_active_jobs_total: 4 } as never,
      },
      extra: { testHooks: { stageHook: (stage, ctx) => hook.current?.(stage, ctx) } },
    });
    [admin, op1, op2, aud, cur, cust, opB] = ["admin-1", "op-1", "op-2", "aud-1", "cur-1", "cust-1", "op-b"].map((u) => S.token(u));
  });
  afterAll(async () => {
    await S.close();
  });
  afterEach(async () => {
    hook.current = null;
    await idle();
  });

  const idle = () =>
    until(async () => {
      const m = await json(await get(S, "/api/admin/metrics", admin));
      return m.jobs.activeTotal === 0 && m.jobs.queuedTotal === 0;
    }, 5000);
  const metrics = async () => json(await get(S, "/api/admin/metrics", admin));
  const importAs = (token: string, key: string, extra: Record<string, string> = {}, parts: Partial<Parameters<typeof importBody>[0]> = {}) =>
    post(S, "/api/jobs/import", importBody({ key, ...parts }), token, extra);
  const cancel = (token: string | undefined, jobId: string, reason?: unknown) => post(S, `/api/jobs/${jobId}/cancel`, reason === undefined ? {} : { reason }, token);
  const jobOf = async (jobId: string) => json(await get(S, `/api/jobs/${jobId}`, admin));
  const heldAt = (stage: string) => {
    const g = gate();
    const seen: string[] = [];
    hook.current = async (st, { jobId }) => {
      if (st === stage && !seen.includes(jobId)) {
        seen.push(jobId);
        await g.promise;
      }
    };
    return { g, seen };
  };

  it("a full queue is refused with 429 + Retry-After, jobs start in arrival order, domains are isolated, and a retry then commits once", async () => {
    const order: string[] = [];
    const gates = new Map<string, ReturnType<typeof gate>>();
    hook.current = async (stage, { jobId }) => {
      if (stage !== "received") return;
      order.push(jobId);
      const g = gate();
      gates.set(jobId, g);
      await g.promise;
    };
    const before = S.state();
    try {
      const r1 = importAs(op1, "q-1");
      await until(() => order.length === 1);
      const r2 = importAs(op1, "q-2");
      await until(async () => (await metrics()).jobs.byDomain.default?.queued === 1);
      const r3 = importAs(op1, "q-3");
      await until(async () => (await metrics()).jobs.byDomain.default?.queued === 2);
      // the queue of the domain is full now
      const r4 = await importAs(op1, "q-4");
      expect(r4.status).toBe(429);
      expect(r4.headers.get("retry-after")).toBe(String(S.limits.coordinator.retry_after_seconds));
      expect(await json(r4)).toMatchObject({ code: "queue-full", outcome: "OVER_LIMIT", limit: "queue_full" });
      // another security domain has its own slots: it starts at once although the first domain is full
      const rb = importAs(opB, "q-b", { "X-Security-Domain": "dom-b" });
      await until(() => order.length === 2);
      gates.get(order[1]!)!.open();
      expect((await rb).status).toBe(200);
      // FIFO: releasing the first lets the second start, then the third
      gates.get(order[0]!)!.open();
      expect((await r1).status).toBe(200);
      await until(() => order.length === 3);
      gates.get(order[2]!)!.open();
      expect((await r2).status).toBe(200);
      await until(() => order.length === 4);
      gates.get(order[3]!)!.open();
      expect((await r3).status).toBe(200);
    } finally {
      hook.current = null;
      for (const g of gates.values()) g.open();
    }
    const jobs = (await json(await get(S, "/api/jobs", admin))).jobs as Array<{ jobId: string; idempotencyKey: string }>;
    const keyOf = (id: string) => jobs.find((j) => j.jobId === id)?.idempotencyKey;
    expect([order[0], order[2], order[3]].map((id) => keyOf(id!))).toEqual(["q-1", "q-2", "q-3"]);
    // no automatic retry: the refused job was never created
    expect(jobs.some((j) => j.idempotencyKey === "q-4")).toBe(false);
    // the client retries after Retry-After with the same key: it commits, and nothing is duplicated
    hook.current = null;
    expect((await importAs(op1, "q-4")).status).toBe(200);
    const after = S.state();
    expect(after.snapshots - before.snapshots).toBe(2); // the same record in the default domain (1) and in dom-b (1)
    const m = await metrics();
    expect(m.limitOutcomes).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "OVER_LIMIT", limit: "queue_full" })]));
    expect(m.jobs).toMatchObject({ activeTotal: 0, queuedTotal: 0 });
  });

  for (const stage of ["received", "classified", "validated", "staged"] as const) {
    it(`cancel held at the ${stage} stage: 409 CANCELLED, rolled back, nothing committed, slot freed, a retry commits once`, async () => {
      const { g, seen } = heldAt(stage);
      const before = S.state();
      const pending = importAs(op1, `cancel-${stage}`);
      const jobId = (await until(() => seen[0])) as string;
      const c1 = await cancel(op1, jobId, "operator stopped the import");
      expect(c1.status).toBe(200);
      expect(await json(c1)).toMatchObject({ status: "cancelled", outcome: "CANCELLED" });
      const c2 = await cancel(op1, jobId, "a different reason"); // idempotent
      expect(c2.status).toBe(200);
      expect(await json(c2)).toMatchObject({ status: "already-cancelled" });
      g.open();
      const res = await pending;
      expect(res.status).toBe(409);
      expect(await json(res)).toMatchObject({ code: "cancelled", outcome: "CANCELLED" });
      const job = await jobOf(jobId);
      expect(job.job).toMatchObject({ state: "rolled_back", errorCode: "cancelled" });
      expect(job.events.at(-1)).toMatchObject({ stage: "rolled_back", outcome: "rolled_back", code: "cancelled" });
      // the audit keeps the first reason, who asked, and when; it is not in any public log
      expect(job.cancellation).toMatchObject({ requestedBy: "op-1", reason: "operator stopped the import", outcome: "CANCELLED" });
      expect(S.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM import_jobs WHERE job_id = ? AND staged_payload_json IS NOT NULL", jobId)!.n).toBe(0);
      expect(S.state()).toEqual(before); // no partial commit: the checksum and every count are as before
      // cancelling a job that has ended as cancelled stays idempotent
      expect(await json(await cancel(admin, jobId, "late repeat"))).toMatchObject({ status: "already-cancelled" });
      await idle();
      // retry with the same key: the claim restarts the same job and commits exactly once
      hook.current = null;
      const retry = await importAs(op1, `cancel-${stage}`);
      expect(retry.status).toBe(200);
      expect(S.state().snapshots).toBe(before.snapshots + (before.snapshots === 0 ? 1 : 0));
      const again = await importAs(op1, `cancel-${stage}`);
      expect(again.status).toBe(200);
      expect(S.state().receipts).toBe(before.receipts + 1);
    });
  }

  it("cancel needs a reason, and only the submitter (ACT-01) or an ADMIN may cancel; the audit records who and why", async () => {
    const { g, seen } = heldAt("validated");
    const pending = importAs(op1, "cancel-auth");
    const jobId = (await until(() => seen[0])) as string;
    for (const bad of [undefined, "", "   ", 42, "x".repeat(501), "line\nbreak"]) {
      const r = await cancel(op1, jobId, bad);
      expect(r.status, String(bad)).toBe(400);
      expect((await json(r)).code).toBe("reason-required");
    }
    expect((await cancel(undefined, jobId, "no token")).status).toBe(401);
    expect((await cancel(op2, jobId, "someone else's job")).status).toBe(403); // another ACT-01 user
    for (const t of [aud, cur, cust]) expect((await cancel(t, jobId, "wrong role")).status).toBe(403);
    expect((await cancel(opB, jobId, "other domain")).status).toBe(403);
    expect((await get(S, `/api/jobs/${jobId}`, admin).then(json)).job.state).toBe("running"); // nothing above cancelled it
    const byAdmin = await cancel(admin, jobId, "administrator override");
    expect(byAdmin.status).toBe(200);
    g.open();
    expect((await pending).status).toBe(409);
    expect((await jobOf(jobId)).cancellation).toMatchObject({ requestedBy: "admin-1", reason: "administrator override" });
    expect((await cancel(op1, "JOB-does-not-exist", "x")).status).toBe(404);
  });

  it("a committed job cannot be cancelled: 409 not-cancellable, for the submitter and for an ADMIN", async () => {
    const done = await json(await importAs(op1, "cancel-after-commit"));
    expect(done.ok).toBe(true);
    for (const t of [op1, admin]) {
      const r = await cancel(t, done.job.jobId, "too late");
      expect(r.status).toBe(409);
      expect((await json(r)).code).toBe("not-cancellable");
    }
    expect((await jobOf(done.job.jobId)).job.state).toBe("committed");
  });

  for (const stage of ["classified", "validated", "staged"] as const) {
    it(`a deadline that passes during the ${stage} stage ends the job failed with outcome TIMEOUT and commits nothing`, async () => {
      const before = S.state();
      let jobId = "";
      hook.current = async (st, ctx) => {
        if (st !== stage) return;
        jobId = ctx.jobId;
        await sleep(S.limits.execution.job_deadline_ms + 150); // does not cooperate: the check at the boundary catches it
      };
      const res = await importAs(op1, `timeout-${stage}`);
      const body = await json(res);
      expect(res.status).toBe(422);
      expect(body).toMatchObject({ ok: false, outcome: "TIMEOUT", limit: "job_deadline_ms" });
      expect(body.errors[0].code).toBe("deadline");
      const job = await jobOf(jobId);
      expect(job.job).toMatchObject({ state: "failed", errorCode: "deadline" });
      expect(S.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM import_jobs WHERE job_id = ? AND staged_payload_json IS NOT NULL", jobId)!.n).toBe(0);
      expect(S.state()).toEqual(before);
      await idle();
      hook.current = null;
      expect((await importAs(op1, `timeout-${stage}`)).status).toBe(200); // the client retries with the same key
    }, 10_000);
  }

  it("a cooperative stage notices the deadline at once (the budget is checked inside it)", async () => {
    hook.current = async (st, { budget }) => {
      if (st !== "validated") return;
      for (;;) {
        await sleep(5);
        budget.check(st);
      }
    };
    const before = S.state();
    const t0 = performance.now();
    const res = await importAs(op1, "timeout-coop");
    const elapsed = performance.now() - t0;
    expect(await json(res)).toMatchObject({ outcome: "TIMEOUT", ok: false });
    expect(elapsed).toBeLessThan(S.limits.execution.job_deadline_ms + 600);
    expect(S.state()).toEqual(before);
  }, 10_000);

  it("a client that disconnects cancels its job: rolled back, nothing committed, slot freed", async () => {
    const { g, seen } = heldAt("validated");
    const before = S.state();
    const ac = new AbortController();
    const pending = fetch(`${S.baseUrl}/api/jobs/import`, { method: "POST", headers: headers(op1), body: importBody({ key: "disconnect-1" }), signal: ac.signal }).catch(() => null);
    const jobId = (await until(() => seen[0])) as string;
    ac.abort();
    await pending;
    await sleep(50); // the server notices the closed socket
    g.open();
    await until(async () => (await jobOf(jobId)).job.state === "rolled_back");
    expect((await jobOf(jobId)).job.errorCode).toBe("cancelled");
    expect(S.state()).toEqual(before);
    await idle();
  });

  it("a request that leaves the queue before it starts never becomes a job", async () => {
    const order: string[] = [];
    const g = gate();
    hook.current = async (stage, { jobId }) => {
      if (stage === "received" && order.length === 0) {
        order.push(jobId);
        await g.promise;
      }
    };
    const first = importAs(op1, "leave-1");
    await until(() => order.length === 1);
    const ac = new AbortController();
    const queued = fetch(`${S.baseUrl}/api/jobs/import`, { method: "POST", headers: headers(op1), body: importBody({ key: "leave-2" }), signal: ac.signal }).catch(() => null);
    await until(async () => (await metrics()).jobs.byDomain.default?.queued === 1);
    ac.abort();
    await queued;
    await until(async () => (await metrics()).jobs.byDomain.default?.queued === 0);
    g.open();
    expect((await first).status).toBe(200);
    expect(S.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM import_jobs WHERE idempotency_key = 'leave-2'")!.n).toBe(0);
  });

  it("the slot is freed on every terminal path: commit, ingress failure, conflict, rollback, timeout, crash and disconnect", async () => {
    const free = async (label: string) => {
      await idle();
      const m = await metrics();
      expect(m.jobs.activeTotal, label).toBe(0);
      expect(m.jobs.queuedTotal, label).toBe(0);
    };
    // 1. commit
    expect((await importAs(op1, "slot-commit")).status).toBe(200);
    await free("commit");
    // 2. ingress failure
    expect((await importAs(op1, "slot-fail", {}, { erp: "erp-two-rows.csv", lab: null })).status).toBe(422);
    await free("fail");
    // 3. conflict: the same key for another payload is refused inside the claim, before any work
    expect((await importAs(op1, "slot-commit", {}, { lab: null })).status).toBe(409);
    await free("conflict");
    // 4. rollback by cancel
    {
      const { g, seen } = heldAt("classified");
      const p = importAs(op1, "slot-cancel");
      await cancel(op1, (await until(() => seen[0])) as string, "slot test");
      g.open();
      expect((await p).status).toBe(409);
      await free("cancel");
    }
    // 5. timeout
    hook.current = async (st) => {
      if (st === "validated") await sleep(S.limits.execution.job_deadline_ms + 100);
    };
    expect((await json(await importAs(op1, "slot-timeout"))).outcome).toBe("TIMEOUT");
    await free("timeout");
    // 6. crash: an exception inside a stage
    hook.current = (st) => {
      if (st === "validated") throw new Error("injected failure that must not be echoed");
    };
    const crashed = await importAs(op1, "slot-crash");
    expect(crashed.status).toBe(500);
    expect(JSON.stringify(await json(crashed))).not.toContain("injected failure");
    await free("crash");
    expect((await jobBy("slot-crash")).state).toBe("rolled_back");
    // 7. disconnect
    {
      const { g, seen } = heldAt("validated");
      const ac = new AbortController();
      const p = fetch(`${S.baseUrl}/api/jobs/import`, { method: "POST", headers: headers(op1), body: importBody({ key: "slot-gone" }), signal: ac.signal }).catch(() => null);
      await until(() => seen[0]);
      ac.abort();
      await p;
      await sleep(50);
      g.open();
      await free("disconnect");
    }
    // nothing leaked: the next job starts at once
    hook.current = null;
    expect((await importAs(op1, "slot-after-all")).status).toBe(200);
  });

  const jobBy = async (key: string) => {
    const jobs = (await json(await get(S, "/api/jobs", admin))).jobs as Array<{ idempotencyKey: string; state: string }>;
    return jobs.find((j) => j.idempotencyKey === key)!;
  };

  it("cancellation is seen within cancellation_poll_max_ms (measured on this host)", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      let held = false;
      let id = "";
      hook.current = async (st, { jobId, budget }) => {
        if (st !== "validated") return;
        id = jobId;
        held = true;
        for (;;) {
          await sleep(5); // a stage that polls the budget every few milliseconds, as the parser ticks do
          budget.check(st);
        }
      };
      const pending = importAs(op1, `latency-${i}`);
      await until(() => held);
      const t0 = performance.now();
      expect((await cancel(op1, id, "latency probe")).status).toBe(200);
      const res = await pending;
      samples.push(performance.now() - t0);
      expect(res.status).toBe(409);
      await idle();
    }
    const max = Math.max(...samples);
    process.stderr.write(`[C8-LATENCY] cancel to answered import, ms: ${samples.map((x) => x.toFixed(1)).join(", ")} (max ${max.toFixed(1)}; bound ${S.limits.execution.cancellation_poll_max_ms})\n`);
    expect(max).toBeLessThanOrEqual(S.limits.execution.cancellation_poll_max_ms);
  });

  it("metrics are counters only and limited to ADMIN and AUDITOR (T23)", async () => {
    for (const t of [admin, aud]) {
      const r = await get(S, "/api/admin/metrics", t);
      expect(r.status).toBe(200);
    }
    for (const t of [op1, cur, cust]) expect((await get(S, "/api/admin/metrics", t)).status).toBe(403);
    expect((await get(S, "/api/admin/metrics")).status).toBe(401);
    const m = await metrics();
    expect(Object.keys(m).sort()).toEqual(["jobs", "limitOutcomeTotals", "limitOutcomes", "process", "requests"]);
    expect(Object.keys(m.process).sort()).toEqual(["rssBytes", "uptimeSeconds"]);
    expect(m.process.rssBytes).toBeGreaterThan(0);
    expect(m.requests.total).toBeGreaterThan(0);
    // every leaf is a number, except the names of limits, outcomes, status classes and security domains
    const strings: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (typeof v === "string") strings.push(`${path}=${v}`);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      else expect(typeof v, path).toBe("number");
    };
    walk(m, "");
    for (const str of strings) expect(str).toMatch(/^\.limitOutcomes\.\d+\.(outcome=(OVER_LIMIT|TIMEOUT|CANCELLED)|limit=[a-z_]+)$/);
    const text = JSON.stringify(m);
    for (const secret of ["op-1", "op-2", "admin-1", "aud-1", "JOB-", "Bearer", "d03a", "/api/", S.token("op-1").slice(0, 12), "slot-", "cancel-"]) expect(text).not.toContain(secret);
    expect(m.limitOutcomes.length).toBeGreaterThan(0);
  });
});

describe("6. surfaces", () => {
  it("the customer surface refuses cancel and metrics with surface-forbidden; the internal surface serves them", async () => {
    const users = [
      { sub: "admin-1", roles: ["ADMIN" as const] },
      { sub: "op-1", roles: ["ACT-01" as const] },
    ];
    const customer = await start({ mode: "oidc", surface: "customer", users });
    for (const [res] of [[await get(customer, "/api/admin/metrics", customer.token("admin-1"))], [await post(customer, "/api/jobs/JOB-x/cancel", { reason: "r" }, customer.token("admin-1"))]] as const) {
      expect(res.status).toBe(403);
      expect((await json(res)).code).toBe("surface-forbidden");
    }
    const internal = await start({ mode: "oidc", surface: "internal", users });
    expect((await get(internal, "/api/admin/metrics", internal.token("admin-1"))).status).toBe(200);
    expect((await post(internal, "/api/jobs/JOB-x/cancel", { reason: "r" }, internal.token("op-1"))).status).toBe(404);
  });

  it("the role matrix grants job:cancel to ACT-01 and ADMIN, and metrics:read to ADMIN and AUDITOR, and to no other role", () => {
    const holders = (a: string) => Object.entries(ROLE_ACTION_MATRIX).filter(([, acts]) => (acts as readonly string[]).includes(a)).map(([r]) => r).sort();
    expect(holders("job:cancel")).toEqual(["ACT-01", "ADMIN"]);
    expect(holders("metrics:read")).toEqual(["ADMIN", "AUDITOR"]);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. Request id and the six-field public log hook (D8-04)
// ---------------------------------------------------------------------------------------------

describe("7. request id and public log hook", () => {
  it("every request completes with one log entry of exactly six fields, a route template and the server's own request id", async () => {
    const entries: PublicLogEntry[] = [];
    const s = await start({ patch: { http: { max_request_body_bytes: 1000 } as never }, extra: { log: (e) => entries.push(e) } });
    const calls: Array<{ run: () => Promise<Response>; route: string; status: number }> = [
      { run: () => get(s, "/api/health", undefined, { "X-Request-Id": "attacker-chosen-id" }), route: "GET /api/health", status: 200 },
      { run: () => get(s, "/api/jobs"), route: "GET /api/jobs", status: 200 },
      { run: () => get(s, "/api/jobs/JOB-CANARY-9f3a"), route: "GET /api/jobs/:id", status: 404 },
      { run: () => post(s, "/api/jobs/JOB-CANARY-9f3a/cancel", { reason: "CANARY reason" }), route: "POST /api/jobs/:id/cancel", status: 404 },
      { run: () => get(s, "/api/zzz/CANARY-path?secret=CANARY-query"), route: "GET /api/:unmatched", status: 404 },
      { run: () => fetch(`${s.baseUrl}/api/jobs`, { method: "PATCH", headers: headers() }), route: "PATCH /api/:unmatched", status: 404 },
      { run: () => post(s, "/api/jobs/JOB-x/cancel", "x".repeat(2000)), route: "POST /api/jobs/:id/cancel", status: 413 },
      { run: () => get(s, "/some/CANARY/static/path"), route: "GET /:static", status: 404 },
    ];
    const ids: string[] = [];
    for (const [i, c] of calls.entries()) {
      const res = await c.run();
      expect(res.status, c.route).toBe(c.status);
      ids.push(res.headers.get("x-request-id") ?? "");
      await until(() => entries.length === i + 1);
    }
    expect(entries).toHaveLength(calls.length); // exactly one per completed request
    for (const [i, e] of entries.entries()) {
      expect(Object.keys(e)).toEqual(["ts", "level", "event", "request_id", "route", "status"]);
      expect(e.event).toBe("request");
      expect(e.route).toBe(calls[i]!.route);
      expect(e.status).toBe(calls[i]!.status);
      expect(e.request_id).toBe(ids[i]);
      expect(() => toPublicLogLine(e)).not.toThrow(); // passes the strict allow-list of D8-04
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).not.toBe("attacker-chosen-id");
    expect(JSON.stringify(entries)).not.toMatch(/CANARY|secret|attacker/);
  });

  it("route templates never carry a raw value", () => {
    const table: Array<[string, string, string]> = [
      ["GET", "/api/records/M-1/B-9/history?x=1", "GET /api/records/:model/:batch/history"],
      ["POST", "/api/admin/users/someone%40example.org/roles/revoke", "POST /api/admin/users/:sub/roles/revoke"],
      ["GET", `/api/evidence/${"a".repeat(64)}`, "GET /api/evidence/:sha256"],
      ["GET", "/api/evidence/not-a-digest", "GET /api/:unmatched"],
      ["HEAD", "/api/jobs", "HEAD /api/jobs"],
      ["BREW", "/api/jobs", "OTHER /api/:unmatched"],
      ["GET", "/assets/index-abc123.js", "GET /:static"],
    ];
    for (const [m, url, want] of table) {
      const got = routeTemplate(m, url);
      expect(got).toBe(want);
      expect(got).not.toMatch(/M-1|B-9|someone|abc123|a{8}|@/); // no value of the URL in a template
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 8. Migration 0007: v6 -> v7 -> v6 -> v7 keeps the store checksum
// ---------------------------------------------------------------------------------------------

describe("8. migration 0007 round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "dpp-c8-mig-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("preserves computeStoreChecksum across v6 -> v7 -> v6 -> v7 and leaves v1 to v6 untouched", async () => {
    const pack = await loadPack();
    const db = new SqliteAdapter({ path: join(dir, "v6.sqlite") });
    try {
      migrateUp(db, 6);
      const frozen = db.query<{ version: number; checksum: string }>("SELECT version, checksum FROM schema_migrations ORDER BY version");
      expect(frozen.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6]);
      new PolicyStore(db).activate(pack.policy.retention, NOW);
      const runner = new ImportJobRunner(db, pack, undefined, { now: () => NOW });
      const erp = fixtureBytes("n", CLEAN.erp);
      const lab = fixtureBytes("n", CLEAN.lab);
      expect((await runner.runImportJob({ idempotencyKey: "mig-1", actor: OPERATOR, erp: { bytes: erp, name: CLEAN.erp, type: "text/csv" }, lab: { bytes: lab, name: CLEAN.lab, type: "application/json" } })).ok).toBe(true);
      expect((await runner.runImportJob({ idempotencyKey: "mig-bad", actor: OPERATOR, erp: { bytes: new TextEncoder().encode("not,a,valid,erp"), name: "bad.csv", type: "text/csv" } })).ok).toBe(false);
      const baseline = computeStoreChecksum(db);

      migrateUp(db, 7);
      expect(currentMigrationVersion(db)).toBe(7);
      expect(computeStoreChecksum(db)).toBe(baseline);
      expect(db.query<{ version: number; checksum: string }>("SELECT version, checksum FROM schema_migrations WHERE version <= 6 ORDER BY version")).toEqual(frozen);
      // the new tables take rows, they are part of the checksum once they hold rows, and both are append-only (V1-04)
      const job = runner.listJobs()[0]!;
      db.run("INSERT INTO job_submitters (job_id, claim_seq, security_domain, submitter_sub, recorded_at) VALUES (?, 1, 'default', 'op-1', ?)", job.jobId, NOW);
      runner.recordCancellation(job.jobId, "op-1", "round trip");
      const withRows = computeStoreChecksum(db);
      expect(withRows).not.toBe(baseline);
      expect(computeStoreChecksum(db, { includeJobControl: false })).toBe(baseline);
      for (const sql of [
        "UPDATE job_cancellations SET reason = 'edited'",
        "DELETE FROM job_cancellations",
        "INSERT OR REPLACE INTO job_cancellations (job_id, claim_seq, security_domain, requested_by, reason, outcome, requested_at) SELECT job_id, claim_seq, security_domain, 'other', 'replaced', outcome, requested_at FROM job_cancellations",
        "UPDATE job_submitters SET submitter_sub = 'someone-else'",
        "DELETE FROM job_submitters",
        "INSERT OR REPLACE INTO job_submitters (job_id, claim_seq, security_domain, submitter_sub, recorded_at) SELECT job_id, claim_seq, security_domain, 'other', recorded_at FROM job_submitters",
      ]) {
        expect(() => db.run(sql), sql).toThrow(/append-only/i);
      }
      expect(computeStoreChecksum(db)).toBe(withRows); // none of the refused statements changed anything

      // Rolling back to v6 drops the submitter and cancellation history: that data loss is accepted for this rollback (see the
      // comment of migration 0007). The v6 checksum is the baseline again, as it never covered these tables.
      migrateDown(db, 6);
      expect(currentMigrationVersion(db)).toBe(6);
      expect(computeStoreChecksum(db)).toBe(baseline);
      expect(db.get("SELECT name FROM sqlite_master WHERE name IN ('job_submitters', 'job_cancellations')")).toBeUndefined();

      migrateUp(db, 7);
      expect(currentMigrationVersion(db)).toBe(7);
      expect(computeStoreChecksum(db)).toBe(baseline);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 9. Control characters and the ingress deadline clock (fix round)
// ---------------------------------------------------------------------------------------------

describe("9. control characters in source files", () => {
  it("refuses NUL and other C0 characters in a CSV cell and in a JSON string, without echoing the value", async () => {
    const { importErpCsv, importLabJson, ERROR_TEXT } = await import("../../src/model/ingress");
    const pack = await loadPack();
    const enc = (t: string) => new TextEncoder().encode(t);
    const erp = text(CLEAN.erp);
    for (const bad of ["\u0000", "\u0001", "\u001b"]) {
      const r = await importErpCsv(pack, { bytes: enc(erp.replace("DEMO-PM", `D${bad}EMO-PM`)), name: CLEAN.erp, type: "text/csv" });
      expect(r.ok).toBe(false);
      expect(r.ok ? [] : r.errors.map((e) => e.code)).toEqual(["control-character"]);
      expect(JSON.stringify(r)).not.toContain(bad);
    }
    // CR, LF and the delimiter are still fine; the clean file is unchanged
    expect((await importErpCsv(pack, { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" })).ok).toBe(true);
    const lab = text(CLEAN.lab);
    const escaped = lab.replace('"EN AW-5754"', '"EN AW\\u0000-5754"');
    expect(escaped).not.toBe(lab);
    const rl = await importLabJson(pack, { bytes: enc(escaped), name: CLEAN.lab, type: "application/json" });
    expect(rl.ok ? [] : rl.errors.map((e) => e.code)).toEqual(["control-character"]);
    const raw = lab.replace('"EN AW-5754"', '"EN AW\u0000-5754"');
    expect((await importLabJson(pack, { bytes: enc(raw), name: CLEAN.lab, type: "application/json" })).ok).toBe(false);
    expect(ERROR_TEXT["control-character"]).not.toMatch(/[{}"]/);
  });
});

describe("10. the ingress deadline runs on one injectable monotonic clock", () => {
  it("the N path (no job budget) times out when the injected clock passes the deadline, and nothing is stored", async () => {
    const pack = await loadPack();
    const dir = mkdtempSync(join(tmpdir(), "dpp-c8-clock-"));
    const db = new SqliteAdapter({ path: join(dir, "c.sqlite") });
    try {
      migrateUp(db);
      new PolicyStore(db).activate(pack.policy.retention, NOW);
      let t = 0;
      // every read of the clock moves it 20 s: the start is read once, the first deadline check reads it again
      const runner = new ImportJobRunner(db, pack, undefined, { now: () => NOW, clock: () => (t += 20_000) });
      const r = await runner.runImportJob({ idempotencyKey: "clock-1", actor: OPERATOR, erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" } });
      expect(r.ok).toBe(false);
      expect(r.errors?.[0]?.code).toBe("deadline");
      expect(r).toMatchObject({ outcome: "TIMEOUT", limit: "job_deadline_ms" });
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM snapshots")!.n).toBe(0);
      // a normal clock is unaffected
      const ok = await new ImportJobRunner(db, pack, undefined, { now: () => NOW }).runImportJob({ idempotencyKey: "clock-2", actor: OPERATOR, erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" } });
      expect(ok.ok).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 11. Server-admitted record size and the in-flight budget (D8-11)
// ---------------------------------------------------------------------------------------------

describe("11. server_record_max_bytes and max_inflight_record_bytes (D8-11)", () => {
  const pair = fixtureSize(CLEAN.erp) + fixtureSize(CLEAN.lab);
  const envelope = 256 * 1024;
  const base64Length = (n: number) => Math.ceil(n / 3) * 4;
  const limitPatch = (serverMax: number, extra: Record<string, number> = {}): LimitsPatch => ({
    coordinator: { server_record_max_bytes: serverMax, max_inflight_record_bytes: Math.max(serverMax * 2, 1024 * 1024), ...extra } as never,
  });

  it("the pinned values: the server limit is the load target and never above the browser limit, and one record always fits the budget", async () => {
    const pack = await loadPack();
    const l = pack.operationalLimits;
    expect(l.coordinator.server_record_max_bytes).toBe(l.targets.record_bytes_max);
    expect(l.coordinator.server_record_max_bytes).toBeLessThanOrEqual(l.execution.source_pair_max_bytes);
    expect(l.coordinator.max_inflight_record_bytes).toBeGreaterThanOrEqual(l.coordinator.server_record_max_bytes);
    // a power of two, in MiB
    expect(l.coordinator.server_record_max_bytes % (1024 * 1024)).toBe(0);
    expect(Math.log2(l.coordinator.server_record_max_bytes / (1024 * 1024)) % 1).toBe(0);
  });

  it("a pair of exactly server_record_max_bytes is imported, one byte more is 413 OVER_LIMIT server_record_max_bytes, and nothing is committed", async () => {
    const at = await start({ patch: limitPatch(pair) });
    const ok = await post(at, "/api/jobs/import", importBody({ key: "rec-at" }));
    expect(ok.status).toBe(200);
    expect((await json(ok)).ok).toBe(true);

    const over = await start({ patch: limitPatch(pair - 1) });
    const before = over.state();
    const refused = await post(over, "/api/jobs/import", importBody({ key: "rec-over" }));
    expect(refused.status).toBe(413);
    expect(await json(refused)).toMatchObject({ code: "too-large", outcome: "OVER_LIMIT", limit: "server_record_max_bytes" });
    expect(over.state()).toEqual(before); // no job, no snapshot, no log entry
  });

  it("an ERP file alone is measured too, and the lab file counts toward the pair", async () => {
    const erp = fixtureSize(CLEAN.erp);
    const s = await start({ patch: limitPatch(erp) });
    expect((await post(s, "/api/jobs/import", importBody({ key: "erp-only", lab: null }))).status).toBe(200);
    const t = await start({ patch: limitPatch(erp) });
    const both = await post(t, "/api/jobs/import", importBody({ key: "erp-lab" }));
    expect(both.status).toBe(413);
    expect(await json(both)).toMatchObject({ limit: "server_record_max_bytes", outcome: "OVER_LIMIT" });
  });

  it("a declared length over the record body cap is refused before a byte of it is read", async () => {
    const s = await start({ patch: limitPatch(pair) });
    const cap = base64Length(pair) + envelope;
    const over = await rawPost(s.port, { contentLength: cap + 1, chunkBytes: 1024, chunks: 3, path: "/api/jobs/import" });
    expect(over.status).toBe(413);
    expect(over.sentBeforeAnswer).toBeLessThan(8 * 1024);
  });

  it("an undeclared (chunked) import body is cut off at the record body cap, not buffered", async () => {
    const s = await start({ patch: limitPatch(pair) });
    const cap = base64Length(pair) + envelope;
    const result = await new Promise<{ status: number; written: number; body: Record<string, unknown> }>((resolve, reject) => {
      let written = 0;
      let answered = false;
      const req = httpRequest(
        { host: "127.0.0.1", port: s.port, method: "POST", path: "/api/jobs/import", headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" } },
        (res) => {
          answered = true;
          let data = "";
          res.on("data", (d) => (data += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, written, body: JSON.parse(data) }));
        },
      );
      req.on("error", (e) => (answered ? undefined : reject(e)));
      req.write('{"idempotencyKey":"chunked","erp":{"base64":"');
      const timer = setInterval(() => {
        if (answered || written > cap * 8) {
          clearInterval(timer);
          req.destroy();
          return;
        }
        written += 16 * 1024;
        req.write("A".repeat(16 * 1024));
      }, 1);
    });
    expect(result.status).toBe(413);
    expect(result.body).toMatchObject({ code: "too-large", outcome: "OVER_LIMIT", limit: "server_record_max_bytes" });
    expect(result.written).toBeLessThan(cap * 4);
  });

  it("the in-flight budget serialises two max-size jobs although the coordinator has free slots; they commit in arrival order", async () => {
    const body = importBody({ key: "inflight-1" });
    const one = Buffer.byteLength(body);
    const order: string[] = [];
    const gates = new Map<string, ReturnType<typeof gate>>();
    const s = await start({
      mode: "oidc",
      users: [{ sub: "admin-1", roles: ["ADMIN"] }, { sub: "op-1", roles: ["ACT-01"] }, { sub: "op-2", roles: ["ACT-01"] }],
      // two active slots per domain and in total, and a budget for one record and a half: only the byte budget can hold the second back
      patch: limitPatch(pair, { max_active_jobs_per_security_domain: 2, max_active_jobs_total: 4, max_inflight_record_bytes: Math.floor(one * 1.5) }),
      extra: {
        testHooks: {
          stageHook: async (stage, { jobId }) => {
            if (stage !== "received") return;
            order.push(jobId);
            const g = gate();
            gates.set(jobId, g);
            await g.promise;
          },
        },
      },
    });
    const [admin, op1, op2] = ["admin-1", "op-1", "op-2"].map((u) => s.token(u));
    const metrics = async () => json(await get(s, "/api/admin/metrics", admin));
    const r1 = post(s, "/api/jobs/import", importBody({ key: "inflight-1" }), op1);
    await until(() => order.length === 1);
    const r2 = post(s, "/api/jobs/import", importBody({ key: "inflight-2" }), op2);
    await until(async () => (await metrics()).jobs.queuedTotal === 1);
    const m = await metrics();
    expect(m.jobs).toMatchObject({ activeTotal: 1, queuedTotal: 1 }); // a second slot was free, the byte budget held the job back
    await sleep(50);
    expect(order.length).toBe(1); // the queued job's body was not read and it did not start
    gates.get(order[0]!)!.open();
    expect((await r1).status).toBe(200);
    await until(() => order.length === 2);
    gates.get(order[1]!)!.open();
    expect((await r2).status).toBe(200);
    expect((await metrics()).jobs).toMatchObject({ activeTotal: 0, queuedTotal: 0 });
  });

  it("a budget that holds two records runs them side by side, and a full queue is still 429", async () => {
    const one = Buffer.byteLength(importBody({ key: "inflight-a" }));
    const order: string[] = [];
    const gates = new Map<string, ReturnType<typeof gate>>();
    const s = await start({
      mode: "oidc",
      users: [{ sub: "admin-1", roles: ["ADMIN"] }, { sub: "op-1", roles: ["ACT-01"] }, { sub: "op-2", roles: ["ACT-01"] }, { sub: "op-3", roles: ["ACT-01"] }, { sub: "op-4", roles: ["ACT-01"] }],
      patch: limitPatch(pair, { max_active_jobs_per_security_domain: 2, max_queued_jobs_per_security_domain: 1, max_inflight_record_bytes: one * 2 + 10 }),
      extra: {
        testHooks: {
          stageHook: async (stage, { jobId }) => {
            if (stage !== "received") return;
            order.push(jobId);
            const g = gate();
            gates.set(jobId, g);
            await g.promise;
          },
        },
      },
    });
    const [admin, op1, op2, op3, op4] = ["admin-1", "op-1", "op-2", "op-3", "op-4"].map((u) => s.token(u));
    const a = post(s, "/api/jobs/import", importBody({ key: "inflight-a" }), op1);
    const b = post(s, "/api/jobs/import", importBody({ key: "inflight-b" }), op2);
    await until(() => order.length === 2); // both started together
    const c = post(s, "/api/jobs/import", importBody({ key: "inflight-c" }), op3); // waits: the budget and the slots are taken
    await until(async () => (await json(await get(s, "/api/admin/metrics", admin))).jobs.queuedTotal === 1);
    const d = await post(s, "/api/jobs/import", importBody({ key: "inflight-d" }), op4); // the queue holds one
    expect(d.status).toBe(429);
    expect(await json(d)).toMatchObject({ code: "queue-full", outcome: "OVER_LIMIT", limit: "queue_full" });
    for (const g of gates.values()) g.open();
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    await until(() => order.length === 3);
    gates.get(order[2]!)!.open();
    expect((await c).status).toBe(200);
  });
});
