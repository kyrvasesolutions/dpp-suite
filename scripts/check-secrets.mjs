/**
 * Secret scan (criterion C5-03): reads every tracked file, and every new file git does not ignore, and fails on a
 * pattern that looks like a key or a secret file. The Claude API key is never kept in the repository: the app holds it
 * in browser storage, behind a flag that is off by default.
 *
 * Patterns: Anthropic keys, GitHub tokens, AWS access keys and secret keys, private key blocks, and a committed `.env`
 * file (only `.env.example`-style templates and config/env.example are allowed). It prints the file, the line and the
 * kind of hit, never the secret itself.
 *
 * The build output (dist/ and dist-server/) is scanned too when it exists (D8-06, threat T18), since a key can enter
 * a bundle without being in a tracked file. With --build only the build output is scanned and it must exist.
 *
 *   node scripts/check-secrets.mjs [--root <dir>] [--build]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const PATTERNS = [
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{22,}/],
  ["AWS access key ID", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["AWS secret access key", /aws_secret_access_key["']?\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}/i],
  ["private key block", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/],
];

const ENV_FILE = /^\.env(\..+)?$/;
const ENV_TEMPLATE = /\.(example|sample|template)$/;
const MAX_BYTES = 5 * 1024 * 1024;

const rootAt = process.argv.indexOf("--root");
const root = rootAt > 0 ? process.argv[rootAt + 1] : process.cwd();

const buildOnly = process.argv.includes("--build");
const BUILD_DIRS = ["dist", "dist-server"];
const MAX_BUILD_BYTES = 64 * 1024 * 1024;

function walk(dir, base, out) {
  for (const entry of readdirSync(join(root, dir, base), { withFileTypes: true })) {
    const rel = join(base, entry.name);
    if (entry.isDirectory()) walk(dir, rel, out);
    else if (entry.isFile()) out.push(join(dir, rel));
  }
}

const present = BUILD_DIRS.filter((d) => existsSync(join(root, d)));
const buildFiles = [];
for (const d of present) walk(d, "", buildFiles);
if (buildOnly && present.length === 0) {
  console.error("check-secrets: --build was given but neither dist/ nor dist-server/ exists; build first");
  process.exit(1);
}

const tracked = buildOnly
  ? []
  : execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\0")
      .filter(Boolean);
const listed = [...new Set([...tracked, ...buildFiles])];
const isBuild = new Set(buildFiles);

const hits = [];
for (const file of listed) {
  const name = basename(file);
  if (ENV_FILE.test(name) && !ENV_TEMPLATE.test(name)) hits.push(`${file}: an environment file must not be committed`);
  let size;
  try {
    size = statSync(join(root, file)).size;
  } catch {
    continue; // listed but deleted from the working tree
  }
  if (size > (isBuild.has(file) ? MAX_BUILD_BYTES : MAX_BYTES)) continue;
  const bytes = readFileSync(join(root, file));
  if (bytes.subarray(0, 8000).includes(0)) continue; // binary
  const lines = bytes.toString("utf8").split("\n");
  lines.forEach((line, i) => {
    for (const [kind, pattern] of PATTERNS) if (pattern.test(line)) hits.push(`${file}:${i + 1}: ${kind}`);
  });
}

if (hits.length) {
  console.error(`check-secrets: ${hits.length} possible secret${hits.length === 1 ? "" : "s"} found:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-secrets: ${listed.length} files scanned${present.length ? ` (including ${present.join(" and ")})` : ""}, no secrets found`);
