/**
 * Secret scan (criterion C5-03): reads every tracked file, and every new file git does not ignore, and fails on a
 * pattern that looks like a key or a secret file. The Claude API key is never kept in the repository: the app holds it
 * in browser storage, behind a flag that is off by default.
 *
 * Patterns: Anthropic keys, GitHub tokens, AWS access keys and secret keys, private key blocks, and a committed `.env`
 * file (only `.env.example`-style templates and config/env.example are allowed). It prints the file, the line and the
 * kind of hit, never the secret itself.
 *
 *   node scripts/check-secrets.mjs [--root <dir>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
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

const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\0")
  .filter(Boolean);

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
  if (size > MAX_BYTES) continue;
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
console.log(`check-secrets: ${listed.length} files scanned, no secrets found`);
