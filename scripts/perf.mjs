/**
 * Performance report (Cycle 5). Runs the complete one-record, two-input, three-route scenario (import both files, assess
 * readiness, make the three outputs and the manifest) 30 times in Node on the model functions, and reports p50 and p95 for the
 * first run (cold) and the other 29 (warm), with the machine description. It also takes one timing in a real browser (cold and
 * warm). It reports only: it never fails on a number and never runs as a gate. The target is p95 of at most 5 s.
 *
 *   npm run perf
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

mkdirSync("test-results", { recursive: true });
const OUT = "test-results/perf-node.json";
const run = spawnSync("npx", ["vitest", "run", "tests/unit/perfScenario.test.ts"], { stdio: "inherit", env: { ...process.env, PERF: "1", PERF_OUT: OUT } });
if (run.status !== 0) process.exit(run.status ?? 1);
const { runs, machine } = JSON.parse(readFileSync(OUT, "utf8"));

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const ms = (n) => `${n.toFixed(1)} ms`;
const stat = (xs) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), min: Math.min(...xs), max: Math.max(...xs) });
const node = { all: stat(runs), cold: { n: 1, p50: runs[0], p95: runs[0] }, warm: stat(runs.slice(1)) };

// One real-browser timing: pick the two files on the Import screen, then wait for the three outputs on the Outputs screen.
async function browserTiming() {
  if (!existsSync("dist/index.html")) spawnSync("npm", ["run", "build"], { stdio: "inherit" });
  const server = spawn("./node_modules/.bin/vite", ["preview", "--port", "4173", "--strictPort"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch("http://localhost:4173/")).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    const browser = await chromium.launch();
    const times = [];
    try {
      for (let i = 0; i < 5; i++) {
        const context = await browser.newContext({ baseURL: "http://localhost:4173", acceptDownloads: true });
        const page = await context.newPage();
        await page.goto("/#import");
        await page.getByRole("heading", { name: "Import source files" }).waitFor();
        const file = (name, mimeType) => ({ name, mimeType, buffer: readFileSync(`fixtures/n/${name}`) });
        const t0 = Date.now();
        await page.getByTestId("pick-lab").setInputFiles(file("d03a-lab-assessment.json", "application/json"));
        await page.getByTestId("pick-erp").setInputFiles(file("d03a-erp-extract.csv", "text/csv"));
        await page.getByTestId("snapshot-status").first().waitFor();
        await page.goto("/#outputs");
        await page.locator('[data-testid="output-route"]').nth(2).waitFor();
        times.push(Date.now() - t0);
        await context.close();
      }
    } finally {
      await browser.close();
    }
    return { cold: times[0], warm: times.slice(1), warmP50: pct(times.slice(1), 50) };
  } finally {
    server.kill();
  }
}
const browser = await browserTiming().catch((e) => ({ error: String(e) }));

const report = { target: "p95 at most 5000 ms (a reporting target, not a gate)", scenario: "import ERP extract and laboratory file, assess readiness, make the three outputs and the manifest, one record", machine, node, browser };
writeFileSync("test-results/perf-report.json", `${JSON.stringify(report, null, 2)}\n`);
const lines = [
  "# Performance report",
  "",
  `Machine: ${machine.cpu}, ${machine.logicalCores} logical cores, ${machine.memoryGiB} GiB, ${machine.os}, Node ${machine.node}.`,
  "",
  "| Runs | n | p50 | p95 | min | max |",
  "|---|---|---|---|---|---|",
  `| All (Node, model functions) | ${node.all.n} | ${ms(node.all.p50)} | ${ms(node.all.p95)} | ${ms(node.all.min)} | ${ms(node.all.max)} |`,
  `| Cold (first run) | 1 | ${ms(node.cold.p50)} | ${ms(node.cold.p95)} | | |`,
  `| Warm (runs 2 to 30) | ${node.warm.n} | ${ms(node.warm.p50)} | ${ms(node.warm.p95)} | ${ms(node.warm.min)} | ${ms(node.warm.max)} |`,
  "",
  browser.error ? `Browser timing not taken: ${browser.error}` : `Browser (Chromium, pick both files, then three outputs on screen): cold ${browser.cold} ms, warm median ${browser.warmP50} ms over ${browser.warm.length} runs.`,
  "",
  `Target: p95 at most 5000 ms. Result: ${node.all.p95 <= 5000 ? "met" : "not met"} (reported only).`,
  "",
];
writeFileSync("test-results/perf-report.md", lines.join("\n"));
console.log(lines.join("\n"));
