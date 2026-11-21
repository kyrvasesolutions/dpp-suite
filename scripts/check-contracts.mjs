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
 *
 * Once the profile is frozen it also checks the Cycle 1 rules:
 *   C1-02  every reference names an exact id@version that resolves to a file in the pack; no "latest"
 *   C1-04  every definition_ref and nested member resolves to a governed term with a definition
 *   C1-05  sector labels carry a plain language tag and a separate sector context
 *   C1-06  every property has one source-status label; legal links resolve in the regulatory chain
 *   FUNC-030  every mapped unit equals the profile unit, or a declared conversion exists
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { PROVISIONS } from "../src/model/legislation.ts";

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

// ---------- Pinned reference files (C1-02 to C1-06) ----------

const PIN = /^[A-Z][A-Z0-9-]*@\d+\.\d+\.\d+$/;
const pinned = (kind, ref, ext) => {
  if (typeof ref !== "string" || !PIN.test(ref)) {
    fail(`${kind} reference "${ref}" must be an exact id@version (C1-02)`);
    return null;
  }
  const path = `${kind}/${ref}.${ext}`;
  if (!present.includes(path)) {
    fail(`${kind} reference ${ref} does not resolve to ${path} in the pack (C1-02)`);
    return null;
  }
  return path;
};
const readCodes = (path) =>
  readFileSync(join(ROOT, path), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("#"))
    .slice(1)
    .map((l) => l.split(",")[0].trim());
const pinnedYaml = (kind, ref) => {
  const path = pinned(kind, ref, "yaml");
  if (!path) return null;
  const doc = readYaml(path);
  if (`${doc.id}@${doc.version}` !== ref) fail(`${path}: id and version must be ${ref}`);
  status(path, doc);
  return doc;
};

if (profileFrozen) {
  const pins = profile.pins ?? {};
  if (!profile.release?.released || !profile.release?.released_by) fail(`${profilePath}: release metadata (released, released_by) is required (C1-01)`);

  // Terms (C1-04)
  const terms = pinnedYaml("terms", pins.terms);
  const termIds = new Map((terms?.terms ?? []).map((t) => [t.id, t]));
  for (const t of termIds.values()) if (!t.definition) fail(`term ${t.id} has no definition (C1-04)`);
  for (const p of properties) {
    if (!termIds.has(p.definition_ref)) fail(`${p.id}: definition_ref ${p.definition_ref} does not resolve to a governed term (C1-04)`);
    for (const m of p.members ?? []) if (!termIds.has(m)) fail(`${p.id}: member ${m} does not resolve to a governed term (C1-04)`);
  }

  // Code lists (C1-02, C1-03)
  const codeLists = new Map();
  for (const ref of [...(pins.code_lists ?? []), profile.sectors]) {
    const path = pinned("code-lists", ref, "csv");
    if (path) codeLists.set(ref, readCodes(path));
  }
  if (!codeLists.has(profile.sectors)) fail(`${profilePath}: sectors must name a pinned code list (C1-05)`);
  const erpInput = readYaml("inputs/erp-extract.csv.contract.yaml");
  for (const c of erpInput.columns ?? []) {
    if (c.code_list && !codeLists.has(c.code_list)) fail(`ERP column ${c.name}: code list ${c.code_list} is not pinned by the profile (C1-02)`);
  }

  // Sector labels (C1-05)
  const sectors = new Set(codeLists.get(profile.sectors) ?? []);
  for (const p of properties) {
    for (const l of p.context_labels ?? []) {
      if (!/^[a-z]{2,3}$/.test(l.lang ?? "") || !profile.languages.includes(l.lang)) {
        fail(`${p.id}: context label language "${l.lang}" must be a plain language tag of the profile (C1-05)`);
      }
      if (!sectors.has(l.context)) fail(`${p.id}: context "${l.context}" is not in ${profile.sectors} (C1-05)`);
      if (!l.text) fail(`${p.id}: context label for ${l.lang}/${l.context} has no text`);
    }
  }

  // Source-status labels and legal links (C1-06)
  const legal = pinnedYaml("legal", pins.legal);
  const statuses = new Set(Object.keys(legal?.statuses ?? {}));
  const entries = legal?.entries ?? [];
  for (const id of propertyIds) {
    const own = entries.filter((e) => e.property === id);
    if (own.length !== 1) {
      fail(`${id}: needs exactly one source-status entry, found ${own.length} (C1-06)`);
      continue;
    }
    const e = own[0];
    if (!statuses.has(e.status)) fail(`${id}: source status "${e.status}" is not defined (C1-06)`);
    if (e.status === "voluntary") {
      if (e.requirement || e.legislation) fail(`${id}: a voluntary property names no legal requirement (C1-06)`);
    } else if (!PROVISIONS.some((pr) => pr.dataRequirement === e.requirement && pr.legislation === e.legislation && pr.groups.includes("aluminium"))) {
      fail(`${id}: no aluminium provision for ${e.requirement} in ${e.legislation} in the regulatory chain (C1-06)`);
    }
  }
  for (const e of entries) if (!propertyIds.includes(e.property)) fail(`source-status entry ${e.property} is not a profile property`);

  // Units and conversions (FUNC-030 slice)
  const units = pinnedYaml("units", pins.units);
  const unitCodes = new Set((units?.units ?? []).map((u) => u.code));
  const converts = (from, to) => from === to || (units?.conversions ?? []).some((c) => c.from === from && c.to === to);
  const unitOf = new Map(properties.map((p) => [p.id, p.unit]));
  for (const p of properties) if (p.unit !== null && !unitCodes.has(p.unit)) fail(`${p.id}: unit ${p.unit} is not in ${pins.units}`);
  for (const c of erpInput.columns ?? []) {
    const target = unitOf.get(String(c.maps_to).split("/")[0]);
    if (c.unit && !converts(c.unit, target)) fail(`ERP column ${c.name}: no conversion from ${c.unit} to ${target} (FUNC-030)`);
  }
  for (const [prop, list] of Object.entries(lab.allowed_units ?? {})) {
    if (!unitOf.has(prop)) fail(`lab allowed_units: ${prop} is not a profile property`);
    for (const u of list) if (!converts(u, unitOf.get(prop))) fail(`lab allowed unit ${u} for ${prop}: no conversion to ${unitOf.get(prop)} (FUNC-030)`);
  }
}

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
