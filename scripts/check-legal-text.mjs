// Checks that every quoted passage in src/model/legislation.ts appears word for
// word in the act it is quoted from. Texts come from the EU Publications Office,
// which serves the Official Journal text by CELEX number.
//
//   npm run check-legal-text
//
// Whitespace is ignored when comparing, since the HTML splits lines and lists differently.
import { LEGISLATIONS, REQUIREMENTS } from "../src/model/legislation.ts";

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

const byAct = new Map();
for (const r of REQUIREMENTS) {
  if (!r.quotes) continue;
  const celex = r.source ?? celexOf[r.legislation];
  if (!byAct.has(celex)) byAct.set(celex, []);
  byAct.get(celex).push(r);
}

let checked = 0;
const missing = [];
for (const [celex, reqs] of byAct) {
  const text = squash(await fetchText(celex));
  for (const r of reqs) {
    for (const quote of r.quotes) {
      checked++;
      if (!text.includes(squash(quote))) missing.push(`${celex} ${r.legislation} ${r.ref} [${r.dataPoint}]: ${quote}`);
    }
  }
  console.log(`${celex}: ${reqs.length} requirements`);
}

if (missing.length) {
  console.error(`\n${missing.length} of ${checked} quotes not found word for word:\n${missing.join("\n")}`);
  process.exit(1);
}
console.log(`\nAll ${checked} quotes found word for word.`);
