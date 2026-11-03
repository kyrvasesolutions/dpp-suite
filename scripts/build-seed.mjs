// Generates db/seed/*.sql from db/source/*.json.
// Run with: npm run build-seed
//
// Each indicator under an Annex I parameter must be a verbatim fragment of
// that parameter's legal text; the script fails if one is not.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

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

const out = new URL("../db/seed/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("01-product-sample.sql", out), productSeed());
writeFileSync(new URL("02-espr-annex-i.sql", out), esprSeed());
writeFileSync(new URL("03-mappings-sample.sql", out), mappingSeed());
console.log("Wrote db/seed/01-product-sample.sql, 02-espr-annex-i.sql, 03-mappings-sample.sql");
