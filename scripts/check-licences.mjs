/**
 * Licence audit (criterion C5-02, assessment AT "dependency and licence audit"): reads the licence of every production
 * dependency installed in node_modules, dependencies of dependencies included, prints a table, and fails on any licence that is
 * not on the allow-list. The PDF library is pdf-lib (MIT) and embeds no font.
 *
 * An SPDX expression passes when one alternative of an OR is allowed, or every part of an AND is. A package with no stated
 * licence fails. Run after `npm ci`.
 *
 *   node scripts/check-licences.mjs [--root <dir>]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const ALLOWED = ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "OFL-1.1", "CC0-1.0", "BlueOak-1.0.0"];

/**
 * Licences outside the allow-list that were read and accepted by hand, each for one exact version, so a new version is audited
 * again. Both are permissive: Unlicense is a public-domain dedication, and pako carries the MIT licence together with the zlib
 * licence. They reach production through the Claude SDK (fast-sha256) and pdf-lib (pako). The allow-list itself is unchanged.
 */
export const REVIEWED_EXCEPTIONS = {
  "fast-sha256@1.3.0": "Unlicense (public-domain dedication), a dependency of the Claude SDK",
  "pako@1.0.11": "MIT AND Zlib (both permissive), a dependency of pdf-lib",
};

const rootAt = process.argv.indexOf("--root");
const root = resolve(rootAt > 0 ? process.argv[rootAt + 1] : process.cwd());

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** The licence text of a package.json: a string, an object with a type, or the legacy `licenses` array. */
function licenceOf(pkg) {
  const one = (l) => (typeof l === "string" ? l : l?.type);
  if (pkg.license) return one(pkg.license);
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) return pkg.licenses.map(one).join(" OR ");
  return undefined;
}

/** Whether an SPDX expression is on the allow-list. */
export function allowed(expression) {
  if (!expression) return false;
  const text = expression.replace(/[()]/g, " ").trim();
  return text.split(/\s+OR\s+/i).some((alt) => alt.split(/\s+AND\s+/i).every((id) => ALLOWED.includes(id.trim())));
}

/** Finds `name` the way Node would from the package at `from`: its own node_modules, then each parent's. */
function locate(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return candidate;
    if (dir === dirname(dir) || dir === dirname(root)) return undefined;
  }
}

const rootPkg = readJson(join(root, "package.json"));
const seen = new Map();
const missing = [];
const queue = Object.keys(rootPkg.dependencies ?? {}).map((name) => ({ name, from: root, parent: rootPkg.name }));
while (queue.length) {
  const { name, from, parent, optional } = queue.shift();
  const file = locate(name, from);
  if (!file) {
    if (!optional) missing.push(`${name} (required by ${parent})`);
    continue;
  }
  if (seen.has(file)) continue;
  const pkg = readJson(file);
  seen.set(file, { name: pkg.name ?? name, version: pkg.version, licence: licenceOf(pkg) });
  const dir = dirname(file);
  for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: dir, parent: pkg.name });
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: dep, from: dir, parent: pkg.name, optional: true });
}

const rows = [...seen.values()].sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version));
const width = Math.max(...rows.map((r) => `${r.name}@${r.version}`.length), 7);
console.log(`${"Package".padEnd(width)}  Licence`);
const excepted = (r) => !allowed(r.licence) && Object.hasOwn(REVIEWED_EXCEPTIONS, `${r.name}@${r.version}`);
for (const r of rows) {
  const mark = allowed(r.licence) ? "" : excepted(r) ? "   (reviewed exception)" : "   <-- NOT ALLOWED";
  console.log(`${`${r.name}@${r.version}`.padEnd(width)}  ${r.licence ?? "(none stated)"}${mark}`);
}

const bad = rows.filter((r) => !allowed(r.licence) && !excepted(r));
console.log(`\ncheck-licences: ${rows.length} production packages, allow-list ${ALLOWED.join(", ")}`);
for (const r of rows.filter(excepted)) console.log(`check-licences: reviewed exception ${r.name}@${r.version}: ${REVIEWED_EXCEPTIONS[`${r.name}@${r.version}`]}`);
if (missing.length) console.error(`check-licences: not installed, so not audited: ${missing.join(", ")}`);
if (bad.length || missing.length) {
  for (const r of bad) console.error(`check-licences: ${r.name}@${r.version} has licence ${r.licence ?? "(none stated)"}, which is not allowed`);
  process.exit(1);
}
console.log("check-licences: every licence is on the allow-list or a reviewed exception");
