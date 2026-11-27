// @vitest-environment node
/**
 * Cycle 8 validation round 2 (D8-12): regressions of the probes of V1, V2 and V4 on the real server.
 *
 *  - V1-06 / V2-08: no lane shared by all clients; a waiting client that leaves, a slow drip and chained drippers hold nothing for others
 *  - body_read_timeout_ms (408 TIMEOUT, the socket destroyed, the slot and bytes freed) and idle_socket_timeout_ms
 *  - V1-07 / V2-09: the slot is free when the job ends, and the answer is a bounded summary: a client that never reads holds nothing
 *  - V2-11: an early 413 is read by the client before the connection closes
 *  - R2-01: a 2000-character name through /release does not stall the server; R2-02: the Origin header is capped
 */
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { sizedVariant } from "../../scripts/load.mjs";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN } from "../support/records";
import { NO_RATE_PRESSURE, get, importBody, post, sleep, startC8Server, until, b64, type C8Server, type LimitsPatch } from "../support/c8Server";

const json = async (r: Response) => (await r.json()) as Record<string, any>;
const open: C8Server[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const USERS = [
  { sub: "admin-1", roles: ["ACT-19" as const] },
  { sub: "op-1", roles: ["ACT-01" as const] },
  { sub: "op-2", roles: ["ACT-01" as const] },
  { sub: "op-3", roles: ["ACT-01" as const] },
];
const USERS_B = [{ sub: "op-b", roles: ["ACT-01" as const], domain: "dom-b" }];

async function start(patch: LimitsPatch = {}): Promise<C8Server> {
  const s = await startC8Server({
    mode: "oidc",
    domains: ["dom-b"],
    users: [...USERS, ...USERS_B],
    patch: { ...NO_RATE_PRESSURE, ...patch, http: { ...(NO_RATE_PRESSURE.http as object), ...((patch.http as object) ?? {}) } as never },
  });
  open.push(s);
  return s;
}

const metrics = async (s: C8Server) => (await json(await get(s, "/api/admin/metrics", s.token("admin-1")))) as { jobs: { activeTotal: number; queuedTotal: number }; limitOutcomes: Array<{ outcome: string; limit: string; count: number }> };
const idle = (s: C8Server) => until(async () => {
  const m = await metrics(s);
  return m.jobs.activeTotal === 0 && m.jobs.queuedTotal === 0;
}, 8000);

interface Raw {
  s: Socket;
  data: () => string;
  closed: () => boolean;
}
/** An import request on a raw socket: the headers, and as much of the body as `send` says. */
function raw(s: C8Server, token: string, body: string, send: "all" | "half" | "none", extraHeaders = "", chunked = false): Raw {
  const sock = connect(s.port, "127.0.0.1");
  let data = "";
  let closed = false;
  sock.on("data", (d) => (data += d.toString("latin1")));
  sock.on("close", () => (closed = true));
  sock.on("error", () => undefined);
  sock.write(
    `POST /api/jobs/import HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\n${extraHeaders}` +
      (chunked ? "Transfer-Encoding: chunked\r\n\r\n" : `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`),
  );
  if (send === "all") sock.write(body);
  if (send === "half") sock.write(body.slice(0, Math.floor(body.length / 2)));
  return { s: sock, data: () => data, closed: () => closed };
}
const drip = (r: Raw, everyMs: number) => {
  const t = setInterval(() => {
    if (r.s.writable) r.s.write("1\r\n \r\n");
    else clearInterval(t);
  }, everyMs);
  return () => clearInterval(t);
};
const importAs = (s: C8Server, user: string, key: string, headers: Record<string, string> = {}, body = importBody({ key })) => post(s, "/api/jobs/import", body, s.token(user), headers);

describe("V1-06 and V2-08: no lane shared by all clients", () => {
  it("a client that leaves while its request waits for a slot leaves no stuck slot, and new imports proceed", async () => {
    const s = await start({ coordinator: { max_active_jobs_per_security_domain: 1 } as never });
    const slow = raw(s, s.token("op-1"), importBody({ key: "lane-slow" }), "half"); // holds the only slot while it reads
    await until(async () => (await metrics(s)).jobs.activeTotal === 1);
    const gone = raw(s, s.token("op-2"), importBody({ key: "lane-gone" }), "all"); // admitted, waits in the queue
    await until(async () => (await metrics(s)).jobs.queuedTotal === 1);
    gone.s.destroy();
    await until(async () => (await metrics(s)).jobs.queuedTotal === 0);
    slow.s.destroy(); // the slot is freed by the abort
    const t0 = performance.now();
    const next = await Promise.race([importAs(s, "op-1", "lane-after"), sleep(8000).then(() => null)]);
    expect(next, "the next import hung").not.toBeNull();
    expect(next!.status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(3000);
    await idle(s);
  }, 30_000);

  it("a client that leaves after the slot was granted but before it sent a byte is not waited for", async () => {
    const s = await start({ coordinator: { max_active_jobs_per_security_domain: 1 } as never });
    const a = raw(s, s.token("op-1"), importBody({ key: "gone-1" }), "none");
    await until(async () => (await metrics(s)).jobs.activeTotal === 1);
    const b = raw(s, s.token("op-2"), importBody({ key: "gone-2" }), "none"); // queued behind a
    await until(async () => (await metrics(s)).jobs.queuedTotal === 1);
    b.s.destroy(); // b leaves while queued, with its destroyed request waiting for a place
    a.s.destroy();
    await idle(s);
    expect((await importAs(s, "op-3", "gone-after")).status).toBe(200);
  }, 30_000);

  it("a slow drip in domain A does not delay a small import in domain B beyond its normal latency plus a small bound", async () => {
    const s = await start({ http: { body_read_timeout_ms: 4000 } as never });
    const t0 = performance.now();
    expect((await importAs(s, "op-b", "b-baseline", { "X-Security-Domain": "dom-b" })).status).toBe(200);
    const baseline = performance.now() - t0;
    const dripper = raw(s, s.token("op-1"), "", "none", "", true);
    const stop = drip(dripper, 100);
    await until(async () => (await metrics(s)).jobs.activeTotal === 1);
    const t1 = performance.now();
    const r = await importAs(s, "op-b", "b-during-drip", { "X-Security-Domain": "dom-b" });
    const during = performance.now() - t1;
    stop();
    dripper.s.destroy();
    expect(r.status).toBe(200);
    process.stderr.write(`[R2] domain B import: baseline ${baseline.toFixed(0)} ms, during a drip in A ${during.toFixed(0)} ms\n`);
    expect(during).toBeLessThan(baseline + 1000);
  }, 30_000);

  it("two chained chunked drippers: byte budget caps concurrent unknown-length reads, domain B proceeds immediately, and domain A waits only for the body timeouts", async () => {
    const s = await start({ http: { body_read_timeout_ms: 700 } as never });
    const d1 = raw(s, s.token("op-1"), "", "none", "", true);
    const d2 = raw(s, s.token("op-2"), "", "none", "", true);
    const stops = [drip(d1, 100), drip(d2, 100)];
    // Each chunked request conservatively reserves importCap (~2.92 MiB) against max_inflight_record_bytes (4 MiB), so d1 is active and d2 waits in domain A's queue.
    await until(async () => {
      const m = await metrics(s);
      return m.jobs.activeTotal === 1 && m.jobs.queuedTotal === 1;
    });
    const t0 = performance.now();
    const other = await importAs(s, "op-b", "chain-b", { "X-Security-Domain": "dom-b" });
    expect(other.status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(1500); // not behind the drippers
    const honest = await importAs(s, "op-3", "chain-a"); // queued behind d2 in domain A: waits for d1 then d2 to hit body_read_timeout_ms
    const waited = performance.now() - t0;
    stops.forEach((f) => f());
    expect(honest.status).toBe(200);
    expect(waited).toBeLessThan(2 * 700 + 3000);
    // both drippers were answered 408 and cut off
    await until(() => d1.closed() && d2.closed(), 5000);
    for (const d of [d1, d2]) expect(d.data()).toMatch(/^HTTP\/1\.1 408 /);
    await idle(s);
  }, 30_000);

  it("two parallel declared-length drippers filling domain A's slots: domain B proceeds immediately and domain A waits only one body timeout", async () => {
    const s = await start({ http: { body_read_timeout_ms: 700 } as never });
    const smallBody = importBody({ key: "slot-drip" });
    const d1 = raw(s, s.token("op-1"), smallBody, "half");
    const d2 = raw(s, s.token("op-2"), smallBody, "half");
    await until(async () => (await metrics(s)).jobs.activeTotal === 2);
    const t0 = performance.now();
    const other = await importAs(s, "op-b", "par-b", { "X-Security-Domain": "dom-b" });
    expect(other.status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(1500);
    const honest = await importAs(s, "op-3", "par-a"); // both domain A slots are held in parallel: waits for one body_read_timeout_ms
    const waited = performance.now() - t0;
    expect(honest.status).toBe(200);
    expect(waited).toBeLessThan(700 + 3000);
    await until(() => d1.closed() && d2.closed(), 5000);
    for (const d of [d1, d2]) expect(d.data()).toMatch(/^HTTP\/1\.1 408 /);
    await idle(s);
  }, 30_000);
});

describe("body_read_timeout_ms and idle_socket_timeout_ms (D8-12)", () => {
  it("a body that does not arrive in time is 408 TIMEOUT body_read_timeout_ms, the socket is destroyed, and the slot and bytes are free", async () => {
    const s = await start({ http: { body_read_timeout_ms: 300 } as never });
    const r = raw(s, s.token("op-1"), importBody({ key: "slow-body" }), "half");
    await until(() => r.closed(), 5000);
    const text = r.data();
    expect(text).toMatch(/^HTTP\/1\.1 408 /);
    expect(JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4))).toMatchObject({ code: "body-timeout", outcome: "TIMEOUT", limit: "body_read_timeout_ms" });
    await idle(s);
    expect((await metrics(s)).limitOutcomes).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "TIMEOUT", limit: "body_read_timeout_ms" })]));
    expect(s.state().snapshots).toBe(0); // nothing was committed
    expect((await importAs(s, "op-1", "after-timeout")).status).toBe(200);
  }, 30_000);

  it("a body that arrives within the time is read", async () => {
    const s = await start({ http: { body_read_timeout_ms: 5000 } as never });
    expect((await importAs(s, "op-1", "fast")).status).toBe(200);
  });

  it("the time counts from the grant of the slot, not from the arrival of the request: a request that waited in the queue gets its full time", async () => {
    const s = await start({ http: { body_read_timeout_ms: 1500 } as never, coordinator: { max_active_jobs_per_security_domain: 1 } as never });
    const holder = raw(s, s.token("op-1"), importBody({ key: "holder" }), "half");
    await until(async () => (await metrics(s)).jobs.activeTotal === 1);
    const waiting = importAs(s, "op-2", "waits"); // sent in full at once, then queued for more than the timeout
    await until(async () => (await metrics(s)).jobs.queuedTotal === 1);
    await sleep(900);
    holder.s.destroy();
    expect((await waiting).status).toBe(200);
  }, 30_000);

  it("a socket that moves no byte for idle_socket_timeout_ms is destroyed", async () => {
    const s = await start({ http: { idle_socket_timeout_ms: 300 } as never });
    const sock = connect(s.port, "127.0.0.1");
    let closed = false;
    sock.on("close", () => (closed = true));
    sock.on("error", () => undefined);
    const t0 = performance.now();
    await until(() => closed, 4000);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("V1-07 and V2-09: a client that does not read its answer holds nothing", () => {
  const pairBody = (key: string, n: number) => {
    const w = sizedVariant(n, 2_000_000);
    return JSON.stringify({
      idempotencyKey: key,
      erp: { name: CLEAN.erp, type: "text/csv", base64: w.erp.toString("base64") },
      lab: { name: CLEAN.lab, type: "application/json", base64: w.lab.toString("base64") },
    });
  };

  it("the import answer is a bounded summary: job, receipt, keys, versions and digests, not the record", async () => {
    const s = await start();
    const res = await importAs(s, "op-1", "summary", {}, pairBody("summary", 11));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text.length).toBeLessThan(30_000); // the record of a 2 MB pair is several MB
    const answer = JSON.parse(text);
    expect(answer.snapshot).toMatchObject({ version: 1, model: expect.any(String), batch: expect.any(String), digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(answer.snapshot.record).toEqual({ model: answer.snapshot.model, batch: answer.snapshot.batch, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(answer.snapshot.record.values).toBeUndefined();
    expect(answer.job).toMatchObject({ state: "committed" });
    expect(answer.receipt).toMatchObject({ version: 1, stored: true });
    // the record itself is read from its history
    const hist = await json(await get(s, `/api/records/${encodeURIComponent(answer.snapshot.model)}/${encodeURIComponent(answer.snapshot.batch)}/history`, s.token("op-1")));
    expect(hist.history[0].record.digest).toBe(answer.snapshot.record.digest);
    expect(hist.history[0].record.values.length).toBeGreaterThan(10);
  });

  it("a paused-reader client cannot block later large imports, from the same domain or another", async () => {
    const s = await start();
    const paused = raw(s, s.token("op-1"), pairBody("paused", 21), "all");
    paused.s.pause(); // never reads the answer
    await until(async () => s.state().snapshots === 1, 10_000);
    await sleep(500);
    const m = await metrics(s);
    expect(m.jobs).toMatchObject({ activeTotal: 0, queuedTotal: 0 }); // the slot and the bytes went back when the job ended
    const t0 = performance.now();
    const same = await Promise.race([importAs(s, "op-2", "after-same", {}, pairBody("after-same", 22)), sleep(10_000).then(() => null)]);
    const other = await Promise.race([importAs(s, "op-b", "after-other", { "X-Security-Domain": "dom-b" }, pairBody("after-other", 23)), sleep(10_000).then(() => null)]);
    paused.s.destroy();
    expect(same?.status).toBe(200);
    expect(other?.status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(8000);
  }, 60_000);
});

describe("V2-11: an early refusal is read by the client", () => {
  it("a declared body over the cap is answered 413 and the client reads the whole answer while it is still sending; nothing of the body is kept", async () => {
    const s = await start();
    const declared = 29_000_000;
    const result = await new Promise<{ data: string; sent: number }>((resolve) => {
      const c = connect(s.port, "127.0.0.1");
      let data = "";
      let sent = 0;
      c.on("data", (d) => (data += d.toString("latin1")));
      c.on("error", () => undefined);
      c.on("close", () => resolve({ data, sent }));
      c.on("connect", () => {
        c.write(`POST /api/jobs/import HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nAuthorization: Bearer ${s.token("op-1")}\r\nContent-Type: application/json\r\nContent-Length: ${declared}\r\n\r\n`);
        const chunk = Buffer.alloc(1 << 20, 0x41);
        const timer = setInterval(() => {
          if (sent >= declared || c.destroyed) return clearInterval(timer);
          const n = Math.min(chunk.length, declared - sent);
          sent += n;
          c.write(chunk.subarray(0, n));
        }, 5);
      });
    });
    expect(result.data).toMatch(/^HTTP\/1\.1 413 /);
    expect(result.data).toMatch(/\r\nConnection: close\r\n/i); // RT-21: preserve Connection: close on early 413
    expect(JSON.parse(result.data.slice(result.data.indexOf("\r\n\r\n") + 4))).toMatchObject({ code: "too-large", outcome: "OVER_LIMIT", limit: "server_record_max_bytes" });
    expect(result.sent).toBeGreaterThan(1 << 20); // it was still sending when the answer came, and was not reset before it read it
  }, 30_000);
});

describe("R2-01 and R2-02 on the main thread", () => {
  it("a 2000-character product name, in short words and in one word, is released without stalling the server", async () => {
    const s = await startC8Server({ patch: NO_RATE_PRESSURE });
    open.push(s);
    const erp = new TextDecoder().decode(fixtureBytes("n", CLEAN.erp));
    for (const [i, name] of ["ab cd ef gh ".repeat(167).slice(0, 2000).trim().padEnd(2000, "x"), "W".repeat(2000)].entries()) {
      const body = JSON.stringify({
        idempotencyKey: `long-${i}`,
        erp: { name: CLEAN.erp, type: "text/csv", base64: b64(new TextEncoder().encode(erp.replace("Stand-in 5754 aluminium sheet", name).replaceAll("ST-LOT-2026-001", `ST-LOT-2026-90${i}`))) },
        lab: { name: CLEAN.lab, type: "application/json", base64: b64(new TextEncoder().encode(new TextDecoder().decode(fixtureBytes("n", CLEAN.lab)).replaceAll("ST-LOT-2026-001", `ST-LOT-2026-90${i}`))) },
      });
      const imp = await json(await post(s, "/api/jobs/import", body));
      expect(imp.ok, JSON.stringify(imp.errors)).toBe(true);
      const { model, batch } = imp.snapshot;
      let worstHealth = 0;
      let stop = false;
      const probe = (async () => {
        while (!stop) {
          const t = performance.now();
          await get(s, "/api/health");
          worstHealth = Math.max(worstHealth, performance.now() - t);
          await sleep(5);
        }
      })();
      const t0 = performance.now();
      const rel = await post(s, `/api/customer/records/${encodeURIComponent(model)}/${encodeURIComponent(batch)}/release`, {});
      const ms = performance.now() - t0;
      stop = true;
      await probe;
      process.stderr.write(`[R2-01] release of a 2000-character name (${i}): ${rel.status} in ${ms.toFixed(0)} ms, worst health ${worstHealth.toFixed(0)} ms\n`);
      expect([200, 409]).toContain(rel.status);
      expect(ms).toBeLessThan(2000);
      expect(worstHealth).toBeLessThan(500);
    }
  }, 60_000);

  it("an Origin longer than 256 characters is refused at once with fixed text, and a header of slashes costs nothing", async () => {
    const s = await startC8Server({ patch: NO_RATE_PRESSURE });
    open.push(s);
    const withOrigin = (origin: string) =>
      new Promise<{ status: number; body: string; ms: number }>((resolve, reject) => {
        const t0 = performance.now();
        const req = httpRequest({ host: "127.0.0.1", port: s.port, path: "/api/health", headers: { Origin: origin } }, (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body, ms: performance.now() - t0 }));
        });
        req.on("error", reject);
        req.end();
      });
    const same = await withOrigin(`http://127.0.0.1:${s.port}`);
    expect(same.status).toBe(200);
    const trailing = await withOrigin(`http://127.0.0.1:${s.port}/`);
    expect(trailing.status).toBe(200); // a trailing slash is still trimmed
    for (const origin of ["h".repeat(257), `http://${"a".repeat(300)}`, "/".repeat(12_000)]) {
      const r = await withOrigin(origin);
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body)).toMatchObject({ code: "origin-not-allowed", message: "Cross-origin requests are not accepted from this origin" });
      expect(r.ms).toBeLessThan(100);
    }
    const edge = await withOrigin("h".repeat(256));
    expect(edge.status).toBe(403); // within the cap: judged on its merits (not this server)
    expect(JSON.parse(edge.body).code).toBe("origin-not-allowed");
  });
});
