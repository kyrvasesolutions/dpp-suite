// Checks src/model/ontologies.ts against the published vocabularies.
//
//   npm run check-ontology-terms
//
// Every term must exist at its source and its definition must appear there word for
// word. Whitespace is ignored when comparing, since sources wrap and pad their text.
// Wikidata descriptions are community-edited, so a failure there can mean the
// description changed: read the new one and update the catalogue or the term.
import { ONTOLOGY_TERMS } from "../src/model/ontologies.ts";

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

/** A JSON-LD vocabulary: term id to its comment. */
const jsonLd = (url, prefix) => {
  let graph;
  return async (term) => {
    graph ??= new Map(
      (await (await fetchOk(url, "application/ld+json")).json())["@graph"].map((x) => [x["@id"], english(x["rdfs:comment"])]),
    );
    return graph.get(`${prefix}:${term.id.slice(term.id.indexOf(":") + 1)}`);
  };
};

let oeo;
const READERS = {
  schema: jsonLd("https://schema.org/version/latest/schemaorg-current-https.jsonld", "schema"),
  gs1: jsonLd("https://ref.gs1.org/voc/data/gs1Voc.jsonld", "gs1"),
  untp: jsonLd("https://vocabulary.uncefact.org/untp/", "untp"),
  oeo: async (term) => {
    oeo ??= await (await fetchOk("https://openenergyplatform.org/ontology/oeo/")).text();
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
  } catch (error) {
    failures.push(`${term.id}: ${error.message}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`\n${failures.length} of ${ONTOLOGY_TERMS.length} terms failed.`);
  process.exit(1);
}
console.log(`All ${ONTOLOGY_TERMS.length} ontology terms match their sources.`);
