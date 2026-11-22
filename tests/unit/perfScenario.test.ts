// @vitest-environment node
/**
 * The performance scenario (Cycle 5): `npm run perf` runs it 30 times with PERF=1 and reports p50 and p95, cold and warm. It never
 * gates anything. Without PERF it runs once, to keep the scenario itself working.
 */
import { cpus, platform, release as osRelease, totalmem } from "node:os";
import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { ProfilePack } from "../../src/model/profile";
import { loadPack } from "../support/records";
import { runScenario } from "../support/scenario";

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});

describe("the one-record scenario", () => {
  // not in the PERF run, so the first of the 30 runs is a cold one
  it.runIf(process.env.PERF !== "1")("imports both files, assesses readiness and makes the three outputs and the manifest", async () => {
    const { records, readiness, release } = await runScenario(pack);
    expect(records).toHaveLength(1);
    expect(readiness.map((r) => r.status)).toEqual(["ready", "ready", "on-hold"]);
    expect(release.files).toHaveLength(3);
    expect(release.manifest.outputs).toHaveLength(3);
  });

  it.runIf(process.env.PERF === "1")("runs the scenario PERF_RUNS times (30 by default) and writes the timings", async () => {
    const times: number[] = [];
    const count = Number(process.env.PERF_RUNS ?? 30);
    for (let i = 0; i < count; i++) {
      const t0 = performance.now();
      await runScenario(pack);
      times.push(performance.now() - t0);
    }
    const cpu = cpus();
    writeFileSync(
      process.env.PERF_OUT ?? "test-results/perf-node.json",
      JSON.stringify({
        runs: times,
        machine: { cpu: cpu[0]?.model ?? "unknown", logicalCores: cpu.length, memoryGiB: Math.round((totalmem() / 2 ** 30) * 10) / 10, os: `${platform()} ${osRelease()}`, node: process.version },
      }),
    );
  }, 120_000);
});
