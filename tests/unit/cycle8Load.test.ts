// @vitest-environment node
/**
 * Cycle 8 Layer 3, bounded load (C8-01, C8-06, D8-03, T12, T14): the same workload driver as `npm run load`
 * (`scripts/load.mjs`), run against the BUILT server (bundle plus ingress worker) in a child process, at a size that gates CI in about a minute:
 * 100 committed batches over four security domains, 10 timed import jobs, 8 concurrent readers, a 24-job overload burst into one
 * domain, one import at the maximum record size with a small max-size burst, and a role revocation under load.
 *
 * The rate limits, the per-domain slots, the queue, the global cap and Retry-After are the pinned ones. Only the volume and
 * the client count are scaled down, and the report says so.
 * The invariants and the targets are the full run's: p95 targets, no server error, RSS bound, exactly-once retries, revocation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readOperationalLimits, runLoad, type LoadReport } from "../../scripts/load.mjs";
import { startChild, type Child } from "../support/c8Child";

const DOMAINS = ["load-a", "load-b", "load-c", "load-d"];
let child: Child;
let report: LoadReport;

beforeAll(async () => {
  // The BUILT server (bundle and ingress worker) in its own process, so RSS is the server's and not the test runner's.
  child = await startChild({
    admin: "default-domain-admin",
    users: [],
    extraAdmins: DOMAINS.map((d) => ({ sub: `load-admin-${d}`, domain: d })),
  });
  const limits = readOperationalLimits(); // the pinned values the server enforces
  report = await runLoad({
    baseUrl: child.baseUrl,
    tokenFor: (sub) => child.token(sub),
    admins: Object.fromEntries(DOMAINS.map((d) => [d, `load-admin-${d}`])),
    limits,
    params: { volume: 100, timedRuns: 10, clients: 8, burst: 24, readIterations: 24, maxRuns: 1, maxBurst: 4, revokeAfterMs: 300 },
    mode: "bounded-built-server",
    scaledDown: true,
  });
}, 240_000);

afterAll(async () => {
  await child.stop();
});

describe("bounded load run (the CI gate of `npm run load`)", () => {
  it("meets every target of the full run at the bounded size, including the RSS bound while records of record_bytes_max are imported (D8-11)", () => {
    const failed = report.results.filter((r) => !r.pass).map((r) => r.target);
    expect(failed, JSON.stringify(report.results.filter((r) => !r.pass), null, 2)).toEqual([]);
    const rssMax = report.results.find((r) => r.target === "max_rss_bytes_during_max_size_runs")!;
    expect(rssMax.pass).toBe(true);
    expect(Number(rssMax.measured)).toBeGreaterThan(0);
    expect(Number(rssMax.measured)).toBeLessThanOrEqual(report.targets.max_rss_bytes);
    const max = report.measurements.sizes.phases;
    expect(max["max-size runs"].serverErrors + max["max-size burst"].serverErrors).toBe(0);
    process.stderr.write(
      `[C8-LOAD] typical import p50/p95 ${report.measurements.importJobMs.p50}/${report.measurements.importJobMs.p95} ms, read p95 ${report.measurements.readMs.p95} ms, ` +
        `health p95 ${report.measurements.healthMs.p95} ms, rss ${(report.measurements.rss.peakBytes / 2 ** 20).toFixed(0)} MiB; ` +
        `max-size (${report.measurements.sizes.maxPayloadBytes} B) import p95 ${report.measurements.sizes.maxImportMs.p95} ms, peak rss ${(max["max-size runs"].peakRssBytes / 2 ** 20).toFixed(0)} / burst ${(max["max-size burst"].peakRssBytes / 2 ** 20).toFixed(0)} MiB\n`,
    );
  });

  it("records the agreed sizes: a typical record, the maximum record, and a max-size burst, each committed with no server error", () => {
    const sz = report.measurements.sizes;
    expect(sz.typicalBytes).toBe(report.targets.record_bytes_typical);
    expect(sz.maxBytes).toBe(report.targets.record_bytes_max);
    expect(report.targets.record_bytes_max).toBe(readOperationalLimits().coordinator.server_record_max_bytes); // the load target is the size the server admits
    expect(sz.maxPayloadBytes).toBeGreaterThan(report.targets.record_bytes_max * 0.99);
    expect(sz.maxBurst.committed).toBe(4);
    expect(Object.keys(sz.maxBurst.statuses).every((s) => s === "200" || s === "429")).toBe(true);
    expect(sz.phases.typical.serverErrors).toBe(0);
    expect(sz.phases.typical.peakRssBytes).toBeLessThanOrEqual(report.targets.max_rss_bytes);
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
  });
});
