// @vitest-environment node
/**
 * Cycle 8 Round 1 fixes (D8-10): worker-isolated ingress, bounded memory before admission, linear-time ingress, identifier hygiene,
 * per-run cancel authorisation, and fixed error bodies. Real server, ephemeral port, temp SQLite.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IngressRunner } from "../../server/jobs/ingressRunner";
import { firstInvalidUtf8, importErpCsv, importLabJson, MAX_IDENTIFIER_LENGTH } from "../../src/model/ingress";
import { startChild, type Child } from "../support/c8Child";
import { sizedVariant } from "../../scripts/load.mjs";
import { fixtureBytes } from "../support/fixtures";
import { ACCEPTED_ERP, ACCEPTED_LAB, CLEAN, loadPack } from "../support/records";
import { b64, get, headers, importBody, limitsWith, NO_RATE_PRESSURE, post, sleep, startC8Server, until, type C8Server } from "../support/c8Server";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const out = (s: string) => process.stderr.write(`[C8-ISO] ${s}\n`);

const open: C8Server[] = [];
async function start(options: Parameters<typeof startC8Server>[0] = {}) {
  const s = await startC8Server({ ...options, patch: { ...NO_RATE_PRESSURE, ...(options.patch ?? {}), http: { ...(NO_RATE_PRESSURE.http as object), ...((options.patch?.http as object) ?? {}) } as never } });
  open.push(s);
  return s;
}
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** The clean lab file padded with one string so that it has exactly `bytes` bytes. */

/** A committable pair of about 20 MiB (both files near source_file_max_bytes), as an import body. */
function maxPairBody(key: string): string {
  const v = sizedVariant(4321, 20971520);
  return JSON.stringify({
    idempotencyKey: key,
    erp: { name: "erp-extract.csv", type: "text/csv", base64: v.erp.toString("base64") },
    lab: { name: "lab-assessment.json", type: "application/json", base64: v.lab.toString("base64") },
  });
}

/**
 * The records of this suite's worker tests are the S4 maximum (20 MiB), which the server pinned at `server_record_max_bytes` refuses (D8-11).
 * They are about the isolation of a large parse, not about the pin, so their server is configured for that size.
 */
const MAX_RECORD_SERVER: Parameters<typeof startC8Server>[0] = {
  patch: { coordinator: { server_record_max_bytes: 20971520, max_inflight_record_bytes: 2 * 20971520 } as never },
};

const OP = [{ sub: "op-1", roles: ["ACT-01" as const] }, { sub: "op-2", roles: ["ACT-01" as const] }, { sub: "admin-1", roles: ["ACT-19" as const] }];

describe("1. worker isolation of ingress (D8-10)", () => {
  const MAX_LAB = 10 * 1024 * 1024;

  it("cancel during a real max-size synchronous parse terminates the worker within forced_termination_max_ms", async () => {
    const ingress = new IngressRunner({ limits: limitsWith(await loadPack()) });
    const s = await start({ ...MAX_RECORD_SERVER, mode: "oidc", users: OP, extra: { testHooks: { ingress } } });
    const op = s.token("op-1");
    const body = maxPairBody("real-parse");
    const t0 = performance.now();
    const pending = fetch(`${s.baseUrl}/api/jobs/import`, { method: "POST", headers: headers(op), body });
    // wait until the job is running, then cancel from a separate client while the parse is in progress
    const jobId = await until(async () => ((await json(await get(s, "/api/jobs", s.token("admin-1")))).jobs as any[]).find((j) => j.idempotencyKey === "real-parse")?.jobId, 5000, 2);
    await sleep(40);
    const tc = performance.now();
    expect((await post(s, `/api/jobs/${jobId}/cancel`, { reason: "real parse cancel" }, op)).status).toBe(200);
    const res = await pending;
    const latency = performance.now() - tc;
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: "cancelled", outcome: "CANCELLED" });
    out(`cancel of a ${MAX_LAB}-byte parse: answered ${latency.toFixed(0)} ms after the cancel (${(performance.now() - t0).toFixed(0)} ms from start); worker terminate ${ingress.maxTerminationMs.toFixed(1)} ms`);
    expect(ingress.terminations).toBe(1);
    expect(ingress.maxTerminationMs).toBeLessThanOrEqual(s.limits.execution.forced_termination_max_ms);
    expect(latency).toBeLessThanOrEqual(s.limits.execution.forced_termination_max_ms);
    expect(s.state().snapshots).toBe(0);
    expect((await json(await get(s, `/api/jobs/${jobId}`, s.token("admin-1")))).job).toMatchObject({ state: "rolled_back", errorCode: "cancelled" });
  });

  it("a thread that never yields (synchronous spin) is terminated at the deadline: TIMEOUT, nothing committed", async () => {
    const ingress = new IngressRunner({ limits: limitsWith(await loadPack()) });
    const s = await start({ patch: { execution: { job_deadline_ms: 300 } as never }, extra: { testHooks: { ingress, workerSpinMs: 8000 } } });
    const before = s.state();
    const t0 = performance.now();
    const res = await post(s, "/api/jobs/import", importBody({ key: "spin" }));
    const elapsed = performance.now() - t0;
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ ok: false, outcome: "TIMEOUT", limit: "job_deadline_ms" });
    out(`spin of 8000 ms with a 300 ms deadline: answered after ${elapsed.toFixed(0)} ms; terminate ${ingress.maxTerminationMs.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(300 + s.limits.execution.forced_termination_max_ms);
    expect(ingress.maxTerminationMs).toBeLessThanOrEqual(s.limits.execution.forced_termination_max_ms);
    expect(s.state()).toEqual(before);
  });

  it("a worker that runs out of memory fails the job with execution-failed and outcome OVER_LIMIT; the slot is free and nothing is committed", async () => {
    const s = await start({ patch: { execution: { execution_memory_max_bytes: 64 * 1024 * 1024 } as never } });
    const before = s.state();
    // A file of the pinned record size (2 MiB) made only of line breaks: two million rows, each an array in the worker's heap. The worker's
    // heap is a quarter of the execution memory (32 MB here), so the parse runs out of memory long before any row limit is looked at.
    const body = JSON.stringify({ idempotencyKey: "oom", erp: { name: "erp-extract.csv", type: "text/csv", base64: Buffer.from(`model\n${"\n".repeat(2 * 1024 * 1024 - 8)}`).toString("base64") } });
    const res = await post(s, "/api/jobs/import", body);
    const answer = await json(res);
    expect(res.status).toBe(422);
    expect(answer.errors[0].code).toBe("execution-failed");
    expect(answer).toMatchObject({ ok: false, outcome: "OVER_LIMIT", limit: "execution_memory_max_bytes" });
    expect(s.state()).toEqual(before);
    expect(s.db.get<{ state: string; error_code: string }>("SELECT state, error_code FROM import_jobs WHERE idempotency_key = 'oom'")).toMatchObject({ state: "failed", error_code: "execution-failed" });
    // the server is fine and the slot is free: the next job runs
    expect((await post(s, "/api/jobs/import", importBody({ key: "after-oom" }))).status).toBe(200);
  });

  it("a worker that crashes is a job failure with the fixed code, not a server error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dpp-c8-crash-"));
    const entry = join(dir, "crash.mjs");
    writeFileSync(entry, 'import { parentPort } from "node:worker_threads"; parentPort.once("message", () => { throw new Error("CANARY-crash-detail"); });');
    try {
      const ingress = new IngressRunner({ limits: limitsWith(await loadPack()), entry });
      const s = await start({ extra: { testHooks: { ingress } } });
      const before = s.state();
      const res = await post(s, "/api/jobs/import", importBody({ key: "crash" }));
      const text = await res.text();
      expect(res.status).toBe(422);
      expect(JSON.parse(text).errors[0].code).toBe("execution-failed");
      expect(JSON.parse(text).outcome).toBeUndefined(); // only an out-of-memory stop is OVER_LIMIT
      expect(text).not.toContain("CANARY");
      expect(s.state()).toEqual(before);
      expect((await post(s, "/api/jobs/import", importBody({ key: "crash-2" }))).status).toBe(422); // same crash again, still clean
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the worker installs the egress guard and the bundle ships it (checked in the built worker)", async () => {
    const ingress = new IngressRunner({ limits: limitsWith(await loadPack()) });
    void ingress;
    const src = readFileSync(join(process.cwd(), "server/jobs/ingressWorker.ts"), "utf8");
    expect(src).toContain("installEgressGuard");
    expect(src).toContain('mode: "refuse"');
    expect(src).toContain("egress-allowlist.json");
  });

  it("a normal import through the worker still commits, with the same answer as before", async () => {
    const s = await start();
    const res = await post(s, "/api/jobs/import", importBody({ key: "normal" }));
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.snapshot.version).toBe(1);
  });
});

describe("2. memory before admission (V2-01)", () => {
  /** N concurrent bodies of `size` bytes against the BUILT server in a child process; returns its peak RSS. */
  async function flood(c: Child, n: number, size: number) {
    const head = Buffer.from('{"idempotencyKey":"k","erp":{"name":"a.csv","base64":"');
    const tail = Buffer.from('"}}');
    const fill = Buffer.alloc(size - head.length - tail.length, 0x41);
    const base = c.rss();
    let peak = base;
    const timer = setInterval(() => (peak = Math.max(peak, c.rss())), 25);
    const statuses = await Promise.all(
      Array.from({ length: n }, (_, i) => new Promise<string>((resolve) => {
        const sock = connect(c.port, "127.0.0.1");
        let data = "";
        sock.on("data", (d) => (data += d.toString()));
        sock.on("close", () => resolve(data.split("\r\n")[0] ?? "closed"));
        sock.on("error", () => resolve("error"));
        sock.on("connect", () => {
          sock.write(`POST /api/jobs/import HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${c.token(`op-${(i % 4) + 1}`)}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${size}\r\n\r\n`);
          sock.write(head);
          sock.write(fill);
          sock.write(tail);
        });
      })),
    );
    clearInterval(timer);
    peak = Math.max(peak, c.rss());
    return { statuses, base, peak };
  }

  // The largest body at which the coordinator still runs two jobs at once: half the in-flight byte budget (D8-11), so the slots and the queue
  // of one domain (2 + 8) are all usable, as they are for 29 MB bodies before the budget existed.
  const readableBody = async () => Math.floor((await loadPack()).operationalLimits.coordinator.max_inflight_record_bytes / 2);

  for (const n of [1, 4, 8, 12]) {
    it(`${n} concurrent bodies of half the in-flight budget keep the server's RSS inside max_rss_bytes (the place is taken before the body is read)`, async () => {
      // a fresh server process per N, so each peak is that run's own and not what earlier runs left behind
      const child: Child = await startChild({ admin: "admin-1", users: [1, 2, 3, 4].map((i) => ({ sub: `op-${i}`, roles: ["ACT-01"] })) });
      try {
        const { statuses, base, peak } = await flood(child, n, await readableBody());
        const tally = statuses.reduce((a: Record<string, number>, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});
        out(`N=${n}: ${JSON.stringify(tally)} server baseline ${(base / 2 ** 20).toFixed(0)} MiB, peak ${(peak / 2 ** 20).toFixed(0)} MiB`);
        expect(peak).toBeLessThanOrEqual(536870912); // targets.max_rss_bytes
        // a refused upload may see its connection closed while it is still sending (the 429 is sent first, then the socket is closed)
        for (const st of statuses) expect(st, st).toMatch(/^(error|HTTP\/1\.1 [24]\d\d.*)$/);
        expect(statuses.filter((x) => x !== "error").length).toBeGreaterThanOrEqual(Math.min(n, 10));
      } finally {
        await child.stop();
      }
    }, 120_000);
  }

  for (const n of [1, 4, 12]) {
    it(`${n} concurrent 29 MB bodies are refused 413 before a byte of them is read, and the server's RSS stays flat (D8-11)`, async () => {
      const child: Child = await startChild({ admin: "admin-1", users: [1, 2, 3, 4].map((i) => ({ sub: `op-${i}`, roles: ["ACT-01"] })) });
      try {
        const { statuses, base, peak } = await flood(child, n, 29 * 1024 * 1024);
        out(`29 MB x ${n} refused: ${JSON.stringify(statuses)} baseline ${(base / 2 ** 20).toFixed(0)} MiB, peak ${(peak / 2 ** 20).toFixed(0)} MiB`);
        // a refused upload that is still sending may see its connection reset before it reads the answer; one that reads it sees 413
        for (const st of statuses) expect(st, st).toMatch(/^(error|HTTP\/1\.1 413.*)$/);
        expect(peak - base).toBeLessThan(64 * 1024 * 1024); // nothing of the 29 MB bodies was buffered
      } finally {
        await child.stop();
      }
    }, 60_000);
  }

  it("a queue-full import is refused before its body is read", async () => {
    const s = await start({ mode: "oidc", users: OP, patch: { coordinator: { max_active_jobs_per_security_domain: 1, max_queued_jobs_per_security_domain: 1, max_active_jobs_total: 1 } as never }, extra: { testHooks: { stageHook: async (st) => { if (st === "received") await sleep(600); } } } });
    const op = s.token("op-1");
    const first = fetch(`${s.baseUrl}/api/jobs/import`, { method: "POST", headers: headers(op), body: importBody({ key: "q1" }) });
    await sleep(100);
    const second = fetch(`${s.baseUrl}/api/jobs/import`, { method: "POST", headers: headers(op), body: importBody({ key: "q2" }) });
    await sleep(100);
    // the third has a place for neither: raw socket, headers only, no body is ever sent
    const status = await new Promise<string>((resolve) => {
      const c = connect(s.port, "127.0.0.1");
      let d = "";
      c.on("data", (x) => ((d += x.toString()), resolve(d.split("\r\n")[0]!), c.destroy()));
      c.on("connect", () => c.write(`POST /api/jobs/import HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${op}\r\nContent-Type: application/json\r\nContent-Length: 2000000\r\n\r\n`));
    });
    expect(status).toContain("429");
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });
});

describe("3. linear-time ingress at the maximum legal sizes (V1-01, V4-01)", () => {
  it("an invalid UTF-8 byte at the very end of a 10 MiB file is found in one pass", async () => {
    const pack = await loadPack();
    const bytes = new Uint8Array(10 * 1024 * 1024).fill(0x41);
    bytes[bytes.length - 1] = 0xff;
    expect(firstInvalidUtf8(bytes)).toBe(bytes.length - 1);
    const t = performance.now();
    const r = await importErpCsv(pack, { bytes, name: "x.csv", type: "text/csv" });
    const ms = performance.now() - t;
    out(`10 MiB with the bad byte last: ${ms.toFixed(0)} ms`);
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toEqual(["wrong-encoding"]);
    expect(ms).toBeLessThan(2000);
    // the offsets agree with the standard decoder on small cases
    for (const b of [[0x41, 0xc3, 0x28], [0xe2, 0x82], [0xf0, 0x9f, 0x98], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0x41, 0x42]]) {
      const u = Uint8Array.from(b);
      let valid = true;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(u);
      } catch {
        valid = false;
      }
      expect(firstInvalidUtf8(u) === u.length, String(b)).toBe(valid);
    }
  });

  it("a very long number literal is refused at once, in a CSV cell and in JSON", async () => {
    const pack = await loadPack();
    const erp = dec(fixtureBytes("n", CLEAN.erp));
    const lab = dec(fixtureBytes("n", CLEAN.lab));
    for (const digits of [50_000, 1_000_000, 4_000_000]) {
      const zeros = "0".repeat(digits);
      const t = performance.now();
      const e = await importErpCsv(pack, { bytes: enc(erp.replace(",1.50,", `,1.${zeros}1,`)), name: CLEAN.erp, type: "text/csv" });
      const l = await importLabJson(pack, { bytes: enc(lab.replace('"value": 1.49,', `"value": 1.${zeros}1,`)), name: CLEAN.lab, type: "application/json" });
      const ms = performance.now() - t;
      // a CSV cell is a field, and a field is at most 2000 characters (R2-01): the cell is refused for its length; a JSON number is not a string and is refused for its precision
      expect(e.ok ? [] : e.errors.map((x) => x.code), `erp ${digits}`).toContain("field-too-long");
      expect(l.ok ? [] : l.errors.map((x) => x.code), `lab ${digits}`).toContain("precision-loss");
      expect(ms, `${digits} digits`).toBeLessThan(1500);
    }
  });

  it("trailing-zero numbers of the legal size stay linear", async () => {
    const pack = await loadPack();
    const erp = dec(fixtureBytes("n", CLEAN.erp));
    const t = performance.now();
    const e = await importErpCsv(pack, { bytes: enc(erp.replace(",1.50,", `,${"1" + "0".repeat(9_000_000)},`)), name: CLEAN.erp, type: "text/csv" });
    expect(e.ok).toBe(false);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("4. identifier hygiene (V4-03)", () => {
  const BAD = ["\u0085", "\u007f", "\u009f", "‮", "‪", "⁦", "⁩", "‎", "‏"];
  it("refuses C1 controls, DEL and bidi characters in identifier cells and JSON identifiers, with a code that does not echo the value", async () => {
    const pack = await loadPack();
    const erp = dec(fixtureBytes("n", CLEAN.erp));
    const lab = dec(fixtureBytes("n", CLEAN.lab));
    for (const ch of BAD) {
      const e = await importErpCsv(pack, { bytes: enc(erp.replace("ST-LOT-2026-001", `ST${ch}-LOT-2026-001`)), name: CLEAN.erp, type: "text/csv" });
      expect(e.ok, `erp U+${ch.charCodeAt(0).toString(16)}`).toBe(false);
      expect(e.ok ? [] : e.errors.map((x) => x.code)).toContain("unsafe-identifier");
      expect(JSON.stringify(e)).not.toContain(ch);
      const l = await importLabJson(pack, { bytes: enc(lab.replace('"batch_id": "ST-LOT-2026-001"', `"batch_id": "ST${ch}-LOT-2026-001"`)), name: CLEAN.lab, type: "application/json" });
      expect(l.ok ? [] : l.errors.map((x) => x.code), `lab U+${ch.charCodeAt(0).toString(16)}`).toContain("unsafe-identifier");
      expect(JSON.stringify(l)).not.toContain(ch);
    }
  });

  it("R2-03: refuses what a deny-list misses: Arabic letter mark, tag characters, combining marks, variation selectors, invisible operators, fillers, annotation characters, non-ASCII spaces, line separators, full-width and Cyrillic look-alikes", async () => {
    const pack = await loadPack();
    const erp = dec(fixtureBytes("n", CLEAN.erp));
    const lab = dec(fixtureBytes("n", CLEAN.lab));
    const names: Array<[string, string]> = [
      ["U+061C", "\u061c"], ["U+E0041", String.fromCodePoint(0xe0041)], ["U+034F", "\u034f"], ["U+FE0F", "\ufe0f"], ["U+2062", "\u2062"],
      ["U+180E", "\u180e"], ["U+3164", "\u3164"], ["U+FFF9", "\ufff9"], ["U+FFFC", "\ufffc"], ["U+0301", "\u0301"], ["NBSP", "\u00a0"],
      ["U+2028", "\u2028"], ["U+2029", "\u2029"], ["U+E000", "\ue000"], ["lone surrogate", "\ud800"],
    ];
    for (const [name, ch] of names) {
      const quoted = ch === "\u2028" || ch === "\u2029" ? `"ST${ch}-LOT-2026-001"` : `ST${ch}-LOT-2026-001`;
      const e = await importErpCsv(pack, { bytes: enc(erp.replace("ST-LOT-2026-001", quoted)), name: CLEAN.erp, type: "text/csv" });
      expect(e.ok, `erp ${name}`).toBe(false);
      const l = await importLabJson(pack, { bytes: enc(lab.replace('"batch_id": "ST-LOT-2026-001"', `"batch_id": "ST${ch}-LOT-2026-001"`)), name: CLEAN.lab, type: "application/json" });
      expect(l.ok, `lab ${name}`).toBe(false);
    }
    // look-alike letters and compatibility forms in the batch identifier
    for (const [name, letter] of [["full-width B (not its own NFKC form)", "\uff22"], ["Cyrillic Ve", "\u0412"]] as const) {
      const e = await importErpCsv(pack, { bytes: enc(erp.replace("ST-LOT-2026-001", `${letter}-LOT-2026-001`)), name: CLEAN.erp, type: "text/csv" });
      expect(e.ok ? [] : e.errors.map((x) => x.code), `erp ${name}`).toContain("unsafe-identifier");
      const l = await importLabJson(pack, { bytes: enc(lab.replace('"batch_id": "ST-LOT-2026-001"', `"batch_id": "${letter}-LOT-2026-001"`)), name: CLEAN.lab, type: "application/json" });
      expect(l.ok ? [] : l.errors.map((x) => x.code), `lab ${name}`).toContain("unsafe-identifier");
    }
    // plain ASCII is still accepted
    expect((await importErpCsv(pack, { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" })).ok).toBe(true);
  });

  it("R2-01: a field of exactly 2000 characters is read, one more is refused with field-too-long, in a CSV cell and in a JSON string or key", async () => {
    const pack = await loadPack();
    const erp = dec(fixtureBytes("n", CLEAN.erp));
    const lab = dec(fixtureBytes("n", CLEAN.lab));
    const name = (n: number) => "Aluminium sheet ".repeat(Math.ceil(n / 16)).slice(0, n).trim().padEnd(n, "x");
    const withName = (n: number) => importErpCsv(pack, { bytes: enc(erp.replace("Stand-in 5754 aluminium sheet", name(n))), name: CLEAN.erp, type: "text/csv" });
    expect((await withName(2000)).ok).toBe(true);
    const over = await withName(2001);
    expect(over.ok ? [] : over.errors.map((x) => x.code)).toEqual(["field-too-long"]);
    expect(JSON.stringify(over)).not.toContain("Aluminium sheet Aluminium");
    const withDesc = (n: number) =>
      importLabJson(pack, {
        bytes: enc(lab.replace('"description": "Stand-in dimension check; no test carried out"', `"description": "${name(n)}"`)),
        name: CLEAN.lab,
        type: "application/json",
      });
    expect((await withDesc(2000)).ok).toBe(true);
    const labOver = await withDesc(2001);
    expect(labOver.ok ? [] : labOver.errors.map((x) => x.code)).toEqual(["field-too-long"]);
    const key = await importLabJson(pack, { bytes: enc(lab.replace('"methods": [', `"${"k".repeat(2001)}": 1, "methods": [`)), name: CLEAN.lab, type: "application/json" });
    expect(key.ok ? [] : key.errors.map((x) => x.code)).toEqual(["field-too-long"]);
  });

  it("refuses zero-width characters in the middle of an identifier too", async () => {
    const pack = await loadPack();
    const erp = dec(fixtureBytes("n", CLEAN.erp));
    for (const ch of ["\u200b", "\u200c", "\u200d", "\ufeff"]) {
      const e = await importErpCsv(pack, { bytes: enc(erp.replace("ST-LOT-2026-001", `ST${ch}-LOT-2026-001`)), name: CLEAN.erp, type: "text/csv" });
      expect(e.ok).toBe(false);
    }
  });

  it("bounds an identifier at 128 characters and keeps the N fixtures valid", async () => {
    const pack = await loadPack();
    expect(MAX_IDENTIFIER_LENGTH).toBe(128);
    const erp = dec(fixtureBytes("n", CLEAN.erp));
    const ok = await importErpCsv(pack, { bytes: enc(erp.replace("ST-LOT-2026-001", "B".repeat(128))), name: CLEAN.erp, type: "text/csv" });
    expect(ok.ok).toBe(true);
    const long = await importErpCsv(pack, { bytes: enc(erp.replace("ST-LOT-2026-001", "B".repeat(129))), name: CLEAN.erp, type: "text/csv" });
    expect(long.ok ? [] : long.errors.map((x) => x.code)).toContain("unsafe-identifier");
    for (const f of ACCEPTED_ERP) {
      expect((await importErpCsv(pack, { bytes: fixtureBytes("n", f), name: f, type: "text/csv" })).ok, f).toBe(true);
    }
    for (const f of ACCEPTED_LAB) {
      expect((await importLabJson(pack, { bytes: fixtureBytes("n", f), name: f, type: "application/json" })).ok, f).toBe(true);
    }
  });
});

describe("5. cancel authorisation and record per run (V1-03, V1-05)", () => {
  it("a re-claim by another submitter is cancellable only by the current submitter or an ADMIN, and a committed retry shows no old cancel", async () => {
    let hold: Promise<void> | null = null;
    let seen: string[] = [];
    const s = await start({
      mode: "oidc",
      users: OP,
      extra: { testHooks: { stageHook: async (st, { jobId }) => { if (st === "validated" && hold) { seen.push(jobId); await hold; } } } },
    });
    const [op1, op2, admin] = [s.token("op-1"), s.token("op-2"), s.token("admin-1")];
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const first = post(s, "/api/jobs/import", importBody({ key: "per-run" }), op1);
    const jobId = (await until(() => seen[0])) as string;
    expect((await post(s, `/api/jobs/${jobId}/cancel`, { reason: "first run cancelled" }, op1)).status).toBe(200);
    release();
    expect((await first).status).toBe(409);
    // op-2 re-claims the same key: the same job, a new run, a new owner
    seen = [];
    hold = new Promise<void>((r) => (release = r));
    const second = post(s, "/api/jobs/import", importBody({ key: "per-run" }), op2);
    await until(() => seen[0]);
    expect(seen[0]).toBe(jobId);
    expect((await post(s, `/api/jobs/${jobId}/cancel`, { reason: "former owner" }, op1)).status).toBe(403);
    // the cancel record of the old run is not the record of this run
    expect((await json(await get(s, `/api/jobs/${jobId}`, admin))).cancellation).toBeNull();
    release();
    expect((await second).status).toBe(200);
    const job = await json(await get(s, `/api/jobs/${jobId}`, admin));
    expect(job.job.state).toBe("committed");
    expect(job.cancellation).toBeNull(); // a committed retry does not show the old cancellation
    // the audit still holds the first run's cancel, per run
    expect(s.db.query("SELECT claim_seq, requested_by FROM job_cancellations WHERE job_id = ?", jobId)).toEqual([{ claim_seq: 1, requested_by: "op-1" }]);
    expect(s.db.query("SELECT claim_seq, submitter_sub FROM job_submitters WHERE job_id = ? ORDER BY claim_seq", jobId)).toEqual([
      { claim_seq: 1, submitter_sub: "op-1" },
      { claim_seq: 2, submitter_sub: "op-2" },
    ]);
  });
});

describe("6. metrics visibility, route template and fixed error bodies", () => {
  it("only an ADMIN sees the per-domain split; an AUDITOR sees totals only (V2-04)", async () => {
    const s = await start({ mode: "oidc", domains: ["tenant-b"], users: [{ sub: "admin-1", roles: ["ACT-19"] }, { sub: "aud-1", roles: ["ACT-17"] }, { sub: "op-b", roles: ["ACT-01"], domain: "tenant-b" }], extra: { testHooks: { stageHook: async (st) => { if (st === "received") await sleep(400); } } } });
    const pending = fetch(`${s.baseUrl}/api/jobs/import`, { method: "POST", headers: headers(s.token("op-b"), { "X-Security-Domain": "tenant-b" }), body: importBody({ key: "tb" }) });
    await sleep(150);
    const admin = await json(await get(s, "/api/admin/metrics", s.token("admin-1")));
    const aud = await json(await get(s, "/api/admin/metrics", s.token("aud-1")));
    expect(Object.keys(admin.jobs).sort()).toEqual(["activeTotal", "byDomain", "queuedTotal"]);
    expect(Object.keys(admin.jobs.byDomain)).toContain("tenant-b");
    expect(Object.keys(aud.jobs).sort()).toEqual(["activeTotal", "queuedTotal"]);
    expect(JSON.stringify(aud)).not.toContain("tenant-b");
    await pending;
  });

  it("the route template is the route that was served, for dot-segment paths (V2-05)", async () => {
    const { routeTemplate } = await import("../../server/http/limits");
    expect(routeTemplate("GET", "/api/records/../jobs/abc")).toBe("GET /api/jobs/:id");
    expect(routeTemplate("GET", "/api/jobs/..")).toBe("GET /api/:unmatched");
    expect(routeTemplate("GET", "/api/jobs/%2e%2e/health")).toBe("GET /api/health");
    expect(routeTemplate("POST", "/api/jobs/abc/../xyz/cancel?x=1")).toBe("POST /api/jobs/:id/cancel");
    // and the served route agrees: the handler routes on the normalised pathname
    const entries: any[] = [];
    const s = await start({ extra: { log: (e: any) => entries.push(e) } });
    const res = await get(s, "/api/records/../jobs");
    expect(res.status).toBe(200);
    await until(() => entries.length === 1);
    expect(entries[0].route).toBe("GET /api/jobs");
  });

  it("409, 404 and 400 bodies from the stores are fixed text and echo no id, version, digest, path or role (F3)", async () => {
    const CAN = "CANARY-f3-zz9";
    const s = await start({ mode: "oidc", users: [{ sub: "admin-1", roles: ["ACT-19"] }, { sub: "op-1", roles: ["ACT-01"] }] });
    const [op, admin] = [s.token("op-1"), s.token("admin-1")];
    const imp = await json(await post(s, "/api/jobs/import", importBody({ key: "f3" }), op));
    const { model, batch } = imp.snapshot;
    const ev = b64(enc("evidence-f3"));
    await post(s, "/api/jobs/import", importBody({ key: "f3-ev", evidence: [{ evidenceId: `EV-${CAN}`, bytes: enc("evidence-f3") }] }), op);
    const sha = (s.db.get<{ sha256: string }>("SELECT sha256 FROM evidence_store LIMIT 1")?.sha256) as string;
    const calls: Array<[string, Response]> = [
      ["version-conflict", await post(s, `/api/records/${model}/${batch}/correct`, { property: "P", raw: "1", reason: "r", expectedVersion: 99 }, op)],
      ["no-record", await post(s, `/api/records/M-${CAN}/B-${CAN}/correct`, { property: "P", raw: "1", reason: "r" }, op)],
      ["idempotency-conflict", await post(s, "/api/jobs/import", importBody({ key: "f3", lab: null }), op)],
      ["unknown-role", await post(s, "/api/admin/users/op-1/roles", { role: `ROLE-${CAN}`, reason: "r" }, admin)],
      ["user-not-found", await post(s, `/api/admin/users/nobody-${CAN}/deactivate`, { reason: "r" }, admin)],
      ["unknown-user-token", await get(s, "/api/auth/me", s.idp.signRs256({ sub: `sub-${CAN}` }))],
    ];
    await post(s, `/api/evidence/${sha}/legal-hold`, { legalHold: true, reason: "hold" }, admin);
    calls.push(["legal-hold-active", await fetch(`${s.baseUrl}/api/evidence/${sha}`, { method: "DELETE", headers: { Authorization: `Bearer ${admin}`, "X-Security-Domain": `dom-${CAN}` } })]);
    calls.push(["legal-hold-delete", await fetch(`${s.baseUrl}/api/evidence/${sha}`, { method: "DELETE", headers: { Authorization: `Bearer ${admin}` } })]);
    void ev;
    for (const [label, res] of calls) {
      const text = await res.text();
      expect(res.status, `${label} ${text}`).toBeGreaterThanOrEqual(400);
      expect(res.status, label).toBeLessThan(500);
      expect(text, label).not.toContain(CAN);
      expect(text, label).not.toContain(model);
      expect(text, label).not.toContain(batch);
      expect(text, label).not.toContain(sha);
      expect(text, label).not.toMatch(/op-1|admin-1|JOB-|EV-/);
    }
  });
});
