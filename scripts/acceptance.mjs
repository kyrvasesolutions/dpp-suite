/**
 * Runs the acceptance suite (tests/acceptance, through the UI, on the production build) and writes its report:
 *
 *   npm run acceptance                 run the suite, then write test-results/acceptance-report.json and .md
 *   node scripts/acceptance.mjs --matrix   rewrite tests/acceptance/coverage.json from tests/acceptance/cases.ts
 *   node scripts/acceptance.mjs --report   only write the report from the last run
 *
 * The report lists every case with its result and duration and the FUNC, criterion and gate IDs of the coverage matrix. It
 * also checks the run against the matrix: a case that did not run, or a test that is not in the matrix, fails the command.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CASES, ROUTES } from "../tests/acceptance/cases.ts";

const MATRIX = "tests/acceptance/coverage.json";
const RAW = "test-results/acceptance-raw.json";
const arg = (a) => process.argv.includes(a);

if (arg("--matrix")) {
  writeFileSync(MATRIX, `${JSON.stringify({ routes: ROUTES, cases: CASES }, null, 2)}\n`);
  console.log(`acceptance: wrote ${MATRIX} with ${CASES.length} cases`);
  process.exit(0);
}

let status = 0;
if (!arg("--report")) {
  status = spawnSync("npx", ["playwright", "test", "-c", "playwright.acceptance.config.ts"], { stdio: "inherit" }).status ?? 1;
}

const walk = (suite, out = []) => {
  for (const s of suite.suites ?? []) walk(s, out);
  for (const spec of suite.specs ?? []) out.push(spec);
  return out;
};
const raw = JSON.parse(readFileSync(RAW, "utf8"));
const executed = new Map();
for (const spec of raw.suites.flatMap((s) => walk(s))) {
  const id = /^\[(AC-[A-Z0-9-]+)\]/.exec(spec.title)?.[1] ?? `UNLISTED:${spec.title}`;
  const result = spec.tests[0]?.results?.at(-1);
  const outcome = spec.tests[0]?.status === "skipped" ? "skipped" : result?.status === "passed" ? "passed" : "failed";
  executed.set(id, { outcome, ms: result?.duration ?? 0 });
}

const matrix = JSON.parse(readFileSync(MATRIX, "utf8")).cases;
const rows = matrix.map((c) => ({ ...c, result: executed.get(c.id)?.outcome ?? "not run", ms: executed.get(c.id)?.ms ?? 0 }));
const unlisted = [...executed.keys()].filter((id) => !matrix.some((c) => c.id === id));
const passed = rows.filter((r) => r.result === "passed").length;
const failed = rows.filter((r) => r.result !== "passed");

const summary = {
  generatedBy: "scripts/acceptance.mjs",
  cases: rows.length,
  passed,
  failed: failed.length,
  notRun: rows.filter((r) => r.result === "not run").length,
  unlisted,
  durationMs: Math.round(raw.stats?.duration ?? 0),
  results: rows.map((r) => ({ case: r.id, result: r.result, durationMs: Math.round(r.ms), class: r.class, route: r.route, outcome: r.outcome, funcs: r.funcs, criteria: r.criteria, gates: r.gates })),
};
mkdirSync("test-results", { recursive: true });
writeFileSync("test-results/acceptance-report.json", `${JSON.stringify(summary, null, 2)}\n`);

const md = [
  "# Acceptance report",
  "",
  `${passed} of ${rows.length} cases passed (${failed.length} not passed, ${unlisted.length} tests not in the matrix). Total ${(summary.durationMs / 1000).toFixed(1)} s.`,
  "",
  "| Case | Result | ms | Class | Route | Outcome | FUNC | Criteria | Gates |",
  "|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.id} | ${r.result} | ${Math.round(r.ms)} | ${r.class} | ${r.route} | ${r.outcome} | ${r.funcs.join(", ")} | ${r.criteria.join(", ")} | ${r.gates.join(", ")} |`),
  "",
].join("\n");
writeFileSync("test-results/acceptance-report.md", md);
console.log(`acceptance: ${passed}/${rows.length} cases passed; report in test-results/acceptance-report.json and .md`);

if (failed.length || unlisted.length) {
  for (const r of failed) console.error(`acceptance: ${r.id} ${r.result}`);
  for (const id of unlisted) console.error(`acceptance: ${id} is not in the coverage matrix`);
  status = status || 1;
}
process.exit(status);
