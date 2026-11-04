// Generates db/seed/*.sql from db/source/*.json.
// Run with: npm run build-seed
//
// Each indicator under an Annex I parameter must be a verbatim fragment of
// that parameter's legal text; the script fails if one is not.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { DATA_REQUIREMENTS, LEGISLATIONS, PRODUCT_GROUPS, PROVISIONS } from "../src/model/legislation.ts";
import { ONTOLOGIES, ONTOLOGY_TERMS, REQUIREMENT_TERMS } from "../src/model/ontologies.ts";
import { CITATIONS, STANDARDS, STANDARD_LINKS, STANDARD_TARGETS } from "../src/model/standards.ts";

const annex = JSON.parse(readFileSync(new URL("../db/source/espr-annex-i.json", import.meta.url), "utf8"));

const sql = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replaceAll("'", "''")}'`);
const row = (values) => `(${values.map(sql).join(", ")})`;

// ---------- Data category: ESPR Annex I ----------

// Short display names (ours) and the indicators each parameter lists after
// "as expressed through" (verbatim from the regulation).
const CURATION = {
  "(a)": {
    name: "Durability and reliability",
    indicators: [
      "guaranteed lifetime",
      "technical lifetime",
      "mean time between failures",
      "indication of real use information on the product",
      "resistance to stresses or ageing mechanisms",
    ],
  },
  "(b)": {
    name: "Ease of repair and maintenance",
    indicators: [
      "characteristics, availability, delivery time and affordability of spare parts",
      "modularity",
      "compatibility with commonly available tools and spare parts",
      "availability of repair and maintenance instructions",
      "number of materials and components used",
      "use of standard components",
      "use of component and material coding standards for the identification of components and materials",
      "number and complexity of processes and whether specialised tools are needed",
      "ease of non-destructive disassembly and re-assembly",
      "conditions for access to product data",
      "conditions for access to or use of hardware and software needed",
    ],
  },
  "(c)": {
    name: "Ease of upgrading, reuse, remanufacturing and refurbishment",
    indicators: [
      "number of materials and components used",
      "use of standard components",
      "use of component and material coding standards for the identification of components and materials",
      "number and complexity of processes and tools needed",
      "ease of non-destructive disassembly and re-assembly",
      "conditions for access to product data",
      "conditions for access to or use of hardware and software needed",
      "conditions of access to test protocols or not commonly available testing equipment",
      "availability of guarantees specific to remanufactured or refurbished products",
      "conditions for access to or use of technologies protected by intellectual property rights",
      "modularity",
    ],
  },
  "(d)": {
    name: "Design for recycling, ease and quality of recycling",
    indicators: [
      "use of easily recyclable materials",
      "safe, easy and non-destructive access to recyclable components and materials or components and materials containing hazardous substances",
      "material composition and homogeneity",
      "possibility for high-purity sorting",
      "number of materials and components used",
      "use of standard components",
      "use of component and material coding standards for the identification of components and materials",
      "number and complexity of processes and tools needed",
      "ease of non-destructive disassembly and re-assembly",
      "conditions for access to product data",
      "conditions for access to or use of hardware and software needed",
    ],
  },
  "(e)": { name: "Avoidance of technical solutions detrimental to circularity", indicators: [] },
  "(f)": { name: "Use of substances, including substances of concern", indicators: [] },
  "(g)": { name: "Use or consumption of energy, water and other resources", indicators: [] },
  "(h)": { name: "Recycled content and recovery of materials, including critical raw materials", indicators: [] },
  "(i)": { name: "Sustainable renewable materials", indicators: [] },
  "(j)": { name: "Weight and volume of product and packaging", indicators: [] },
  "(k)": { name: "Incorporation of used components", indicators: [] },
  "(l)": {
    name: "Consumables needed for proper use and maintenance",
    indicators: ["yield", "technical lifetime", "ability to reuse, repair, and remanufacture", "mass-resource efficiency", "interoperability"],
  },
  "(m)": { name: "Environmental footprint", indicators: [] },
  "(n)": { name: "Carbon footprint", indicators: [] },
  "(o)": { name: "Material footprint", indicators: [] },
  "(p)": { name: "Microplastic and nanoplastic release", indicators: [] },
  "(q)": {
    name: "Emissions to air, water or soil",
    indicators: ["quantities and nature of emissions", "noise"],
  },
  "(r)": { name: "Waste generated, including hazardous waste", indicators: [] },
  "(s)": {
    name: "Functional performance and conditions for use",
    indicators: [
      "ability to perform its intended use",
      "precautions for use",
      "skills required",
      "compatibility with other products or systems",
    ],
  },
  "(t)": {
    name: "Lightweight design",
    indicators: [
      "reduction of material consumption",
      "load- and stress-optimisation of structures",
      "integration of functions within the material or into a single product component",
      "use of lower density or high-strength materials and hybrid materials",
    ],
  },
};

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function esprSeed() {
  const { source, parameters, intro } = annex;
  const treeId = "espr-annex-i";
  const rootId = "root";
  const nodes = [[treeId, rootId, null, 0, "ESPR Annex I", null, intro, source.id, "Annex I"]];

  parameters.forEach(([label, text], i) => {
    const letter = label.replace(/[()]/g, "");
    const curated = CURATION[label];
    if (!curated) throw new Error(`No curation for ${label}`);
    const id = `espr-${letter}`;
    const ref = `Annex I${label}`;
    nodes.push([treeId, id, rootId, i, curated.name, ref, text, source.id, ref]);
    curated.indicators.forEach((indicator, j) => {
      if (!text.includes(indicator)) throw new Error(`${label}: "${indicator}" is not in the legal text`);
      nodes.push([treeId, `${id}-${j + 1}`, id, j, capitalise(indicator), null, null, source.id, ref]);
    });
  });

  for (const label of Object.keys(CURATION)) {
    if (!parameters.some(([l]) => l === label)) throw new Error(`Curation for unknown parameter ${label}`);
  }

  return [
    `-- ESPR Annex I product parameters as the "Data category" tree.`,
    `-- Generated by scripts/build-seed.mjs from db/source/espr-annex-i.json. Do not edit by hand.`,
    `INSERT INTO source (id, title, celex, url, section, retrieved) VALUES`,
    `  ${row([source.id, source.title, source.celex, source.url, source.section, source.retrieved])};`,
    ``,
    `INSERT INTO tree (id, side, title, subtitle, root_id) VALUES`,
    `  ${row([treeId, "right", "Data category", "ESPR (EU) 2024/1781, Annex I product parameters", rootId])};`,
    ``,
    `INSERT INTO node (tree_id, id, parent_id, position, name, meta, description, source_id, source_ref) VALUES`,
    nodes.map((n) => `  ${row(n)}`).join(",\n") + ";",
    ``,
  ].join("\n");
}

// ---------- Sample product structure ----------

const PRODUCT = [
  ["root", null, "root"],
  ["pack", "root", "Battery pack BP-48V", "PN 48-1100"],
  ["module", "pack", "Cell module", "PN 48-2010"],
  ["cells", "module", "Li-ion cells 21700", "52 pcs"],
  ["cathode", "cells", "NMC 811 cathode", "Supplier A"],
  ["anode", "cells", "Graphite anode", "Supplier B"],
  ["electrolyte", "cells", "LiPF6 electrolyte", "Supplier C"],
  ["separator", "cells", "PE separator film"],
  ["busbar", "module", "Nickel-plated copper busbar"],
  ["bms", "pack", "Battery management system", "PN 48-3100"],
  ["pcb", "bms", "PCB assembly"],
  ["firmware", "bms", "BMS firmware", "v3.2"],
  ["housing", "pack", "Housing", "PN 48-4000"],
  ["case", "housing", "Aluminium case", "6061-T6"],
  ["gasket", "housing", "EPDM gasket"],
  ["screws", "housing", "Torx screws M4", "24 pcs"],
  ["docs", "root", "Supplier documents"],
  ["coa", "docs", "Cobalt origin certificate", "PDF"],
  ["lca", "docs", "Life-cycle assessment report", "PDF"],
  ["un383", "docs", "UN 38.3 test report", "PDF"],
  ["manual", "docs", "Service manual", "PDF"],
];

function productSeed() {
  const position = {};
  const nodes = PRODUCT.map(([id, parent, name, meta]) => {
    const p = parent ? (position[parent] = (position[parent] ?? -1) + 1) : 0;
    return ["product", id, parent, p, name, meta ?? null, null, null, null];
  });
  return [
    `-- Sample product structure (replace with real data via Upload).`,
    `-- Generated by scripts/build-seed.mjs. Do not edit by hand.`,
    `INSERT INTO tree (id, side, title, subtitle, root_id) VALUES`,
    `  ${row(["product", "left", "Product structure", "E-bike battery pack BP-48V (sample)", "root"])};`,
    ``,
    `INSERT INTO node (tree_id, id, parent_id, position, name, meta, description, source_id, source_ref) VALUES`,
    nodes.map((n) => `  ${row(n)}`).join(",\n") + ";",
    ``,
  ].join("\n");
}

// ---------- Sample mappings ----------

const MAPPINGS = [
  ["cathode", "espr-f"],
  ["electrolyte", "espr-f"],
  ["cathode", "espr-h"],
  ["coa", "espr-h"],
  ["lca", "espr-m"],
  ["lca", "espr-n"],
  ["manual", "espr-b-4"],
  ["firmware", "espr-b-11"],
  ["screws", "espr-b-6"],
  ["un383", "espr-s-2"],
];

function mappingSeed() {
  return [
    `-- Sample mappings from the product structure to ESPR Annex I data categories.`,
    `-- Generated by scripts/build-seed.mjs. Do not edit by hand.`,
    `INSERT INTO mapping (id, from_tree, from_id, to_tree, to_id) VALUES`,
    MAPPINGS.map(([from, to], i) => `  ${row([`m${i + 1}`, "product", from, "espr-annex-i", to])}`).join(",\n") + ";",
    ``,
  ].join("\n");
}

// ---------- Regulatory chain: legislation, standards, data requirements ----------

const insert = (table, columns, rows) =>
  rows.length
    ? [`INSERT INTO ${table} (${columns.join(", ")}) VALUES`, rows.map((r) => `  ${row(r)}`).join(",\n") + ";", ``]
    : [];

function chainSeed() {
  const celexOf = Object.fromEntries(LEGISLATIONS.map((l) => [l.id, l.celex]));

  const pairs = new Set(CITATIONS.map((c) => `${c.legislation}|${c.standard}`));
  const withProvision = new Set(PROVISIONS.map((p) => `${p.legislation}|${p.dataRequirement}`));
  for (const l of STANDARD_LINKS) {
    const name = `${l.legislation} / ${l.standard} / ${l.dataRequirement}`;
    if (!pairs.has(`${l.legislation}|${l.standard}`)) throw new Error(`Link without a citation: ${name}`);
    if (!withProvision.has(`${l.legislation}|${l.dataRequirement}`)) throw new Error(`Link without a provision: ${name}`);
    for (const provision of l.provisions ?? []) {
      if (!CITATIONS.some((c) => c.legislation === l.legislation && c.standard === l.standard && c.provision === provision)) {
        throw new Error(`Link rests on a citation that does not exist: ${name}, ${provision}`);
      }
    }
  }
  const cited = new Set(CITATIONS.map((c) => c.standard));
  const targeted = new Set(STANDARD_TARGETS.map((t) => t.standard));
  for (const s of STANDARDS) {
    if (!cited.has(s.id) && !targeted.has(s.id)) throw new Error(`Standard neither cited nor targeting anything: ${s.id}`);
  }
  for (const t of STANDARD_TARGETS) {
    const name = `${t.standard} / ${t.dataRequirement}`;
    if (!STANDARDS.some((s) => s.id === t.standard)) throw new Error(`Target for an unknown standard: ${name}`);
    if (cited.has(t.standard)) throw new Error(`An act names this standard, so link it instead: ${name}`);
    for (const group of t.groups) {
      if (!PROVISIONS.some((p) => p.dataRequirement === t.dataRequirement && p.groups.includes(group))) {
        throw new Error(`No ${group} provision sets this data requirement: ${name}`);
      }
    }
  }

  // Only the latest version of a standard is kept: its number and part must be unique.
  const versions = new Map();
  for (const s of STANDARDS.filter((s) => s.kind === "technical")) {
    const number = s.ref.replace(/:\d{4}$/, "").replace(/^(?:[A-Z]+[/ ])+/, "");
    if (versions.has(number)) throw new Error(`Two versions of one standard: ${versions.get(number)} / ${s.ref}`);
    versions.set(number, s.ref);
  }

  return [
    `-- Legislation -> data requirements -> standards. Ontology terms are in 05-ontology-terms.sql; data points have no rows yet.`,
    `-- Generated by scripts/build-seed.mjs from src/model/legislation.ts and standards.ts. Do not edit by hand.`,
    ...insert(
      "product_group",
      ["id", "name", "description", "position"],
      PRODUCT_GROUPS.map((g, i) => [g.id, g.name, g.description, i]),
    ),
    ...insert(
      "legislation",
      ["id", "short", "title", "ref", "celex", "category", "standards_note", "position"],
      LEGISLATIONS.map((l, i) => [l.id, l.short, l.title, l.ref, l.celex, l.category, l.standardsNote, i]),
    ),
    ...insert(
      "legislation_scope",
      ["legislation_id", "product_group_id", "note"],
      LEGISLATIONS.flatMap((l) => Object.entries(l.scope).map(([group, note]) => [l.id, group, note])),
    ),
    ...insert(
      "standard",
      ["id", "ref", "title", "body", "kind", "position"],
      STANDARDS.map((s, i) => [s.id, s.ref, s.title, s.body, s.kind, i]),
    ),
    ...insert(
      "legislation_standard",
      ["legislation_id", "standard_id"],
      [...pairs].map((p) => p.split("|")),
    ),
    ...insert(
      "standard_citation",
      ["legislation_id", "standard_id", "provision", "force", "excerpt", "cited_as", "source_celex", "position"],
      CITATIONS.map((c, i) => [c.legislation, c.standard, c.provision, c.force, c.excerpt, c.citedAs, c.source ?? celexOf[c.legislation], i]),
    ),
    ...insert(
      "data_requirement",
      ["id", "name", "theme", "position"],
      DATA_REQUIREMENTS.map((d, i) => [d.id, d.name, d.theme, i]),
    ),
    ...insert(
      "standard_requirement",
      ["legislation_id", "standard_id", "data_requirement_id", "basis", "note", "provisions"],
      STANDARD_LINKS.map((l) => [l.legislation, l.standard, l.dataRequirement, l.basis, l.note, l.provisions ? JSON.stringify(l.provisions) : null]),
    ),
    ...insert(
      "standard_target",
      ["standard_id", "data_requirement_id", "product_group_id", "note", "source_url"],
      STANDARD_TARGETS.flatMap((t) => t.groups.map((g) => [t.standard, t.dataRequirement, g, t.note, t.source])),
    ),
    ...insert(
      "requirement_provision",
      ["id", "data_requirement_id", "legislation_id", "ref", "text", "quotes", "source_celex"],
      PROVISIONS.map((p, i) => [i + 1, p.dataRequirement, p.legislation, p.ref, p.text, p.quotes ? JSON.stringify(p.quotes) : null, p.source]),
    ),
    ...insert(
      "provision_group",
      ["provision_id", "product_group_id"],
      PROVISIONS.flatMap((p, i) => p.groups.map((g) => [i + 1, g])),
    ),
  ].join("\n");
}

// ---------- Ontology terms that define the data requirements ----------

function ontologySeed() {
  const terms = new Set(ONTOLOGY_TERMS.map((t) => t.id));
  const ontologies = new Set(ONTOLOGIES.map((o) => o.id));
  const requirements = new Set(DATA_REQUIREMENTS.map((d) => d.id));
  for (const t of ONTOLOGY_TERMS) {
    if (!ontologies.has(t.ontology)) throw new Error(`Term of an unknown ontology: ${t.id}`);
  }
  for (const l of REQUIREMENT_TERMS) {
    const name = `${l.dataRequirement} / ${l.term}`;
    if (!requirements.has(l.dataRequirement)) throw new Error(`Term for an unknown data requirement: ${name}`);
    if (!terms.has(l.term)) throw new Error(`Link to an unknown term: ${name}`);
    if (l.match !== "exact" && !l.note) throw new Error(`Say how the term differs from the data requirement: ${name}`);
  }
  const defined = new Set(REQUIREMENT_TERMS.map((l) => l.dataRequirement));
  for (const d of DATA_REQUIREMENTS) {
    if (!defined.has(d.id)) throw new Error(`Data requirement without an ontology term: ${d.id}`);
  }
  const used = new Set(REQUIREMENT_TERMS.map((l) => l.term));
  for (const id of terms) {
    if (!used.has(id)) throw new Error(`Term defines no data requirement: ${id}`);
  }

  return [
    `-- Open vocabulary terms that define the data requirements.`,
    `-- Generated by scripts/build-seed.mjs from src/model/ontologies.ts. Do not edit by hand.`,
    ...insert(
      "ontology",
      ["id", "name", "uri", "description", "position", "license", "license_url", "retrieved"],
      ONTOLOGIES.map((o, i) => [o.id, o.name, o.uri, o.description, i, o.license, o.licenseUrl, o.retrieved]),
    ),
    ...insert(
      "ontology_term",
      ["id", "ontology_id", "label", "uri", "definition", "position"],
      ONTOLOGY_TERMS.map((t, i) => [t.id, t.ontology, t.label, t.uri, t.definition, i]),
    ),
    ...insert(
      "data_requirement_term",
      ["data_requirement_id", "term_id", "match", "note"],
      REQUIREMENT_TERMS.map((l) => [l.dataRequirement, l.term, l.match, l.note]),
    ),
  ].join("\n");
}

const out = new URL("../db/seed/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("01-product-sample.sql", out), productSeed());
writeFileSync(new URL("02-espr-annex-i.sql", out), esprSeed());
writeFileSync(new URL("03-mappings-sample.sql", out), mappingSeed());
writeFileSync(new URL("04-regulatory-chain.sql", out), chainSeed());
writeFileSync(new URL("05-ontology-terms.sql", out), ontologySeed());
console.log("Wrote db/seed/01-product-sample.sql, 02-espr-annex-i.sql, 03-mappings-sample.sql, 04-regulatory-chain.sql, 05-ontology-terms.sql");
