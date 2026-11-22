/**
 * Checks the frozen N contract pack in contracts/n (assessment criterion C0-01).
 *
 *   npm run check-contracts                      structure, digests and, once frozen, the full rules
 *   npm run check-contracts -- --write           rewrite MANIFEST.json from the files as they are
 *   npm run check-contracts -- --require-frozen  also fail while any part is still on HOLD
 *   npm run check-contracts -- --pack <dir>      check another pack, such as the private one (decision D1-01)
 *   npm run check-contracts -- --require-signed  also fail unless sha256(MANIFEST.json) is the digest the owner
 *                                                signed, in SIGNATURES.json next to the pack directory
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
import { basename, dirname, join, relative } from "node:path";
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
    // README files are local notes, kept out of version control, so they are not part of the pinned pack.
    .filter((p) => p !== "MANIFEST.json" && !p.endsWith(".DS_Store") && !p.endsWith("README.md"))
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

const PIN = /^[A-Za-z][A-Za-z0-9-]*@\d+\.\d+\.\d+$/;
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

  // Mapping contracts and routes are pinned by exact id@version too (C1-02)
  const SEMVER = /^\d+\.\d+\.\d+$/;
  const pinnedDocs = (kind, refs, prefix) => {
    const docs = present.filter((p) => p.startsWith(prefix)).map((p) => [p, readYaml(p)]);
    const found = docs.map(([, d]) => `${d.id}@${d.version}`).sort();
    for (const [p, d] of docs) if (!SEMVER.test(String(d.version))) fail(`${p}: version "${d.version}" must be an exact version such as 1.0.0 (C1-02)`);
    for (const ref of refs ?? []) if (typeof ref !== "string" || !PIN.test(ref)) fail(`${kind} reference "${ref}" must be an exact id@version (C1-02)`);
    if (JSON.stringify([...(refs ?? [])].sort()) !== JSON.stringify(found)) {
      fail(`${profilePath}: pins.${kind} must be exactly ${found.join(", ")} (C1-02)`);
    }
  };
  pinnedDocs("inputs", pins.inputs, "inputs/");
  pinnedDocs("route_contracts", pins.route_contracts, "routes/");

  // Policy files: the fixed readiness rules and the only permitted derived disclosures (Cycle 3)
  const policyRefs = pins.policy ?? [];
  const policyYaml = present.filter((p) => /^policy\/[^/]+\.yaml$/.test(p));
  const policyFound = policyYaml.map((p) => readYaml(p)).map((d) => `${d.id}@${d.version}`).sort();
  if (JSON.stringify([...policyRefs].sort()) !== JSON.stringify(policyFound)) {
    fail(`${profilePath}: pins.policy must be exactly ${policyFound.join(", ")}`);
  }
  const readiness = pinnedYaml("policy", policyRefs.find((r) => r.startsWith("READINESS-RULES@")));
  const derived = pinnedYaml("policy", policyRefs.find((r) => r.startsWith("DERIVED-RULES@")));
  if (!readiness) fail(`${profilePath}: pins.policy must pin READINESS-RULES`);
  if (!derived) fail(`${profilePath}: pins.policy must pin DERIVED-RULES`);
  const unique = (what, list, pattern) => {
    const ids = list.map((r) => r.id);
    if (new Set(ids).size !== ids.length) fail(`${what}: duplicate rule IDs`);
    for (const r of list) {
      if (!pattern.test(r.id ?? "")) fail(`${what}: "${r.id}" is not a stable rule ID`);
      if (!r.text && !r.output) fail(`${what}: ${r.id} has no text`);
    }
    return new Set(ids);
  };
  if (readiness) {
    const ids = unique("readiness rules", readiness.rules ?? [], /^RR-[A-Z]+(-[A-Z]+)*$/);
    for (const id of ["RR-MISSING", "RR-INACCESSIBLE", "RR-CHALLENGED", "RR-UNKNOWN-CODE", "RR-SEVERAL-RESULTS", "RR-DRAFT-TEXT", "RR-EVIDENCE-DIGEST", "RR-DERIVED-UNDETERMINABLE", "RR-PDF-CHARACTER", "RR-STANDING-HOLD"]) {
      if (!ids.has(id)) fail(`readiness rules: ${id} is missing (C3-03)`);
    }
    unique("readiness checks", readiness.checks ?? [], /^CK-[A-Z]+(-[A-Z]+)*$/);
  }
  if (derived) {
    unique("derived rules", derived.rules ?? [], /^DR-[A-Z]+(-[A-Z]+)*$/);
    const derivedCells = new Set(matrix.body.filter((r) => r.slice(1).includes("derived")).map((r) => r[0]));
    for (const id of derivedCells) {
      const own = (derived.rules ?? []).filter((r) => r.property === id);
      if (own.length !== 1) fail(`${id}: has a derived cell in the matrix and needs exactly one derived rule, found ${own.length} (C3-05)`);
    }
    for (const r of derived.rules ?? []) {
      if (!derivedCells.has(r.property)) fail(`derived rule ${r.id}: ${r.property} has no derived cell in the matrix`);
      if (!["limits-by-alloy-and-temper", "limits-by-alloy-and-element"].includes(r.method)) fail(`derived rule ${r.id}: unknown method "${r.method}"`);
      if (!r.standard || !derived.limits?.[r.limits]?.entries?.length) fail(`derived rule ${r.id}: needs a standard and a limits table`);
      if (r.illustrative !== true) fail(`derived rule ${r.id}: limits must be marked illustrative: true`);
    }
    if (derived.limits?.illustrative !== true) fail("derived rules: the limits table must be marked illustrative: true");
    const alloys = new Set(codeLists.get("ALLOY@1.0.0") ?? []);
    const tempers = new Set(codeLists.get("TEMPER@1.0.0") ?? []);
    for (const e of derived.limits?.tensile?.entries ?? []) {
      if (!alloys.has(e.alloy) || !tempers.has(e.temper)) fail(`derived limits: ${e.alloy} ${e.temper} is not in the alloy and temper code lists`);
    }
    for (const e of derived.limits?.composition?.entries ?? []) {
      if (!alloys.has(e.alloy)) fail(`derived limits: ${e.alloy} is not in the alloy code list`);
    }
  }

  // Output mappings (Cycle 4): every field has exactly one item, every item reads a field the matrix permits or derives
  const accessOf = (prop, route) => matrix.body.find((r) => r[0] === prop)?.[1 + ROUTES.indexOf(route)];
  const memberOf = (prop) => new Set(properties.find((p) => p.id === prop)?.members ?? []);
  const allSteps = new Set();
  for (const route of ROUTES) {
    const where = `routes/${route}.yaml`;
    const doc = readYaml(where);
    const items = doc.output?.items;
    if (!Array.isArray(items) || !items.length) {
      fail(`${where}: output.items is required (C4)`);
      continue;
    }
    const fields = doc.fields ?? [];
    const sectionIds = (doc.output.sections ?? []).map((x) => x.id);
    if (route === "customer-pdf" && (!sectionIds.length || (doc.output.sections ?? []).some((x) => !x.en || !x.de))) fail(`${where}: output.sections needs EN and DE titles`);
    if (route !== "customer-pdf" && doc.output.sections) fail(`${where}: only the customer PDF has sections`);
    const prefix = { "customer-pdf": "PDF", "erp-staging-csv": "ERP", "registry-prep-json": "REG" }[route];
    const permitted = propertyIds.filter((id) => accessOf(id, route) !== "deny");
    if (JSON.stringify([...fields].sort()) !== JSON.stringify([...permitted].sort())) fail(`${where}: fields must be exactly the properties the matrix permits or derives for the route`);
    const names = new Set();
    const fieldItems = new Map();
    items.forEach((item, n) => {
      const id = `${where} item ${item.step ?? n + 1}`;
      if (!new RegExp(`^MAP-${prefix}-\\d{3}$`).test(item.step ?? "")) fail(`${id}: step ID must look like MAP-${prefix}-001`);
      if (allSteps.has(item.step)) fail(`${id}: duplicate step ID`);
      allSteps.add(item.step);
      if (item.role !== "field" && item.role !== "context") fail(`${id}: role must be field or context`);
      const access = accessOf(item.property, route);
      if (!access) fail(`${id}: ${item.property} is not a profile property`);
      else if (access === "deny") fail(`${id}: reads ${item.property}, which the matrix denies for ${route}`);
      else if (!fields.includes(item.property)) fail(`${id}: reads ${item.property}, which is not a field of the route`);
      const kind = item.reads?.kind;
      if (!["value", "members", "member", "derived"].includes(kind)) fail(`${id}: reads.kind "${kind}" is not value, members, member or derived`);
      if (access === "derived" && (kind !== "derived" || item.role !== "field")) fail(`${id}: ${item.property} is derived for ${route}, so its one item must be a derived statement`);
      if (access === "permit" && kind === "derived") fail(`${id}: ${item.property} is permitted for ${route}; a derived statement is not allowed`);
      if (kind === "derived") {
        const own = (derived?.rules ?? []).filter((r) => r.property === item.property);
        if (own.length !== 1 || item.reads.rule !== own[0].id) fail(`${id}: derived item must name the derived rule of ${item.property}`);
      }
      for (const m of [...(kind === "members" ? item.reads.members ?? [] : []), ...(kind === "member" ? [item.reads.member] : []), ...(item.reads?.details ?? [])]) {
        if (!memberOf(item.property).has(m)) fail(`${id}: ${m} is not a member of ${item.property}`);
      }
      if (item.role === "field") {
        if (fieldItems.has(item.property)) fail(`${id}: ${item.property} already has an item`);
        fieldItems.set(item.property, item);
      } else if (kind !== "member") fail(`${id}: a context item reads one member`);
      const place = route === "customer-pdf" ? item.pdf : route === "erp-staging-csv" ? item.csv : item.json;
      if (!place) fail(`${id}: no ${route === "customer-pdf" ? "pdf" : route === "erp-staging-csv" ? "csv" : "json"} placement`);
      else if (route === "erp-staging-csv") {
        if (!["number", "text"].includes(place.format)) fail(`${id}: csv format must be number or text`);
        for (const [kind, k] of [["name", place.name], ["header", place.header]]) {
          if (!k || names.has(`${kind}:${k}`)) fail(`${id}: csv ${kind} "${k}" is missing or not unique`);
          names.add(`${kind}:${k}`);
        }
      } else if (route === "registry-prep-json") {
        if (!String(place.path ?? "").startsWith("/") || names.has(place.path)) fail(`${id}: json path "${place.path}" must start with / and be unique`);
        names.add(place.path);
      } else if (!place.label?.en || !place.label?.de || !sectionIds.includes(place.section) || place.order !== n + 1) fail(`${id}: pdf section, EN and DE labels and a running order are required`);
    });
    for (const f of fields) if (!fieldItems.has(f)) fail(`${where}: field ${f} has no output item`);
    if (route === "registry-prep-json" && items.some((i) => accessOf(i.property, route) !== "permit")) fail(`${where}: the registry output names only permitted fields`);
  }

  // Declared mappings point at a profile property and, for a member path, one of its members (FUNC-091)
  const membersOf = new Map(properties.map((p) => [p.id, p.members ?? []]));
  for (const c of erpInput.columns ?? []) {
    const [base, member, ...rest] = String(c.maps_to).split("/");
    if (!membersOf.has(base)) fail(`ERP column ${c.name}: maps_to ${c.maps_to} is not a profile property (FUNC-091)`);
    else if (member && !membersOf.get(base).includes(member)) fail(`ERP column ${c.name}: ${member} is not a member of ${base} (FUNC-091)`);
    if (rest.length) fail(`ERP column ${c.name}: maps_to ${c.maps_to} is nested too deeply`);
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
    const [base, member] = String(c.maps_to).split("/");
    const target = unitOf.get(base);
    if (c.unit && !converts(c.unit, target)) fail(`ERP column ${c.name}: no conversion from ${c.unit} to ${target} (FUNC-030)`);
    if (!c.unit && target && !member) fail(`ERP column ${c.name}: ${base} has unit ${target}, the column states none (FUNC-030)`);
    if (c.unit && member) fail(`ERP column ${c.name}: nested member ${member} carries no unit, the column states ${c.unit} (FUNC-030)`);
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
if (args.has("--require-signed")) {
  // The owner signs the manifest digest; a changed pack with a rewritten manifest is refused until signed again.
  const signaturesPath = join(dirname(ROOT), "SIGNATURES.json");
  const digest = createHash("sha256").update(readFileSync(MANIFEST)).digest("hex");
  const signed = existsSync(signaturesPath) ? JSON.parse(readFileSync(signaturesPath, "utf8"))[basename(ROOT)] : undefined;
  if (!signed) {
    console.error(`check-contracts: no signature for pack "${basename(ROOT)}" in ${signaturesPath}`);
    process.exit(1);
  }
  if (signed.manifest_sha256 !== digest) {
    console.error(`check-contracts: MANIFEST.json digest ${digest} is not the signed digest ${signed.manifest_sha256}; the owner must sign the change`);
    process.exit(1);
  }
  console.log(`Signed by ${signed.signed_by} on ${signed.date}.`);
}
if (args.has("--require-frozen") && blocking.length) {
  console.error(`check-contracts: ${blocking.length} part(s) still on HOLD`);
  process.exit(1);
}
if (blocking.length) console.log("Structure and digests OK; pack not frozen.");
else console.log(`Pack frozen; all checks passed${holds.length ? " (registry route on its standing hold)" : ""}.`);
