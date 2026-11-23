/**
 * Secret scan (criterion C5-03): reads every tracked file, and every new file git does not ignore, and fails on a
 * pattern that looks like a key or a secret file. The Claude API key is never kept in the repository: the app holds it
 * in browser storage, behind a flag that is off by default.
 *
 * Patterns: Anthropic keys, GitHub tokens, AWS access keys and secret keys, private key blocks, JWTs, Google API keys,
 * npm tokens, Slack tokens, and a committed environment file (`.env`, `.env.*`, `*.env` such as `prod.env`; only
 * `.example`, `.sample` and `.template` versions are allowed).
 *
 * Every file is read and scanned, in chunks, whatever its size: nothing is skipped silently. A file that cannot be read
 * fails the scan. A file with NUL bytes is skipped only when its extension is on the explicit binary list below; any other
 * file is scanned as bytes. It prints the file, the line and the
 * kind of hit, never the secret itself.
 *
 * The build output (dist/ and dist-server/) is scanned too when it exists (D8-06, threat T18), since a key can enter
 * a bundle without being in a tracked file. With --build only the build output is scanned and it must exist.
 *
 *   node scripts/check-secrets.mjs [--root <dir>] [--build]
 */
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

const PATTERNS = [
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{22,}/g],
  ["AWS access key ID", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["AWS secret access key", /aws_secret_access_key["']?\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}/gi],
  ["private key block", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}/g],
];

/**
 * Precise exceptions, file by file: path -> { kinds, why }. A hit of one of `kinds` in exactly that file is not reported.
 * Each needs a justification; there are no wildcards.
 */
export const ALLOWED = {};

const ENV_FILE = /^(?:\.env(?:\..+)?|.+\.env)$/;
const ENV_TEMPLATE = /\.(example|sample|template)$/;
const BINARY_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".pdf", ".sqlite", ".sqlite3", ".db", ".wasm", ".zip", ".gz", ".tgz", ".br", ".xlsx", ".docx", ".pptx", ".mp4", ".webm", ".mp3", ".bin", ".pdf"]);
const CHUNK = 4 * 1024 * 1024;
const OVERLAP = 4096; // longer than any one secret pattern, so a secret cannot hide on a chunk boundary

const rootAt = process.argv.indexOf("--root");
const root = rootAt > 0 ? process.argv[rootAt + 1] : process.cwd();

const buildOnly = process.argv.includes("--build");
const BUILD_DIRS = ["dist", "dist-server"];

function walk(dir, base, out) {
  for (const entry of readdirSync(join(root, dir, base), { withFileTypes: true })) {
    const rel = join(base, entry.name);
    if (entry.isDirectory()) walk(dir, rel, out);
    else if (entry.isFile()) out.push(join(dir, rel));
  }
}

/** Scans one file in chunks as bytes (latin1 keeps one char per byte). Returns hits as [line, kind]; throws if unreadable. */
function scanFile(file) {
  const fd = openSync(join(root, file), "r");
  const hits = [];
  const seen = new Set();
  try {
    const buf = Buffer.alloc(CHUNK);
    let carry = "";
    let consumed = 0; // bytes before the current chunk
    let linesBeforeCarry = 0;
    let first = true;
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      if (first) {
        first = false;
        if (buf.subarray(0, Math.min(n, 8000)).includes(0) && BINARY_EXTS.has(extname(file).toLowerCase())) return { hits, skipped: true };
      }
      const text = carry + buf.toString("latin1", 0, n);
      const textStart = consumed - carry.length;
      for (const [kind, re] of PATTERNS) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          const abs = textStart + m.index;
          const key = `${kind}@${abs}`;
          if (seen.has(key)) continue;
          seen.add(key);
          let lines = linesBeforeCarry + 1;
          for (let i = text.indexOf("\n"); i !== -1 && i < m.index; i = text.indexOf("\n", i + 1)) lines++;
          hits.push([lines, kind]);
        }
      }
      consumed += n;
      const keep = Math.min(OVERLAP, text.length);
      const dropped = text.slice(0, text.length - keep);
      for (let i = dropped.indexOf("\n"); i !== -1; i = dropped.indexOf("\n", i + 1)) linesBeforeCarry++;
      carry = text.slice(text.length - keep);
    }
  } finally {
    closeSync(fd);
  }
  return { hits, skipped: false };
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

const hits = [];
let skipped = 0;
for (const file of listed) {
  const name = basename(file);
  if (ENV_FILE.test(name) && !ENV_TEMPLATE.test(name)) hits.push(`${file}: an environment file must not be committed`);
  let st;
  try {
    st = statSync(join(root, file));
  } catch (e) {
    if (e && e.code === "ENOENT") continue; // listed by git but deleted from the working tree
    hits.push(`${file}: cannot be read (${e && e.code ? e.code : "error"}); the scan fails closed`);
    continue;
  }
  if (!st.isFile()) continue; // a directory (submodule) or similar: nothing to read
  try {
    const r = scanFile(file);
    if (r.skipped) skipped++;
    const allowed = ALLOWED[file]?.kinds ?? [];
    for (const [line, kind] of r.hits) if (!allowed.includes(kind)) hits.push(`${file}:${line}: ${kind}`);
  } catch (e) {
    hits.push(`${file}: cannot be read (${e && e.code ? e.code : "error"}); the scan fails closed`);
  }
}

if (hits.length) {
  console.error(`check-secrets: ${hits.length} problem${hits.length === 1 ? "" : "s"} found:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-secrets: ${listed.length} files scanned${skipped ? ` (${skipped} binary by extension skipped)` : ""}${present.length ? ` (including ${present.join(" and ")})` : ""}, no secrets found`);
