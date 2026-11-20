/**
 * Fixture packs are pinned by digest so every test run reads the same inputs (assessment criteria §3.1,
 * determinism rule). Each directory under fixtures/ has a MANIFEST.json with the sha256 of every file.
 *
 *   npm run check-fixtures              fail on any file that is missing, unlisted or changed
 *   npm run check-fixtures -- --write   rewrite every MANIFEST.json from the files as they are
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "fixtures";
const write = process.argv.includes("--write");
const errors = [];

const listFiles = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });

for (const pack of readdirSync(ROOT).filter((d) => statSync(join(ROOT, d)).isDirectory())) {
  const dir = join(ROOT, pack);
  const manifestPath = join(dir, "MANIFEST.json");
  const files = listFiles(dir)
    .map((p) => relative(dir, p))
    .filter((p) => p !== "MANIFEST.json" && !p.endsWith(".DS_Store"))
    .sort();
  const digests = Object.fromEntries(
    files.map((p) => [p, createHash("sha256").update(readFileSync(join(dir, p))).digest("hex")]),
  );
  if (write) {
    writeFileSync(manifestPath, JSON.stringify({ pack, files: digests }, null, 2) + "\n");
    console.log(`Wrote ${manifestPath} with ${files.length} files.`);
    continue;
  }
  let listed;
  try {
    listed = JSON.parse(readFileSync(manifestPath, "utf8")).files;
  } catch {
    errors.push(`${manifestPath} is missing or not valid JSON; run with --write`);
    continue;
  }
  for (const p of files) if (!(p in listed)) errors.push(`${pack}/${p} is not in its MANIFEST.json`);
  for (const [p, digest] of Object.entries(listed)) {
    if (!(p in digests)) errors.push(`${pack}/${p} is in MANIFEST.json but missing`);
    else if (digests[p] !== digest) errors.push(`${pack}/${p} does not match its digest`);
  }
  console.log(`${pack}: ${files.length} files`);
}

if (errors.length) {
  for (const e of errors) console.error(`check-fixtures: ${e}`);
  process.exit(1);
}
