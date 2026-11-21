/**
 * Checks the frozen N contract pack in contracts/n (assessment criterion C0-01).
 *
 *   npm run check-contracts                      structure, digests and, once frozen, the full rules
 *   npm run check-contracts -- --write           rewrite MANIFEST.json from the files as they are
 *   npm run check-contracts -- --require-frozen  also fail while any part is still on HOLD
 *   npm run check-contracts -- --pack <dir>      check another pack, such as the private one (decision D1-01)
 *
 * A part on HOLD must say why. The registry route stays on HOLD after the pack is frozen, until an
 * applicable external contract exists, so it never fails --require-frozen.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

const argv = process.argv.slice(2);
const packAt = argv.indexOf("--pack");
const ROOT = packAt >= 0 ? argv[packAt + 1] : "contracts/n";
if (!ROOT || ROOT.startsWith("--")) {
  console.error("check-contracts: --pack needs a directory");
  process.exit(1);
}
const MANIFEST = join(ROOT, "MANIFEST.json");
const ROUTES = ["customer-pdf", "erp-staging-csv", "registry-prep-json"];
const STANDING_HOLDS = new Set(["routes/registry-prep-json.yaml"]);
const ACCESS = new Set(["permit", "deny", "derived"]);

const args = new Set(argv);
const errors = [];
const holds = [];
const fail = (msg) => errors.push(msg);

const listFiles = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });

const packFiles = () =>
  listFiles(ROOT)
    .map((p) => relative(ROOT, p))
    .filter((p) => p !== "MANIFEST.json" && !p.endsWith(".DS_Store"))
    .sort();

const sha256 = (path) => createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex");
const readYaml = (path) => parse(readFileSync(join(ROOT, path), "utf8"));

function readMatrix() {
  const lines = readFileSync(join(ROOT, "policy/actor-field-matrix.csv"), "utf8").split(/\r?\n/);
  const status = lines.find((l) => l.startsWith("#"))?.match(/status:\s*(\w+)/)?.[1] ?? "unknown";
  const rows = lines.filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split(",").map((c) => c.trim()));
  return { status, header: rows[0] ?? [], body: rows.slice(1) };
}

/** Records a part's status; a HOLD needs a reason. */
function status(path, doc) {
  if (doc.status === "FROZEN") return true;
  if (doc.status !== "HOLD") fail(`${path}: status must be FROZEN or HOLD, found "${doc.status}"`);
  else if (!doc.hold_reason) fail(`${path}: a HOLD needs a hold_reason`);
  else holds.push(path);
  return false;
}

if (args.has("--write")) {
  const files = Object.fromEntries(packFiles().map((p) => [p, sha256(p)]));
  const profile = readYaml("profile/PROFILE-ALU-24-01@1.0.0.yaml");
  const manifest = { pack: "N contract pack", profile: `${profile.id}@${profile.version}`, files };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Wrote ${MANIFEST} with ${Object.keys(files).length} files.`);
}

// ---------- Manifest and digests ----------

if (!existsSync(MANIFEST)) {
  console.error(`check-contracts: ${MANIFEST} is missing; run with --write`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const listed = Object.keys(manifest.files ?? {}).sort();
const present = packFiles();
for (const p of present) if (!listed.includes(p)) fail(`${p} is not in MANIFEST.json`);
for (const p of listed) {
  if (!present.includes(p)) fail(`${p} is in MANIFEST.json but missing`);
  else if (sha256(p) !== manifest.files[p]) fail(`${p} does not match its digest in MANIFEST.json`);
}

// ---------- Profile ----------

const profilePath = "profile/PROFILE-ALU-24-01@1.0.0.yaml";
const profile = readYaml(profilePath);
if (profile.id !== "PROFILE-ALU-24-01" || profile.version !== "1.0.0") fail(`${profilePath}: id or version changed`);
if (JSON.stringify(profile.routes) !== JSON.stringify(ROUTES)) fail(`${profilePath}: routes must be ${ROUTES.join(", ")}`);
const profileFrozen = status(profilePath, profile);
const properties = profile.properties ?? [];
const propertyIds = properties.map((p) => p.id);
const memberIds = properties.flatMap((p) => p.members ?? []);

if (profileFrozen) {
  if (properties.length !== 24) fail(`${profilePath}: ${properties.length} business properties, expected 24`);
  if (new Set(propertyIds).size !== propertyIds.length) fail(`${profilePath}: duplicate property IDs`);
  for (const p of properties) {
    if (!/^ALU-D\d{3}$/.test(p.id ?? "")) fail(`${profilePath}: "${p.id}" is not an ALU-Dnnn identifier`);
    if (!p.definition_ref) fail(`${profilePath}: ${p.id} has no definition_ref`);
    if (!p.labels?.en || !p.labels?.de) fail(`${profilePath}: ${p.id} needs EN and DE labels`);
    if (!("unit" in p)) fail(`${profilePath}: ${p.id} must state a unit (null when none applies)`);
    for (const r of ROUTES) {
      if (typeof p.required_by?.[r] !== "boolean") fail(`${profilePath}: ${p.id} must say whether ${r} requires it`);
    }
  }
} else if (properties.length) {
  fail(`${profilePath}: properties are filled while the profile is on HOLD; freeze it or empty the list`);
}

// ---------- Inputs ----------

for (const path of ["inputs/erp-extract.csv.contract.yaml", "inputs/lab-assessment.contract.yaml"]) {
  const input = readYaml(path);
  status(path, input);
  const stages = input.ingress?.stages ?? [];
  for (const s of ["bytes", "parse", "structure", "semantics", "authorisation", "route"]) {
    if (!stages.includes(s)) fail(`${path}: ingress stage "${s}" missing`);
  }
  if (input.encoding !== "UTF-8") fail(`${path}: encoding must be UTF-8`);
}
const lab = readYaml("inputs/lab-assessment.contract.yaml");
for (const rule of ["duplicate object keys", "non-finite numbers"]) {
  if (!lab.ingress?.reject?.some((r) => String(r).startsWith(rule))) fail(`lab input must reject ${rule} (C2-02)`);
}

// ---------- Routes ----------

const routeFiles = present.filter((p) => p.startsWith("routes/"));
const routeIds = routeFiles.map((p) => readYaml(p).id).sort();
if (JSON.stringify(routeIds) !== JSON.stringify([...ROUTES].sort())) fail(`routes must be exactly ${ROUTES.join(", ")}`);
for (const path of routeFiles) {
  const route = readYaml(path);
  if (`routes/${route.id}.yaml` !== path) fail(`${path}: id "${route.id}" does not match the file name`);
  if (!route.recipient || !route.format) fail(`${path}: recipient and format are required`);
  const frozen = status(path, route);
  if (frozen && profileFrozen) {
    for (const f of route.fields ?? []) {
      if (!propertyIds.includes(f) && !memberIds.includes(f)) fail(`${path}: field ${f} is not in the profile`);
    }
  }
}
const registry = readYaml("routes/registry-prep-json.yaml");
if (registry.submission !== "never") fail("routes/registry-prep-json.yaml: submission must be never (FUNC-042)");
if (registry.status !== "HOLD") fail("routes/registry-prep-json.yaml: must stay on HOLD until an external contract exists");

// ---------- Actor/field matrix ----------

const matrix = readMatrix();
if (JSON.stringify(matrix.header) !== JSON.stringify(["property", ...ROUTES])) {
  fail(`policy/actor-field-matrix.csv: header must be property,${ROUTES.join(",")}`);
}
if (matrix.status === "FROZEN") {
  const rowIds = matrix.body.map((r) => r[0]);
  for (const id of propertyIds) if (!rowIds.includes(id)) fail(`actor/field matrix has no row for ${id}`);
  for (const r of matrix.body) {
    if (!propertyIds.includes(r[0])) fail(`actor/field matrix row ${r[0]} is not a profile property`);
    for (const v of r.slice(1)) if (!ACCESS.has(v)) fail(`actor/field matrix ${r[0]}: "${v}" is not permit, deny or derived`);
  }
} else if (matrix.status === "HOLD") holds.push("policy/actor-field-matrix.csv");
else fail(`policy/actor-field-matrix.csv: first line must be "# status: FROZEN" or "# status: HOLD …"`);

// ---------- Failure cases ----------

const caseFiles = present.filter((p) => p.startsWith("failure-cases/"));
if (caseFiles.length === 0) fail("no failure cases");
const caseIds = new Set();
for (const path of caseFiles) {
  const c = readYaml(path);
  for (const key of ["id", "class", "criterion", "input", "expected", "fixture"]) {
    if (!c[key]) fail(`${path}: "${key}" is required`);
  }
  if (caseIds.has(c.id)) fail(`${path}: duplicate id ${c.id}`);
  caseIds.add(c.id);
  for (const id of [c.criterion, ...(c.also_tested_by ?? [])]) {
    if (!/^C\d+-\d{2}$/.test(id ?? "")) fail(`${path}: "${id}" is not a criterion ID such as C2-02`);
  }
  if (c.fixture === "pending") holds.push(`${path} (fixture)`);
  else if (c.fixture && !existsSync(c.fixture)) fail(`${path}: fixture ${c.fixture} does not exist`);
}

// ---------- Report ----------

const blocking = holds.filter((h) => !STANDING_HOLDS.has(h));
console.log(`N contract pack ${ROOT}: ${present.length} files, ${caseFiles.length} failure cases, ${propertyIds.length} properties.`);
if (holds.length) {
  console.log(`HOLD (${holds.length}):`);
  for (const h of holds) console.log(`  ${h}${STANDING_HOLDS.has(h) ? "  (standing hold)" : ""}`);
}
if (errors.length) {
  for (const e of errors) console.error(`check-contracts: ${e}`);
  process.exit(1);
}
if (args.has("--require-frozen") && blocking.length) {
  console.error(`check-contracts: ${blocking.length} part(s) still on HOLD`);
  process.exit(1);
}
if (blocking.length) console.log("Structure and digests OK; pack not frozen.");
else console.log(`Pack frozen; all checks passed${holds.length ? " (registry route on its standing hold)" : ""}.`);
