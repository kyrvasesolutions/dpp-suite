/**
 * Dependency gate (D8-06, threat T19): runs `npm audit --json` over ALL dependencies and compares every advisory with
 * security/accepted-risks.json. It fails on:
 *   - any advisory that is not accepted (matched by advisory id AND package),
 *   - any accepted risk whose `review_by` date has passed,
 *   - a malformed accepted-risk record or file,
 *   - a failed or unparseable `npm audit` (no network, registry error): it fails closed.
 *   - an advisory whose current severity is higher than the severity recorded when it was accepted,
 *   - an acceptance whose review_by is more than 180 days after its date (dates are real UTC calendar dates).
 * Records without an npm `advisory` (for example AR-CI-01, GitHub Actions pinning) are not matched against npm
 * advisories, but their fields and dates are still validated.
 *
 *   node scripts/check-audit.mjs [--today YYYY-MM-DD] [--risks <file>] [--audit-json <file>]
 *
 * `--audit-json` reads a saved `npm audit --json` result instead of running npm (used by tests).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The longest an acceptance may run before it must be reviewed (V4-04). */
export const MAX_REVIEW_WINDOW_DAYS = 180;
const DAY_MS = 86_400_000;
const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const REQUIRED = ["id", "package", "severity", "rationale", "accepted_by", "date", "review_by"];

function validDate(s) {
  if (typeof s !== "string" || !DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The advisory id of an npm audit `via` entry: the GHSA id from its URL, else the numeric source. */
export function advisoryId(via) {
  const m = typeof via.url === "string" ? /\/(GHSA-[a-z0-9-]+)\/?$/i.exec(via.url) : null;
  return m ? m[1] : via.source !== undefined ? String(via.source) : "unknown";
}

/** Every advisory in an `npm audit --json` (v2) document. Package-chain entries (plain strings in `via`) are effects, not advisories. */
export function collectAdvisories(audit) {
  const out = new Map();
  for (const vuln of Object.values(audit.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (via === null || typeof via !== "object") continue;
      const id = advisoryId(via);
      const key = `${id}|${via.name}`;
      if (!out.has(key)) out.set(key, { id, package: String(via.name ?? vuln.name), severity: String(via.severity ?? vuln.severity ?? "unknown"), title: String(via.title ?? ""), fixAvailable: vuln.fixAvailable ?? false });
    }
  }
  return [...out.values()];
}

/** Structural validation of the accepted-risks file. Returns a list of problems. */
export function validateRisks(file, today) {
  const errors = [];
  if (file === null || typeof file !== "object" || Array.isArray(file)) return ["accepted-risks: the file must be an object"];
  if (file.version !== 1) errors.push("accepted-risks: version must be 1");
  if (!Array.isArray(file.risks)) return [...errors, "accepted-risks: risks must be an array"];
  const seen = new Set();
  file.risks.forEach((r, i) => {
    const at = `accepted-risks[${i}]`;
    if (r === null || typeof r !== "object" || Array.isArray(r)) return errors.push(`${at}: must be an object`);
    for (const k of REQUIRED) if (typeof r[k] !== "string" || r[k].trim() === "") errors.push(`${at}: "${k}" must be a non-empty string`);
    if (r.advisory !== undefined && r.advisory !== null && (typeof r.advisory !== "string" || r.advisory.trim() === "")) errors.push(`${at}: "advisory" must be a non-empty string or null`);
    if (typeof r.severity === "string" && !SEVERITIES.includes(r.severity)) errors.push(`${at}: severity "${r.severity}" is not one of ${SEVERITIES.join(", ")}`);
    for (const k of ["date", "review_by"]) if (typeof r[k] === "string" && !validDate(r[k])) errors.push(`${at}: "${k}" must be a valid YYYY-MM-DD date`);
    // R2-04: an acceptance cannot be dated after today (a future date would stretch its review window), and the severity is one of the exact, lower-case names.
    if (typeof r.date === "string" && validDate(r.date) && typeof today === "string" && validDate(today) && r.date > today) errors.push(`${at}: date ${r.date} is later than today (${today})`);
    if (validDate(r.date) && validDate(r.review_by) && r.review_by < r.date) errors.push(`${at}: review_by is before date`);
    else if (validDate(r.date) && validDate(r.review_by) && days(r.date, r.review_by) > MAX_REVIEW_WINDOW_DAYS) errors.push(`${at}: review_by is ${days(r.date, r.review_by)} days after date; the maximum window is ${MAX_REVIEW_WINDOW_DAYS} days`);
    if (typeof r.id === "string") {
      if (seen.has(r.id)) errors.push(`${at}: duplicate id ${r.id}`);
      seen.add(r.id);
    }
  });
  return errors;
}

/**
 * The policy. `audit` is parsed `npm audit --json`, `risksFile` the parsed accepted-risks file, `today` a YYYY-MM-DD string.
 * Returns { ok, errors, unaccepted, accepted, notes }.
 */
export function evaluateAudit(audit, risksFile, today) {
  const errors = [];
  const notes = [];
  if (!validDate(today)) errors.push(`today "${today}" is not a valid YYYY-MM-DD date`);
  errors.push(...validateRisks(risksFile, today));
  if (audit === null || typeof audit !== "object") errors.push("npm audit result is not an object");
  else if (audit.error) errors.push(`npm audit failed: ${String(audit.error.code ?? "error")}: ${String(audit.error.summary ?? "").slice(0, 200)}`);
  else if (audit.auditReportVersion !== 2 || typeof audit.vulnerabilities !== "object" || audit.vulnerabilities === null) errors.push("npm audit result has an unexpected format (expected auditReportVersion 2)");
  if (errors.length) return { ok: false, errors, unaccepted: [], accepted: [], notes };

  const risks = Array.isArray(risksFile.risks) ? risksFile.risks : [];
  for (const r of risks) if (validDate(r.review_by) && r.review_by < today) errors.push(`${r.id}: acceptance expired on ${r.review_by} (today ${today}); review it or fix the advisory`);

  const unaccepted = [];
  const accepted = [];
  const matched = new Set();
  for (const adv of collectAdvisories(audit)) {
    // R2-04: a severity that is not one of the exact names (a different case, a new word) cannot be compared with an acceptance: it fails the check.
    if (!SEVERITIES.includes(adv.severity)) {
      unaccepted.push(adv);
      errors.push(`advisory ${adv.id} in ${adv.package} has the severity "${adv.severity}", which is not one of ${SEVERITIES.join(", ")} (lower case)`);
      continue;
    }
    const risk = risks.find((r) => typeof r.advisory === "string" && r.advisory.toLowerCase() === adv.id.toLowerCase() && r.package === adv.package);
    if (risk && SEVERITIES.indexOf(adv.severity) > SEVERITIES.indexOf(risk.severity)) {
      // the advisory got worse since it was accepted: the acceptance no longer covers it
      matched.add(risk.id);
      unaccepted.push(adv);
      errors.push(`${risk.id}: advisory ${adv.id} in ${adv.package} is now ${adv.severity}, above the accepted ${risk.severity}; re-review it`);
    } else if (risk) {
      matched.add(risk.id);
      accepted.push({ ...adv, risk: risk.id });
    } else unaccepted.push(adv);
  }
  for (const adv of unaccepted) if (SEVERITIES.includes(adv.severity)) errors.push(`unaccepted advisory ${adv.id} in ${adv.package} (${adv.severity}): ${adv.title} (fix available: ${JSON.stringify(adv.fixAvailable)})`);
  for (const r of risks) if (typeof r.advisory === "string" && !matched.has(r.id)) notes.push(`${r.id}: accepted advisory ${r.advisory} no longer appears in the audit; consider removing it`);
  return { ok: errors.length === 0, errors, unaccepted, accepted, notes };
}

function arg(name) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
}

function runNpmAudit() {
  const res = spawnSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`could not run npm audit: ${res.error.message}`);
  // npm audit exits 1 when it finds advisories but still prints the JSON; a missing or unparseable body is a failure.
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`npm audit gave no JSON (exit ${res.status}): ${(res.stderr || res.stdout || "").slice(0, 200)}`);
  }
}

function main() {
  const today = arg("--today") ?? new Date().toISOString().slice(0, 10);
  let audit;
  let risksFile;
  try {
    risksFile = JSON.parse(readFileSync(arg("--risks") ?? "security/accepted-risks.json", "utf8"));
  } catch (e) {
    console.error(`check-audit: cannot read accepted risks: ${e.message}`);
    process.exit(1);
  }
  try {
    audit = arg("--audit-json") ? JSON.parse(readFileSync(arg("--audit-json"), "utf8")) : runNpmAudit();
  } catch (e) {
    console.error(`check-audit: failing closed: ${e.message}`);
    process.exit(1);
  }
  const result = evaluateAudit(audit, risksFile, today);
  for (const n of result.notes) console.log(`check-audit: note: ${n}`);
  if (!result.ok) {
    for (const e of result.errors) console.error(`check-audit: ${e}`);
    process.exit(1);
  }
  console.log(`check-audit: ${result.accepted.length} accepted advisory(ies), no unaccepted advisories, no expired acceptances`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
