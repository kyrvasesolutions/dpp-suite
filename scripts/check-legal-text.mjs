// Checks the catalogue against the acts themselves. Texts come from the EU
// Publications Office, which serves the Official Journal text by CELEX number.
//
//   npm run check-legal-text
//
// 1. Every quoted passage in src/model/legislation.ts and every standard excerpt in
//    src/model/standards.ts appears word for word in the act it is quoted from.
// 2. Every standard reference found in the acts is recorded in src/model/standards.ts.
// 3. No two different standard excerpts cover overlapping text of an act, so the app
//    never shows a passage, or part of one, in two places in the Standards column.
//
// Whitespace is ignored when comparing, since the HTML splits lines and lists differently.
import { LEGISLATIONS, PROVISIONS, SOURCE_ACTS } from "../src/model/legislation.ts";
import { CITATIONS, STANDARDS } from "../src/model/standards.ts";

/** Older versions of recorded standards that REACH also names. The catalogue keeps only the latest. */
const OLDER_VERSIONS = ["EN ISO 17234-1:2010", "CEN ISO/TS 17234:2003", "EN 14362-1:2012", "EN 14362-3:2012", "CEN/TS 16516"];

/** Acts with no XHTML original get a consolidated version instead. */
const TEXT_VERSION = {
  "32006R1907": "02006R1907-20250623",
};

const celexOf = Object.fromEntries(LEGISLATIONS.map((l) => [l.id, l.celex]));

async function fetchText(celex) {
  const id = TEXT_VERSION[celex] ?? celex;
  const res = await fetch(`https://publications.europa.eu/resource/celex/${id}`, {
    headers: { Accept: "application/xhtml+xml, text/html;q=0.9", "Accept-Language": "eng" },
  });
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
  const html = await res.text();
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

const squash = (s) => s.replace(/\s+/g, "");

// An issuing body, optional co-publishers and document types, then the number.
const REFERENCE =
  /\b(?:(?:EN|ISO|IEC|DIN|CEN)(?:[ /-]+(?:EN|ISO|IEC|TS|TR|CEN))*[ -]+\d[\w.:-]*|ASTM\)? D ?\d[\w-]*|OECD(?: TG| [Gg]uideline)? \d+[A-Z]?)/g;

const normalise = (ref) =>
  ref
    .replace(/^CEN (?=EN |ISO )/, "")
    .replace(/^OECD(?: TG| [Gg]uideline)? /, "OECD ")
    .replace(/\)/g, "")
    .replace(/[.:,;-]+$/, "");

const known = new Set();
for (const ref of [...STANDARDS.map((s) => s.ref), ...CITATIONS.flatMap((c) => c.citedAs ?? []), ...OLDER_VERSIONS]) {
  known.add(normalise(ref));
  known.add(normalise(ref.split(":")[0]));
}

const quoted = new Map();
const quote = (celex, label, passage) => {
  if (!quoted.has(celex)) quoted.set(celex, []);
  quoted.get(celex).push({ label, passage });
};
for (const p of PROVISIONS) {
  const celex = p.source ?? celexOf[p.legislation];
  for (const passage of p.quotes ?? []) quote(celex, `${p.legislation} ${p.ref} [${p.dataRequirement}]`, passage);
}
for (const c of CITATIONS) {
  quote(c.source ?? celexOf[c.legislation], `${c.legislation} ${c.provision} [${c.standard}]`, c.excerpt);
}

const acts = new Set([...Object.values(celexOf), ...Object.keys(SOURCE_ACTS)]);

/** Pairs of different excerpts that cover the same characters of the act. */
function overlappingExcerpts(text, excerpts) {
  const spans = excerpts.flatMap((excerpt) => {
    const needle = squash(excerpt);
    const found = [];
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      found.push({ excerpt, start: at, end: at + needle.length });
    }
    return found;
  });
  const pairs = new Set();
  for (const a of spans) {
    for (const b of spans) {
      if (a.excerpt < b.excerpt && a.start < b.end && b.start < a.end) pairs.add(`"${a.excerpt}" / "${b.excerpt}"`);
    }
  }
  return [...pairs];
}

let checked = 0;
const missing = [];
const unrecorded = [];
const overlapping = [];
for (const celex of acts) {
  const raw = await fetchText(celex);
  const text = squash(raw);
  const passages = quoted.get(celex) ?? [];
  for (const { label, passage } of passages) {
    checked++;
    if (!text.includes(squash(passage))) missing.push(`${celex} ${label}: ${passage}`);
  }
  const refs = new Set([...raw.replace(/\s+/g, " ").matchAll(REFERENCE)].map((m) => normalise(m[0])));
  for (const ref of refs) if (!known.has(ref)) unrecorded.push(`${celex}: ${ref}`);
  const excerpts = [...new Set(CITATIONS.filter((c) => (c.source ?? celexOf[c.legislation]) === celex).map((c) => c.excerpt))];
  for (const pair of overlappingExcerpts(text, excerpts)) overlapping.push(`${celex}: ${pair}`);
  console.log(`${celex}: ${passages.length} passages, ${refs.size} standard references`);
}

if (missing.length) console.error(`\n${missing.length} of ${checked} passages not found word for word:\n${missing.join("\n")}`);
if (unrecorded.length) console.error(`\n${unrecorded.length} standard references not in src/model/standards.ts:\n${unrecorded.join("\n")}`);
if (overlapping.length) console.error(`\n${overlapping.length} pairs of standard excerpts overlap:\n${overlapping.join("\n")}`);
if (missing.length || unrecorded.length || overlapping.length) process.exit(1);
console.log(`\nAll ${checked} passages found word for word; every standard reference is recorded; no standard excerpts overlap.`);
