// Rewrites the golden files of the three outputs for the clean stand-in pair:  npm run golden -- --write
// Local use only: it refuses to run in CI, and the test suite never writes them. Review the diff before committing.
import { spawnSync } from "node:child_process";

if (process.env.CI) {
  console.error("golden: refusing to rewrite golden files in CI");
  process.exit(1);
}
if (!process.argv.includes("--write")) {
  console.error("golden: pass --write to rewrite tests/golden from the current build");
  process.exit(1);
}
const run = spawnSync("npx", ["vitest", "run", "tests/unit/golden.test.ts", "-t", "rewrites"], { stdio: "inherit", env: { ...process.env, GOLDEN_WRITE: "1" } });
process.exit(run.status ?? 1);
