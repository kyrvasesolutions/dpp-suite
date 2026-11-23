#!/usr/bin/env node
/**
 * Bounded load and resilience run for the DPP server (Cycle 8, C8-01, D8-03). Zero dependencies: node:http is not needed
 * (global fetch), node:os, node:child_process, node:crypto and perf_hooks only.
 *
 *   node scripts/load.mjs [--out docs/assessment/cycle-8/load-report.json] [--volume 1000] [--runs 30] [--clients 16] [--burst 64]
 *
 * It starts the built `dist-server/server.mjs` (run `npm run build:server` first) in OIDC mode with an ephemeral test JWKS and a
 * temp database, provisions users across four security domains, seeds committed batches to the pinned volume, and measures:
 *   (a) complete import workloads, p50 and p95 against `import_job_p95_ms`,
 *   (b) a read mix (records list, record detail, customer PDF) at `concurrent_clients`, p95 against `read_p95_ms`,
 *   (c) an overload burst into one security domain: only 2xx and 429 with Retry-After, no server error, and every refused
 *       job retried with its own idempotency key commits exactly once (no lost or duplicated assertions),
 *   (d) a role revocation under load: the very next request of the subject is 403.
 * It tracks peak RSS and the health probe p95 during the burst, writes a JSON report, and exits non-zero if any target fails.
 * The rate limits and the queue limits of the server stay on; the run stays inside them (or waits for Retry-After) honestly.
 *
 * The workload is also exported (`runLoad`) so `tests/unit/cycle8Load.test.ts` can run a bounded version in-process.
 */
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

/** Nearest-rank percentile of a list of numbers. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
const round = (n) => (n === null || n === undefined ? n : Math.round(n * 100) / 100);
const stats = (values) => ({
  count: values.length,
  min: round(Math.min(...values)),
  p50: round(percentile(values, 50)),
  p95: round(percentile(values, 95)),
  max: round(Math.max(...values)),
  mean: round(values.reduce((a, b) => a + b, 0) / (values.length || 1)),
});

/** The pinned OPERATIONAL-LIMITS, read with a minimal parser for its flat two-level YAML (no dependency). */
export function readOperationalLimits(pack = join(ROOT, "contracts/n")) {
  const text = readFileSync(join(pack, "policy/OPERATIONAL-LIMITS@1.0.0.yaml"), "utf8");
  const out = {};
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const top = /^([a-z0-9_]+):\s*(.*)$/.exec(line);
    if (top && !line.startsWith(" ")) {
      if (top[2] === "") {
        section = top[1];
        out[section] = {};
      } else {
        section = null;
        out[top[1]] = /^\d+$/.test(top[2]) ? Number(top[2]) : top[2];
      }
      continue;
    }
    const inner = /^\s+([a-z0-9_]+):\s*(\d+)\s*$/.exec(line);
    if (inner && section) out[section][inner[1]] = Number(inner[2]);
  }
  return out;
}

/** One source pair for batch number `n`: the clean fixtures with their batch identifier replaced. */
export function variant(n, fixtures = join(ROOT, "fixtures/n")) {
  const batch = `B-2026-${String(n).padStart(4, "0")}`;
  const erp = readFileSync(join(fixtures, "d03a-erp-extract.csv"), "utf8").replaceAll("B-2026-0417", batch);
  const lab = readFileSync(join(fixtures, "d03a-lab-assessment.json"), "utf8").replaceAll("B-2026-0417", batch);
  return { batch, erp: Buffer.from(erp, "utf8"), lab: Buffer.from(lab, "utf8") };
}

// ---------------------------------------------------------------------------------------------
// a tiny HTTP client that never retries unless it is told to, and then only after Retry-After
// ---------------------------------------------------------------------------------------------

class Api {
  constructor(baseUrl, tokenFor, counters) {
    this.baseUrl = baseUrl;
    this.tokenFor = tokenFor;
    this.counters = counters;
  }

  async call(sub, method, path, { body, domain, headers = {}, retry429 = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      const t0 = performance.now();
      let res;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            ...(sub ? { Authorization: `Bearer ${this.tokenFor(sub)}` } : {}),
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(domain ? { "X-Security-Domain": domain } : {}),
            ...headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        this.counters.transportErrors++;
        throw e;
      }
      const text = await res.text();
      const ms = performance.now() - t0;
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      this.counters.requests++;
      if (res.status >= 500) this.counters.serverErrors++;
      if (res.status === 429) this.counters.rateOrQueueRefusals++;
      const retryAfter = res.headers.get("retry-after");
      if (res.status === 429 && retry429 && attempt < 30) {
        this.counters.waitedForRetryAfter++;
        await sleep(Math.max(1, Number(retryAfter ?? 1)) * 1000);
        continue;
      }
      return { status: res.status, ms, json, retryAfter };
    }
  }

  importBody(key, pair, evidence) {
    return {
      idempotencyKey: key,
      erp: { name: "d03a-erp-extract.csv", type: "text/csv", base64: pair.erp.toString("base64") },
      lab: { name: "d03a-lab-assessment.json", type: "application/json", base64: pair.lab.toString("base64") },
      ...(evidence ? { evidence } : {}),
    };
  }
}

/** Runs `tasks` (async functions) with at most `limit` in flight. */
async function pool(limit, tasks) {
  let next = 0;
  const results = new Array(tasks.length);
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= tasks.length) return;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}

// ---------------------------------------------------------------------------------------------
// the workload
// ---------------------------------------------------------------------------------------------

/**
 * Runs every measurement against a server that is already up in OIDC mode.
 *
 * cfg: { baseUrl, tokenFor(sub), admins: { [domain]: sub }, metricsSub (an AUDITOR or ADMIN subject in the first domain), limits,
 *        params: { volume, timedRuns, clients, burst, readIterations, revokeAfterMs }, log(msg), mode }
 */
export async function runLoad(cfg) {
  const { limits, params } = cfg;
  const log = cfg.log ?? (() => undefined);
  const counters = { requests: 0, serverErrors: 0, transportErrors: 0, rateOrQueueRefusals: 0, waitedForRetryAfter: 0 };
  const api = new Api(cfg.baseUrl, cfg.tokenFor, counters);
  const domains = Object.keys(cfg.admins);
  const [domA] = domains;
  const run = `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  let counter = 1000; // batch numbers: four digits
  const nextBatch = () => {
    if (counter > 9999) throw new Error("out of batch numbers");
    return counter++;
  };

  // ---- provisioning: users in each security domain, through the admin API ----
  const users = { seed: {}, timed: [], read: [], burst: [], victim: null, background: [] };
  const provision = async (domain, sub, role = "ACT-01") => {
    const r = await api.call(cfg.admins[domain], "POST", "/api/admin/users", {
      body: { sub, displayName: `Load ${sub}`, roles: [role], reason: "Cycle 8 load run" },
      domain,
      retry429: true,
    });
    if (r.status !== 200) throw new Error(`provisioning ${sub} in ${domain} failed with ${r.status}`);
  };
  const subjectDomain = new Map();
  const user = async (domain, name, role) => {
    const sub = `load-${run}-${name}`;
    await provision(domain, sub, role);
    subjectDomain.set(sub, domain);
    return sub;
  };
  // Up to a minute of provisioning waits can come from the admin's own write budget; this keeps the run honest rather than faster.
  for (const d of domains) {
    users.seed[d] = [];
    const seedersPerDomain = Math.max(1, Math.ceil(params.volume / domains.length / (limits.http.rate_limit_write_per_window - 10)));
    for (let i = 0; i < seedersPerDomain; i++) users.seed[d].push(await user(d, `seed-${d}-${i}`));
  }
  for (let i = 0; i < 2; i++) users.timed.push(await user(domA, `timed-${i}`));
  for (let i = 0; i < params.clients; i++) {
    const d = domains[i % domains.length];
    users.read.push(await user(d, `read-${i}`));
  }
  const burstSubjects = Math.max(2, Math.ceil(params.burst * 2 / limits.http.rate_limit_write_per_window) + 2);
  for (let i = 0; i < burstSubjects; i++) users.burst.push(await user(domA, `burst-${i}`));
  users.victim = await user(domA, "victim");
  for (let i = 0; i < 3; i++) users.background.push(await user(domA, `bg-${i}`));
  const metricsSub = await user(domA, "metrics", "AUDITOR");
  const healthSub = null;
  void healthSub;
  log(`provisioned users in ${domains.length} security domains`);

  // ---- RSS and health probes ----
  let peakRss = 0;
  const rssSamples = [];
  const probe = async () => {
    const r = await api.call(metricsSub, "GET", "/api/admin/metrics", { domain: domA });
    if (r.status === 200) {
      const rss = r.json.process.rssBytes;
      peakRss = Math.max(peakRss, rss);
      rssSamples.push(rss);
      return r.json;
    }
    return null;
  };
  const rssTimer = setInterval(() => void probe().catch(() => undefined), 500);
  await probe();

  // ---- seed volume: committed batches spread over the domains ----
  const seeded = [];
  const seedStart = performance.now();
  {
    const perDomain = domains.map((d, i) => Math.floor(params.volume / domains.length) + (i < params.volume % domains.length ? 1 : 0));
    const tasks = [];
    domains.forEach((d, di) => {
      for (let k = 0; k < perDomain[di]; k++) {
        const n = nextBatch();
        const sub = users.seed[d][k % users.seed[d].length];
        tasks.push(async () => {
          const pair = variant(n);
          const r = await api.call(sub, "POST", "/api/jobs/import", { body: api.importBody(`seed-${run}-${n}`, pair), domain: d, retry429: true });
          if (r.status !== 200 || !r.json?.ok) throw new Error(`seeding batch ${n} failed with ${r.status}`);
          seeded.push({ domain: d, batch: pair.batch, model: r.json.snapshot.model });
        });
      }
    });
    await pool(domains.length * limits.coordinator.max_active_jobs_per_security_domain, tasks);
  }
  const seedMs = performance.now() - seedStart;
  let committedCount = 0;
  for (const d of domains) {
    const r = await api.call(cfg.admins[d], "GET", "/api/records", { domain: d, retry429: true });
    committedCount += r.json.records.length;
  }
  log(`seeded ${seeded.length} batches in ${(seedMs / 1000).toFixed(1)} s; store holds ${committedCount}`);

  // ---- (a) complete import workloads ----
  const importMs = [];
  const workloadMs = [];
  for (let i = 0; i < params.timedRuns; i++) {
    const n = nextBatch();
    const sub = users.timed[i % users.timed.length];
    const pair = variant(n);
    const evidence = [
      {
        evidenceId: `EV-LOAD-${n}`,
        issuer: "Load Lab",
        revision: "1",
        recordKind: "test-report",
        text: `load evidence object ${run} ${n} ${"x".repeat(2048)}`,
      },
    ];
    const t0 = performance.now();
    const imp = await api.call(sub, "POST", "/api/jobs/import", { body: api.importBody(`timed-${run}-${n}`, pair, evidence), domain: domA });
    const tImport = performance.now() - t0;
    if (imp.status !== 200 || !imp.json?.ok) throw new Error(`timed import ${i} failed with ${imp.status} ${JSON.stringify(imp.json?.code ?? imp.json?.errors?.[0]?.code)}`);
    const { model, batch } = imp.json.snapshot;
    // the rest of a complete workload: read the record back and release the customer PDF
    const h = await api.call(sub, "GET", `/api/records/${model}/${batch}/history`, { domain: domA });
    const pdf = await api.call(sub, "POST", `/api/customer/records/${model}/${batch}/release`, { body: {}, domain: domA });
    const total = performance.now() - t0;
    if (h.status !== 200 || (pdf.status !== 200 && pdf.status !== 409)) throw new Error(`workload ${i} read-back failed (${h.status}, ${pdf.status})`);
    importMs.push(tImport);
    workloadMs.push(total);
  }
  log(`import jobs: p50 ${percentile(importMs, 50).toFixed(0)} ms, p95 ${percentile(importMs, 95).toFixed(0)} ms (${importMs.length} runs)`);

  // ---- (b) read mix at the target concurrency ----
  const readMs = [];
  const readStatuses = {};
  {
    const sample = seeded.filter((s) => s.domain === domA).slice(0, 25);
    const clientTask = (sub, idx) => async () => {
      const d = subjectDomain.get(sub);
      const own = seeded.filter((s) => s.domain === d);
      for (let k = 0; k < params.readIterations; k++) {
        const pick = own[(idx * 7 + k * 13) % own.length] ?? sample[0];
        const kind = k % 4; // list, detail, detail, customer PDF
        const t0 = performance.now();
        const r =
          kind === 0
            ? await api.call(sub, "GET", "/api/records", { domain: d })
            : kind === 3
              ? await api.call(sub, "POST", `/api/customer/records/${pick.model}/${pick.batch}/release`, { body: {}, domain: d })
              : await api.call(sub, "GET", `/api/records/${pick.model}/${pick.batch}/history`, { domain: d });
        readMs.push(performance.now() - t0);
        readStatuses[r.status] = (readStatuses[r.status] ?? 0) + 1;
      }
    };
    await Promise.all(users.read.map((sub, i) => clientTask(sub, i)()));
  }
  log(`read mix (${users.read.length} clients): p95 ${percentile(readMs, 95).toFixed(0)} ms over ${readMs.length} requests`);

  // ---- (c) overload burst into one security domain ----
  const burstJobs = Array.from({ length: params.burst }, (_, i) => {
    const n = nextBatch();
    return { n, key: `burst-${run}-${n}`, pair: variant(n), sub: users.burst[i % users.burst.length], first: null, final: null, attempts: 0 };
  });
  const healthMs = [];
  let healthRunning = true;
  const healthLoop = (async () => {
    while (healthRunning) {
      const t0 = performance.now();
      try {
        const r = await fetch(`${cfg.baseUrl}/api/health`);
        await r.text();
        healthMs.push(performance.now() - t0);
        if (r.status >= 500) counters.serverErrors++;
      } catch {
        counters.transportErrors++;
      }
      await sleep(40);
    }
  })();
  const burstStatuses = {};
  let missingRetryAfter = 0;
  let nonJson = 0;
  const burstStart = performance.now();
  const fire = async (job) => {
    job.attempts++;
    const r = await api.call(job.sub, "POST", "/api/jobs/import", { body: api.importBody(job.key, job.pair), domain: domA });
    burstStatuses[r.status] = (burstStatuses[r.status] ?? 0) + 1;
    if (r.status === 429) {
      if (!r.retryAfter || !(Number(r.retryAfter) >= 1)) missingRetryAfter++;
      if (r.json?.code !== "queue-full" && r.json?.code !== "rate-limited") nonJson++;
    }
    job.first ??= r.status;
    if (r.status === 200 && r.json?.ok) job.final = r.json;
    return r;
  };
  await Promise.all(burstJobs.map((j) => fire(j)));
  const firstRound = { ...burstStatuses };
  let rounds = 0;
  for (;;) {
    const pending = burstJobs.filter((j) => !j.final);
    if (!pending.length || rounds >= 40) break;
    rounds++;
    await sleep(limits.coordinator.retry_after_seconds * 1000);
    await Promise.all(pending.map((j) => fire(j)));
  }
  const burstMs = performance.now() - burstStart;
  healthRunning = false;
  await healthLoop;
  const unexpected = Object.keys(burstStatuses).filter((s) => s !== "200" && s !== "429");
  // exactly once: one job and one version per key, then a replay of every key creates nothing new
  let lostOrDuplicated = 0;
  const committedKeys = new Set();
  {
    const jobs = await api.call(cfg.admins[domA], "GET", "/api/jobs", { domain: domA, retry429: true });
    for (const j of burstJobs) {
      const rows = jobs.json.jobs.filter((x) => x.idempotencyKey === j.key);
      if (rows.length !== 1 || rows[0].state !== "committed") lostOrDuplicated++;
      else committedKeys.add(j.key);
    }
    await pool(
      16,
      burstJobs.map((j) => async () => {
        const model = j.final?.snapshot?.model;
        const h = await api.call(cfg.admins[domA], "GET", `/api/records/${model}/${j.pair.batch}/history`, { domain: domA, retry429: true });
        if (h.status !== 200 || h.json.history.length !== 1 || h.json.history[0].version !== 1) lostOrDuplicated++;
      }),
    );
    // a replay of the same key answers with the same job and stores nothing
    const replays = await pool(
      Math.min(8, burstJobs.length),
      burstJobs.map((j) => async () => {
        const r = await api.call(j.sub, "POST", "/api/jobs/import", { body: api.importBody(j.key, j.pair), domain: domA, retry429: true });
        if (r.status !== 200 || r.json?.job?.jobId !== j.final?.job?.jobId || r.json?.receipt?.stored !== false) lostOrDuplicated++;
        return r.status;
      }),
    );
    void replays;
  }
  log(`burst of ${params.burst}: first round ${JSON.stringify(firstRound)}, ${rounds} retry rounds, all committed ${committedKeys.size}/${params.burst}`);

  // ---- (d) role revocation under load ----
  const revocation = { revokeAckStatus: null, nextRequestStatus: null, nextImportStatus: null, requestsAfterAckWith2xx: 0, requestsBeforeRevoke: 0, requestsAfterAck: 0 };
  {
    let revokedAt = null;
    let stop = false;
    const bg = users.background.map((sub) =>
      (async () => {
        while (!stop) {
          await api.call(sub, "GET", "/api/records", { domain: domA });
          await sleep(20);
        }
      })(),
    );
    const victimLoop = (async () => {
      while (!stop) {
        const startedAfterAck = revokedAt !== null;
        const r = await api.call(users.victim, "GET", "/api/records", { domain: domA });
        if (startedAfterAck) {
          revocation.requestsAfterAck++;
          if (r.status >= 200 && r.status < 300) revocation.requestsAfterAckWith2xx++;
        } else {
          revocation.requestsBeforeRevoke++;
        }
        await sleep(10);
      }
    })();
    await sleep(params.revokeAfterMs ?? 400);
    const rev = await api.call(cfg.admins[domA], "POST", `/api/admin/users/${users.victim}/roles/revoke`, {
      body: { role: "ACT-01", reason: "Cycle 8 revocation under load" },
      domain: domA,
      retry429: true,
    });
    revokedAt = performance.now();
    revocation.revokeAckStatus = rev.status;
    // the very next requests of the subject, issued right after the revocation was acknowledged
    const next = await api.call(users.victim, "GET", "/api/records", { domain: domA });
    revocation.nextRequestStatus = next.status;
    const nextImport = await api.call(users.victim, "POST", "/api/jobs/import", { body: api.importBody(`victim-${run}`, variant(nextBatch())), domain: domA });
    revocation.nextImportStatus = nextImport.status;
    await sleep(300);
    stop = true;
    await Promise.all([...bg, victimLoop]);
  }
  log(`revocation: next request ${revocation.nextRequestStatus}, next import ${revocation.nextImportStatus}`);

  clearInterval(rssTimer);
  await probe();
  const finalMetrics = await probe();

  // ---- targets ----
  const t = limits.targets;
  const importP95 = percentile(importMs, 95);
  const readP95 = percentile(readMs, 95);
  const healthP95 = percentile(healthMs, 95);
  const checks = [
    { target: "import_job_p95_ms", limit: t.import_job_p95_ms, measured: round(importP95), pass: importP95 <= t.import_job_p95_ms, note: `p95 of ${importMs.length} complete import jobs (ERP + lab + evidence, committed), at ${committedCount} committed batches` },
    { target: "read_p95_ms", limit: t.read_p95_ms, measured: round(readP95), pass: readP95 <= t.read_p95_ms, note: `p95 of ${readMs.length} reads (records list, record detail, customer PDF) at ${users.read.length} concurrent clients` },
    { target: "concurrent_clients", limit: t.concurrent_clients, measured: users.read.length, pass: users.read.length >= Math.min(t.concurrent_clients, params.clients), note: "clients that ran the read mix at the same time" },
    { target: "volume_committed_batches", limit: params.volume, measured: committedCount, pass: committedCount >= params.volume, note: `committed batches across ${domains.length} security domains before measuring` },
    { target: "max_server_errors", limit: t.max_server_errors, measured: counters.serverErrors, pass: counters.serverErrors <= t.max_server_errors && counters.transportErrors === 0, note: `5xx answers over ${counters.requests} requests; transport errors ${counters.transportErrors}` },
    { target: "max_rss_bytes", limit: t.max_rss_bytes, measured: peakRss, pass: peakRss > 0 && peakRss <= t.max_rss_bytes, note: "peak resident set size of the server, sampled every 500 ms" },
    { target: "burst_only_2xx_or_429", limit: "2xx or 429 with Retry-After", measured: burstStatuses, pass: unexpected.length === 0 && missingRetryAfter === 0 && nonJson === 0 && (firstRound["429"] ?? 0) > 0, note: `${params.burst} concurrent imports into one domain: the first round was refused with 429 for the overflow` },
    { target: "burst_retries_commit_exactly_once", limit: params.burst, measured: committedKeys.size, pass: committedKeys.size === params.burst && lostOrDuplicated === 0, note: `lost or duplicated: ${lostOrDuplicated}; retry rounds ${rounds}` },
    { target: "health_p95_during_burst_ms", limit: t.read_p95_ms, measured: round(healthP95), pass: healthP95 !== null && healthP95 <= t.read_p95_ms, note: `p95 of ${healthMs.length} health probes while the burst ran` },
    { target: "revocation_next_request_403", limit: 403, measured: revocation.nextRequestStatus, pass: revocation.revokeAckStatus === 200 && revocation.nextRequestStatus === 403 && revocation.nextImportStatus === 403 && revocation.requestsAfterAckWith2xx === 0, note: `requests of the subject started after the acknowledgement: ${revocation.requestsAfterAck}, with 2xx: ${revocation.requestsAfterAckWith2xx}` },
  ];

  return {
    generatedAt: new Date().toISOString(),
    mode: cfg.mode ?? "full",
    host: {
      os: `${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      cores: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      node: process.version,
    },
    note: "ARTIFICIAL-DEMO stand-in for the unnamed customer host (D8-03). Container cgroup enforcement and the real host stay pre-production holds.",
    params,
    measurements: {
      seed: { batches: seeded.length, durationMs: round(seedMs), perSecond: round(seeded.length / (seedMs / 1000)) },
      importJobMs: stats(importMs),
      importWorkloadMs: stats(workloadMs),
      readMs: stats(readMs),
      readStatuses,
      burst: { size: params.burst, firstRound, finalStatuses: burstStatuses, retryRounds: rounds, durationMs: round(burstMs), lostOrDuplicated, committedExactlyOnce: committedKeys.size },
      healthMs: stats(healthMs.length ? healthMs : [0]),
      revocation,
      rss: { peakBytes: peakRss, samples: rssSamples.length },
      requests: counters,
      serverCounters: finalMetrics ? { requests: finalMetrics.requests, limitOutcomes: finalMetrics.limitOutcomes } : null,
    },
    targets: limits.targets,
    results: checks,
    pass: checks.every((c) => c.pass),
  };
}

// ---------------------------------------------------------------------------------------------
// the command line: start the built server, run, report
// ---------------------------------------------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const out = resolve(ROOT, arg("out", "docs/assessment/cycle-8/load-report.json"));
  const bundle = join(ROOT, "dist-server/server.mjs");
  if (!existsSync(bundle)) {
    console.log("dist-server/server.mjs is missing; running `npm run build:server` first");
    execFileSync("npm", ["run", "build:server"], { cwd: ROOT, stdio: "inherit" });
  }
  const limits = readOperationalLimits();
  const params = {
    volume: Number(arg("volume", limits.targets.volume_committed_batches)),
    timedRuns: Number(arg("runs", 30)),
    clients: Number(arg("clients", limits.targets.concurrent_clients)),
    burst: Number(arg("burst", 64)),
    readIterations: Number(arg("read-iterations", 48)),
    revokeAfterMs: 400,
  };

  const tmp = mkdtempSync(join(os.tmpdir(), "dpp-load-"));
  const issuer = "https://idp.load.test";
  const audience = "dpp-suite-api";
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...ec.publicKey.export({ format: "jwk" }), kid: "load-ec-1", use: "sig", alg: "ES256" };
  const jwksPath = join(tmp, "jwks.json");
  writeFileSync(jwksPath, JSON.stringify({ keys: [jwk] }));
  const tokenFor = (sub) => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "load-ec-1" }));
    const body = b64url(JSON.stringify({ iss: issuer, aud: audience, sub, iat: now - 30, exp: now + 3600 }));
    const sig = sign("sha256", Buffer.from(`${head}.${body}`, "ascii"), { key: ec.privateKey, dsaEncoding: "ieee-p1363" });
    return `${head}.${body}.${b64url(sig)}`;
  };

  const domains = ["load-a", "load-b", "load-c", "load-d"];
  const env = {
    ...process.env,
    DPP_DB_PATH: join(tmp, "load.sqlite"),
    DPP_SERVER_HOST: "127.0.0.1",
    DPP_AUTH_MODE: "oidc",
    DPP_DEPLOYMENT_SURFACE: "all",
    DPP_OIDC_ISSUER: issuer,
    DPP_OIDC_AUDIENCE: audience,
    DPP_OIDC_JWKS_PATH: jwksPath,
    DPP_STATIC_DIR: join(tmp, "no-static"),
  };
  const admins = {};
  for (const d of domains) {
    const sub = `load-admin-${d}`;
    execFileSync(process.execPath, [bundle, "--bootstrap-admin", sub, `Load admin ${d}`, "--domain", d, "--reason", "Cycle 8 load run"], { cwd: ROOT, env, stdio: "pipe" });
    admins[d] = sub;
  }
  const port = await freePort();
  const child = spawn(process.execPath, [bundle], { cwd: ROOT, env: { ...env, DPP_SERVER_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = "";
  child.stdout.on("data", (d) => (serverLog += d));
  child.stderr.on("data", (d) => (serverLog += d));
  const baseUrl = `http://127.0.0.1:${port}`;
  let report;
  try {
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(`${baseUrl}/api/health`);
        if (r.status === 200) break;
      } catch {
        /* not up yet */
      }
      if (child.exitCode !== null || i > 200) throw new Error(`the server did not start:\n${serverLog}`);
      await sleep(100);
    }
    console.log(`server up on ${baseUrl}; ${params.volume} batches, ${params.timedRuns} timed runs, ${params.clients} clients, burst ${params.burst}`);
    report = await runLoad({ baseUrl, tokenFor, admins, limits, params, mode: "full", log: (m) => console.log(m) });
    report.serverStdoutLines = serverLog.split("\n").filter(Boolean).length;
  } finally {
    child.kill("SIGTERM");
    await sleep(200);
    rmSync(tmp, { recursive: true, force: true });
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport written to ${out}`);
  console.log(`${report.host.os}, ${report.host.cpuModel}, ${report.host.cores} cores, ${(report.host.totalMemoryBytes / 2 ** 30).toFixed(1)} GiB, node ${report.host.node}`);
  for (const c of report.results) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.target}: measured ${typeof c.measured === "object" ? JSON.stringify(c.measured) : c.measured} (limit ${c.limit})`);
  process.exit(report.pass ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exit(2);
  });
}
