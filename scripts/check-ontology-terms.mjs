// Checks src/model/ontologies.ts against the published vocabularies.
//
//   npm run check-ontology-terms
//
// Every term must exist at its source and its definition must appear there word for
// word. Whitespace is ignored when comparing, since sources wrap and pad their text.
// Wikidata descriptions are community-edited, so a failure there can mean the
// description changed: read the new one and update the catalogue or the term.
//
// Value types are checked where the source publishes them in a file small enough to
// read: each JSON-LD term's kind and range, and the literal types of that vocabulary
// and of the Open Energy Ontology. NCIt's OWL file is over 800 MB, so it is not read.
import { ONTOLOGIES, ONTOLOGY_TERMS } from "../src/model/ontologies.ts";

const USER_AGENT = "dpp-validator-check-ontology-terms/0.1";

const fetchOk = async (url, accept) => {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...(accept && { Accept: accept }) } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
};

const english = (value) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(english).join(" ");
  return value?.["@value"] ?? "";
};

const sourceUrl = (id) => ONTOLOGIES.find((o) => o.id === id).sourceUrl;

const graphs = {};
/** A JSON-LD vocabulary's nodes. */
const graphOf = (id) => (graphs[id] ??= fetchOk(sourceUrl(id), "application/ld+json").then(async (res) => (await res.json())["@graph"]));

const nodeOf = async (term) => (await graphOf(term.ontology)).find((x) => x["@id"] === term.id);

const idsOf = (value) => (value === undefined ? [] : [value].flat().map((x) => x["@id"]));

const rangesOf = (node) => [...idsOf(node["rdfs:range"]), ...idsOf(node["schema:rangeIncludes"])];

/** Schema.org's own data types, which it names in ranges beside its classes. */
const SCHEMA_LITERALS = new Set(
  ["Text", "URL", "Number", "Integer", "Float", "Boolean", "Date", "DateTime", "Time", "CssSelectorType", "XPathType", "PronounceableText"].map(
    (t) => `schema:${t}`,
  ),
);
const isLiteral = (range) => /^(xsd|rdf):/.test(range) || SCHEMA_LITERALS.has(range);

/** The kind we record for a JSON-LD node: anything not a property or class is a value in a code list. */
const kindOf = (node) => {
  const types = [node["@type"]].flat();
  if (types.includes("rdf:Property")) return "property";
  return types.includes("rdfs:Class") ? "class" : "code";
};

const sameSet = (a, b) => [...a].sort().join() === [...b].sort().join();

let oeo;
const oeoFile = async () => (oeo ??= await (await fetchOk(sourceUrl("oeo"))).text());

const jsonLdReader = async (term) => {
  const node = await nodeOf(term);
  return node && english(node["rdfs:comment"]);
};

const READERS = {
  schema: jsonLdReader,
  gs1: jsonLdReader,
  untp: jsonLdReader,
  oeo: async (term) => {
    await oeoFile();
    const start = oeo.indexOf(`rdf:about="${term.uri}"`);
    if (start < 0) return undefined;
    return oeo.slice(start, oeo.indexOf("</owl:Class>", start));
  },
  ncit: async (term) => {
    const url = `https://www.ebi.ac.uk/ols4/api/ontologies/ncit/terms?iri=${encodeURIComponent(term.uri)}`;
    return (await (await fetchOk(url)).json())._embedded?.terms?.[0]?.description?.join(" ");
  },
  gemet: async (term) => {
    const url = `https://www.eionet.europa.eu/gemet/getConcept?concept_uri=${encodeURIComponent(term.uri)}&language=en`;
    return (await (await fetchOk(url)).json()).definition?.string;
  },
  wikidata: async (term) => {
    const id = term.uri.split("/").pop();
    const data = await (await fetchOk(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`)).json();
    return data.entities[id]?.descriptions?.en?.value;
  },
};

const squash = (s) =>
  s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, "");

const failures = [];
for (const term of ONTOLOGY_TERMS) {
  try {
    const published = await READERS[term.ontology](term);
    if (published === undefined) failures.push(`${term.id}: not found at the source`);
    else if (!squash(published).includes(squash(term.definition))) {
      failures.push(`${term.id}: definition differs from the source:\n  ours:   ${term.definition}\n  theirs: ${published.slice(0, 400)}`);
    }
    if (["schema", "gs1", "untp"].includes(term.ontology) && published !== undefined) {
      const node = await nodeOf(term);
      if (kindOf(node) !== term.kind) failures.push(`${term.id}: kind is ${kindOf(node)} at the source, ${term.kind} here`);
      const ranges = rangesOf(node);
      if (!sameSet(ranges, term.valueType?.split(" | ") ?? [])) {
        failures.push(`${term.id}: value type is ${ranges.join(" | ") || "absent"} at the source, ${term.valueType ?? "absent"} here`);
      }
    }
  } catch (error) {
    failures.push(`${term.id}: ${error.message}`);
  }
}

const compareTypes = (id, published) => {
  const ours = ONTOLOGIES.find((o) => o.id === id).valueTypes;
  if (!sameSet(ours, new Set(published))) {
    failures.push(`${id}: literal types differ from the source:\n  ours:   ${ours.join(", ")}\n  theirs: ${[...new Set(published)].join(", ")}`);
  }
};

for (const id of ["schema", "gs1", "untp"]) {
  try {
    compareTypes(id, (await graphOf(id)).flatMap(rangesOf).filter(isLiteral));
  } catch (error) {
    failures.push(`${id}: ${error.message}`);
  }
}

try {
  const file = await oeoFile();
  const prefixed = (m) => m[1].replace("http://www.w3.org/2001/XMLSchema#", "xsd:").replace("http://www.w3.org/2000/01/rdf-schema#", "rdfs:");
  compareTypes("oeo", [
    ...[...file.matchAll(/<rdfs:range rdf:resource="(http:\/\/www\.w3\.org\/(?:2001\/XMLSchema|2000\/01\/rdf-schema)#[^"]+)"/g)].map(prefixed),
    ...[...file.matchAll(/<owl:onDatatype rdf:resource="(http:\/\/www\.w3\.org\/2001\/XMLSchema#[^"]+)"/g)].map(prefixed),
  ]);
} catch (error) {
  failures.push(`oeo: ${error.message}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`\n${failures.length} of ${ONTOLOGY_TERMS.length} terms failed.`);
  process.exit(1);
}
console.log(`All ${ONTOLOGY_TERMS.length} ontology terms match their sources.`);
