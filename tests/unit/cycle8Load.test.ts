// @vitest-environment node
/**
 * Cycle 8 Layer 3, bounded load (C8-01, C8-06, D8-03, T12, T14): the same workload driver as `npm run load`
 * (`scripts/load.mjs`), run in-process against a real server on an ephemeral port, at a size that gates CI in under a minute:
 * 100 committed batches over four security domains, 10 timed import jobs, 8 concurrent readers, a 24-job overload burst into one
 * domain, and a role revocation under load.
 *
 * The rate limits, the per-domain slots, the queue and the global cap are the pinned ones. Only `retry_after_seconds` is
 * shortened to 1 s so the retry rounds of the burst do not make the test wait 2 s each; Retry-After is still obeyed.
 * The invariants and the targets are the full run's: p95 targets, no server error, RSS bound, exactly-once retries, revocation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readOperationalLimits, runLoad, type LoadReport } from "../../scripts/load.mjs";
import { NOW, startC8Server, type C8Server } from "../support/c8Server";

const DOMAINS = ["load-a", "load-b", "load-c", "load-d"];
let S: C8Server;
let report: LoadReport;

beforeAll(async () => {
  S = await startC8Server({
    mode: "oidc",
    domains: DOMAINS,
    users: DOMAINS.map((d) => ({ sub: `load-admin-${d}`, roles: ["ADMIN" as const], domain: d })),
    patch: { coordinator: { retry_after_seconds: 1 } as never },
  });
  const pinned = readOperationalLimits();
  // the driver reads the same pinned values the server enforces
  expect(pinned.coordinator.max_active_jobs_per_security_domain).toBe(S.pack.operationalLimits.coordinator.max_active_jobs_per_security_domain);
  const limits = { ...pinned, coordinator: { ...pinned.coordinator, retry_after_seconds: 1 } };
  report = await runLoad({
    baseUrl: S.baseUrl,
    tokenFor: (sub) => S.token(sub),
    admins: Object.fromEntries(DOMAINS.map((d) => [d, `load-admin-${d}`])),
    limits,
    params: { volume: 100, timedRuns: 10, clients: 8, burst: 24, readIterations: 24, revokeAfterMs: 300 },
    mode: "bounded-in-process",
  });
}, 180_000);

afterAll(async () => {
  await S.close();
});

describe("bounded load run (the CI gate of `npm run load`)", () => {
  it("meets every target of the full run, at the bounded size", () => {
    const failed = report.results.filter((r) => !r.pass);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(report.pass).toBe(true);
    process.stderr.write(
      `[C8-LOAD] import p50/p95 ${report.measurements.importJobMs.p50}/${report.measurements.importJobMs.p95} ms, read p95 ${report.measurements.readMs.p95} ms, ` +
        `health p95 ${report.measurements.healthMs.p95} ms, rss ${(report.measurements.rss.peakBytes / 2 ** 20).toFixed(0)} MiB\n`,
    );
  });

  it("holds the volume: 100 committed batches across four security domains before measuring", () => {
    const row = report.results.find((r) => r.target === "volume_committed_batches")!;
    expect(row.measured).toBeGreaterThanOrEqual(100);
    expect(report.measurements.seed.batches).toBe(100);
  });

  it("times 10 complete import jobs under the p95 target and reads at 8 clients under the read target", () => {
    expect(report.measurements.importJobMs.count).toBe(10);
    expect(report.measurements.importJobMs.p95).toBeLessThanOrEqual(report.targets.import_job_p95_ms);
    expect(report.measurements.readMs.p95).toBeLessThanOrEqual(report.targets.read_p95_ms);
    expect(Object.keys(report.measurements.readStatuses).every((s) => s === "200" || s === "409")).toBe(true);
  });

  it("overload burst: only 2xx or 429 with Retry-After, no server error, and every retried job commits exactly once", () => {
    const b = report.measurements.burst;
    expect(Object.keys(b.finalStatuses).every((s) => s === "200" || s === "429")).toBe(true);
    expect(b.firstRound["429"]).toBeGreaterThan(0); // the burst really did exceed one domain's slots and queue
    expect(b.committedExactlyOnce).toBe(24);
    expect(b.lostOrDuplicated).toBe(0);
    expect(report.measurements.requests.serverErrors).toBe(0);
    expect(report.measurements.requests.transportErrors).toBe(0);
    // the server counted the refusals as OVER_LIMIT queue_full, and no job is left running or queued
    const counted = report.measurements.serverCounters.limitOutcomes as Array<{ outcome: string; limit: string; count: number }>;
    expect(counted.find((c) => c.outcome === "OVER_LIMIT" && c.limit === "queue_full")?.count).toBeGreaterThan(0);
    const m = S.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM import_jobs WHERE state = 'running'")!;
    expect(m.n).toBe(0);
  });

  it("health stays responsive during the burst and the server stays inside its RSS bound", () => {
    expect(report.measurements.healthMs.count).toBeGreaterThan(5);
    expect(report.measurements.healthMs.p95).toBeLessThanOrEqual(report.targets.read_p95_ms);
    expect(report.measurements.rss.peakBytes).toBeGreaterThan(0);
    expect(report.measurements.rss.peakBytes).toBeLessThanOrEqual(report.targets.max_rss_bytes);
  });

  it("a role revoked under load takes effect on the very next request of that subject (C8-06, T14)", () => {
    const r = report.measurements.revocation;
    expect(r.revokeAckStatus).toBe(200);
    expect(r.nextRequestStatus).toBe(403);
    expect(r.nextImportStatus).toBe(403);
    expect(r.requestsBeforeRevoke).toBeGreaterThan(0); // it was being served before
    expect(r.requestsAfterAckWith2xx).toBe(0);
  });

  it("the report names the host and every target with its pass or fail", () => {
    expect(report.host.node).toMatch(/^v\d+/);
    expect(report.host.cores).toBeGreaterThan(0);
    expect(report.host.totalMemoryBytes).toBeGreaterThan(0);
    expect(report.results.length).toBeGreaterThanOrEqual(10);
    for (const r of report.results) expect(typeof r.pass).toBe("boolean");
    void NOW;
  });
});
