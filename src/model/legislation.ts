/**
 * EU legislation that asks for product data on aluminium and textile products,
 * and the data points each one requires.
 *
 * Every requirement belongs to one generic data point, so when several
 * legislations ask for the same kind of data (e.g. ESPR's carbon footprint and
 * CBAM's embedded emissions) they show up as one row with both behind it.
 * Texts are short summaries for orientation, not legal text; follow `url` for
 * the act itself.
 */

export type ProductGroup = "aluminium" | "textile";

export const PRODUCT_GROUPS: Array<{ id: ProductGroup; name: string; description: string }> = [
  {
    id: "aluminium",
    name: "Aluminum",
    description: "Unwrought aluminium, semi-finished and finished products, construction profiles and packaging",
  },
  {
    id: "textile",
    name: "Textile",
    description: "Apparel, accessories, footwear and home textiles",
  },
];

export type LegislationCategory = "product" | "climate" | "chemicals" | "consumer" | "waste" | "dueDiligence";

export const CATEGORIES: Array<{ id: LegislationCategory; name: string }> = [
  { id: "product", name: "Product sustainability & passports" },
  { id: "climate", name: "Climate & trade" },
  { id: "chemicals", name: "Chemicals" },
  { id: "consumer", name: "Labelling & consumer safety" },
  { id: "waste", name: "Waste & producer responsibility" },
  { id: "dueDiligence", name: "Supply-chain due diligence" },
];

export interface Legislation {
  id: string;
  short: string;
  title: string;
  ref: string;
  url: string;
  category: LegislationCategory;
  /** Why and from when it applies, per product group it covers. */
  scope: Partial<Record<ProductGroup, string>>;
}

const eurLex = (celex: string) => `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${celex}`;

export const LEGISLATIONS: Legislation[] = [
  {
    id: "espr",
    short: "ESPR",
    title: "Ecodesign for Sustainable Products Regulation",
    ref: "Regulation (EU) 2024/1781",
    url: eurLex("32024R1781"),
    category: "product",
    scope: {
      aluminium:
        "Aluminium is a priority intermediate product in the 2025–2030 working plan; delegated act with DPP expected around 2027.",
      textile:
        "Textiles (apparel) are a priority group; delegated act expected around 2027. Ban on destroying unsold apparel and footwear from 19 July 2026.",
    },
  },
  {
    id: "cpr",
    short: "CPR",
    title: "Construction Products Regulation",
    ref: "Regulation (EU) 2024/3110",
    url: eurLex("32024R3110"),
    category: "product",
    scope: {
      aluminium:
        "Aluminium construction products (profiles, windows, curtain walling, cladding). Applies from 8 January 2026, product family by product family.",
    },
  },
  {
    id: "ppwr",
    short: "PPWR",
    title: "Packaging and Packaging Waste Regulation",
    ref: "Regulation (EU) 2025/40",
    url: eurLex("32025R0040"),
    category: "product",
    scope: {
      aluminium: "Aluminium packaging (cans, foil, trays, tubes, aerosols). Applies from 12 August 2026.",
    },
  },
  {
    id: "cbam",
    short: "CBAM",
    title: "Carbon Border Adjustment Mechanism",
    ref: "Regulation (EU) 2023/956",
    url: eurLex("32023R0956"),
    category: "climate",
    scope: {
      aluminium:
        "Unwrought aluminium and aluminium products (CN 7601, 7603–7616) imported into the EU. Definitive period since 1 January 2026.",
    },
  },
  {
    id: "reach",
    short: "REACH",
    title: "Registration, Evaluation, Authorisation and Restriction of Chemicals",
    ref: "Regulation (EC) No 1907/2006",
    url: eurLex("32006R1907"),
    category: "chemicals",
    scope: {
      aluminium: "Substances of very high concern in articles; Annex XVII restrictions that apply to metal articles.",
      textile: "Substances of very high concern in articles; textile-specific restrictions in Annex XVII.",
    },
  },
  {
    id: "bpr",
    short: "BPR",
    title: "Biocidal Products Regulation",
    ref: "Regulation (EU) No 528/2012",
    url: eurLex("32012R0528"),
    category: "chemicals",
    scope: {
      textile: "Treated articles, e.g. antibacterial, anti-odour or anti-mould textiles.",
    },
  },
  {
    id: "tlr",
    short: "TLR",
    title: "Textile Labelling Regulation",
    ref: "Regulation (EU) No 1007/2011",
    url: eurLex("32011R1007"),
    category: "consumer",
    scope: {
      textile: "All textile products made available on the EU market.",
    },
  },
  {
    id: "gpsr",
    short: "GPSR",
    title: "General Product Safety Regulation",
    ref: "Regulation (EU) 2023/988",
    url: eurLex("32023R0988"),
    category: "consumer",
    scope: {
      textile: "Consumer textile products. Applies since 13 December 2024.",
    },
  },
  {
    id: "wfd",
    short: "WFD",
    title: "Waste Framework Directive",
    ref: "Directive 2008/98/EC, as amended by Directive (EU) 2025/1892",
    url: eurLex("32025L1892"),
    category: "waste",
    scope: {
      aluminium: "SCIP notification of articles containing substances of very high concern.",
      textile:
        "SCIP notification, plus extended producer responsibility for textiles and footwear: schemes operational by April 2028.",
    },
  },
  {
    id: "flr",
    short: "FLR",
    title: "Forced Labour Regulation",
    ref: "Regulation (EU) 2024/3015",
    url: eurLex("32024R3015"),
    category: "dueDiligence",
    scope: {
      aluminium: "Ban on products made with forced labour, e.g. in bauxite mining or smelting. Applies from 14 December 2027.",
      textile: "Ban on products made with forced labour, e.g. in cotton farming or garment making. Applies from 14 December 2027.",
    },
  },
];

export type Theme = "identification" | "composition" | "footprint" | "circularity" | "supplyChain" | "compliance";

export const THEMES: Array<{ id: Theme; name: string }> = [
  { id: "identification", name: "Identification & operators" },
  { id: "composition", name: "Composition & substances" },
  { id: "footprint", name: "Environmental footprint" },
  { id: "circularity", name: "Circularity & end of life" },
  { id: "supplyChain", name: "Supply chain & origin" },
  { id: "compliance", name: "Compliance & information" },
];

export interface DataPoint {
  id: string;
  name: string;
  theme: Theme;
}

export const DATA_POINTS: DataPoint[] = [
  { id: "product-id", name: "Unique product identifier", theme: "identification" },
  { id: "commodity-code", name: "Customs commodity code", theme: "identification" },
  { id: "manufacturer", name: "Manufacturer name & contact", theme: "identification" },
  { id: "importer", name: "Importer & EU responsible operator", theme: "identification" },
  { id: "producer-registration", name: "Producer registration number", theme: "identification" },

  { id: "material-composition", name: "Material / fibre composition", theme: "composition" },
  { id: "animal-origin", name: "Non-textile parts of animal origin", theme: "composition" },
  { id: "substances-of-concern", name: "Substances of concern", theme: "composition" },
  { id: "restricted-substances", name: "Restricted substances compliance", theme: "composition" },
  { id: "biocidal-treatment", name: "Biocidal treatment & active substances", theme: "composition" },

  { id: "carbon-footprint", name: "Carbon footprint / embedded emissions", theme: "footprint" },
  { id: "environmental-footprint", name: "Environmental footprint (multi-indicator)", theme: "footprint" },
  { id: "process-emissions", name: "Production route & process emissions", theme: "footprint" },
  { id: "energy-resources", name: "Energy & resource use", theme: "footprint" },
  { id: "precursors", name: "Precursors & their embedded emissions", theme: "footprint" },
  { id: "carbon-price", name: "Carbon price paid in country of origin", theme: "footprint" },
  { id: "microplastics", name: "Microplastic release", theme: "footprint" },

  { id: "recycled-content", name: "Recycled content", theme: "circularity" },
  { id: "durability", name: "Durability", theme: "circularity" },
  { id: "repairability", name: "Repairability", theme: "circularity" },
  { id: "recyclability", name: "Recyclability", theme: "circularity" },
  { id: "end-of-life-info", name: "End-of-life & sorting information", theme: "circularity" },
  { id: "quantities", name: "Quantities placed on the market", theme: "circularity" },
  { id: "unsold-products", name: "Unsold products discarded", theme: "circularity" },

  { id: "production-site", name: "Country of origin & production site", theme: "supplyChain" },
  { id: "supply-chain-operators", name: "Supply-chain operators", theme: "supplyChain" },
  { id: "forced-labour", name: "Forced-labour risk & due diligence", theme: "supplyChain" },

  { id: "conformity", name: "Declaration of conformity / performance", theme: "compliance" },
  { id: "verification", name: "Third-party verification", theme: "compliance" },
  { id: "performance", name: "Technical & functional performance", theme: "compliance" },
  { id: "dpp", name: "Digital product passport & data carrier", theme: "compliance" },
  { id: "instructions", name: "Instructions & safety information", theme: "compliance" },
  { id: "label", name: "On-product label & marking", theme: "compliance" },
];

export interface Requirement {
  dataPoint: string;
  legislation: string;
  groups: ProductGroup[];
  /** Article, annex or chapter of the act. */
  ref: string;
  text: string;
}

const AL: ProductGroup[] = ["aluminium"];
const TX: ProductGroup[] = ["textile"];
const BOTH: ProductGroup[] = ["aluminium", "textile"];

export const REQUIREMENTS: Requirement[] = [
  // ---------- Identification & operators ----------
  {
    dataPoint: "product-id",
    legislation: "espr",
    groups: BOTH,
    ref: "Arts. 9–10, Annex III(b)",
    text: "Unique product identifier, linked to the digital product passport through a data carrier on the product, its packaging or documentation.",
  },
  {
    dataPoint: "product-id",
    legislation: "cpr",
    groups: AL,
    ref: "Arts. 15–16",
    text: "Unique identification of the product type in the declaration of performance and conformity, and type, batch or serial number on the product.",
  },
  {
    dataPoint: "product-id",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 15",
    text: "Packaging bears a type, batch or serial number, or another element allowing its identification.",
  },
  {
    dataPoint: "product-id",
    legislation: "gpsr",
    groups: TX,
    ref: "Art. 9(5)",
    text: "Type, batch or serial number or another identifying element on the product, or on its packaging or accompanying document where the product is too small.",
  },
  {
    dataPoint: "commodity-code",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex III(d)",
    text: "Relevant commodity code of the product, such as its TARIC code.",
  },
  {
    dataPoint: "commodity-code",
    legislation: "cbam",
    groups: AL,
    ref: "Art. 6, Annex I",
    text: "Eight-digit CN code of each type of good imported (CN 7601, 7603–7616), declared in the annual CBAM declaration.",
  },
  {
    dataPoint: "manufacturer",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex III(g)",
    text: "Information on the manufacturer, including its unique operator identifier.",
  },
  {
    dataPoint: "manufacturer",
    legislation: "cpr",
    groups: AL,
    ref: "Arts. 15–16",
    text: "Name and contact address of the manufacturer in the declaration of performance and conformity and on the product.",
  },
  {
    dataPoint: "manufacturer",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 15",
    text: "Name, registered trade name or trade mark, and postal and electronic address of the manufacturer on the packaging.",
  },
  {
    dataPoint: "manufacturer",
    legislation: "gpsr",
    groups: TX,
    ref: "Art. 9(6)",
    text: "Name, registered trade name or trade mark, and postal and electronic address of the manufacturer on the product or its packaging.",
  },
  {
    dataPoint: "importer",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex III(j)–(k)",
    text: "Importer information including its EORI number, and the name, contact details and identifier of the EU-established economic operator responsible for the product.",
  },
  {
    dataPoint: "importer",
    legislation: "cbam",
    groups: AL,
    ref: "Arts. 4–5, 17",
    text: "Only an authorised CBAM declarant may import CBAM goods; its CBAM account number identifies the declarant in the declaration.",
  },
  {
    dataPoint: "importer",
    legislation: "cpr",
    groups: AL,
    ref: "Importer obligations",
    text: "Name and contact address of the importer on the product, or where not possible on its packaging or accompanying documents.",
  },
  {
    dataPoint: "importer",
    legislation: "gpsr",
    groups: TX,
    ref: "Art. 11; Art. 4 of Reg. (EU) 2019/1020",
    text: "Name and contact details of the importer on the product, and an EU-established responsible economic operator identified on the product.",
  },
  {
    dataPoint: "producer-registration",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 44",
    text: "Producers of packaging register in the producer register of each Member State where they first make packaging available.",
  },
  {
    dataPoint: "producer-registration",
    legislation: "wfd",
    groups: TX,
    ref: "Art. 22b (textile EPR)",
    text: "Producers of textile, textile-related and footwear products register in each Member State where they make them available, and show the registration number to buyers.",
  },

  // ---------- Composition & substances ----------
  {
    dataPoint: "material-composition",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex I(d)",
    text: "Material composition and homogeneity, so the product can be sorted and recycled at high purity.",
  },
  {
    dataPoint: "material-composition",
    legislation: "cbam",
    groups: AL,
    ref: "Implementing rules, aluminium parameters",
    text: "Alloy content: total share of elements other than aluminium where it exceeds 1 %.",
  },
  {
    dataPoint: "material-composition",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 12",
    text: "Label with pictograms giving the material composition of the packaging, to help consumers sort it.",
  },
  {
    dataPoint: "material-composition",
    legislation: "tlr",
    groups: TX,
    ref: "Arts. 5, 9, 11",
    text: "Fibre composition by percentage of weight using only the fibre names in Annex I; multi-fibre and multi-component products declared per component.",
  },
  {
    dataPoint: "animal-origin",
    legislation: "tlr",
    groups: TX,
    ref: "Art. 12",
    text: "Products containing non-textile parts of animal origin (e.g. leather, fur) state “Contains non-textile parts of animal origin”.",
  },
  {
    dataPoint: "substances-of-concern",
    legislation: "espr",
    groups: BOTH,
    ref: "Art. 7(5)",
    text: "Substances of concern tracked through the life cycle: name and identifiers (CAS/EC), location in the product, concentration, and safe-use and disassembly information.",
  },
  {
    dataPoint: "substances-of-concern",
    legislation: "reach",
    groups: BOTH,
    ref: "Arts. 7(2), 33",
    text: "Articles with Candidate List substances above 0.1 % w/w: inform recipients (and consumers on request, within 45 days) at least of the substance name; notify ECHA above 1 t/year.",
  },
  {
    dataPoint: "substances-of-concern",
    legislation: "wfd",
    groups: BOTH,
    ref: "Art. 9(1)(i)",
    text: "Notify articles containing Candidate List substances above 0.1 % w/w to ECHA's SCIP database.",
  },
  {
    dataPoint: "substances-of-concern",
    legislation: "cpr",
    groups: AL,
    ref: "Arts. 15–16",
    text: "Information on hazardous substances contained in the product supplied with the declaration of performance and conformity.",
  },
  {
    dataPoint: "restricted-substances",
    legislation: "reach",
    groups: AL,
    ref: "Annex XVII",
    text: "Compliance with restrictions that apply to the article, e.g. lead in consumer articles (entry 63) or nickel release from skin-contact parts (entry 27).",
  },
  {
    dataPoint: "restricted-substances",
    legislation: "reach",
    groups: TX,
    ref: "Annex XVII",
    text: "Compliance with textile restrictions: azo dyes (entry 43), nonylphenol ethoxylates (46a), dimethylfumarate (61), CMR substances in clothing and textiles (72), PFHxA (79).",
  },
  {
    dataPoint: "restricted-substances",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 5",
    text: "Sum of lead, cadmium, mercury and hexavalent chromium at most 100 mg/kg; PFAS limits for food-contact packaging; substances of concern documented.",
  },
  {
    dataPoint: "biocidal-treatment",
    legislation: "bpr",
    groups: TX,
    ref: "Art. 58(3)",
    text: "Treated articles state that they incorporate biocidal products, the biocidal property claimed, the active substances and any nanomaterials (marked “(nano)”).",
  },

  // ---------- Environmental footprint ----------
  {
    dataPoint: "carbon-footprint",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex I(n)",
    text: "Carbon footprint of the product, calculated with the method set in the delegated act.",
  },
  {
    dataPoint: "carbon-footprint",
    legislation: "cbam",
    groups: AL,
    ref: "Art. 7, Annex IV",
    text: "Specific embedded emissions (t CO₂e per t of good) per installation, from actual data or default values; for aluminium only direct emissions are charged.",
  },
  {
    dataPoint: "carbon-footprint",
    legislation: "cpr",
    groups: AL,
    ref: "Annex II",
    text: "Global warming potential over the life cycle, declared in the declaration of performance and conformity where the harmonised technical specification requires it.",
  },
  {
    dataPoint: "environmental-footprint",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex I(m)",
    text: "Environmental footprint of the product quantified with the applicable method (e.g. PEF) across impact categories.",
  },
  {
    dataPoint: "environmental-footprint",
    legislation: "cpr",
    groups: AL,
    ref: "Annex II",
    text: "Further life-cycle environmental sustainability characteristics as set out in harmonised technical specifications.",
  },
  {
    dataPoint: "process-emissions",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex I(q)",
    text: "Emissions to air, water or soil released in one or more life-cycle stages.",
  },
  {
    dataPoint: "process-emissions",
    legislation: "cbam",
    groups: AL,
    ref: "Annex IV, monitoring rules",
    text: "Production route (primary smelting or secondary remelting) and process emissions, including CO₂ from anode consumption and PFCs (CF₄, C₂F₆) from anode effects.",
  },
  {
    dataPoint: "energy-resources",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex I(g)",
    text: "Use or consumption of energy, water and other resources in one or more life-cycle stages.",
  },
  {
    dataPoint: "energy-resources",
    legislation: "cbam",
    groups: AL,
    ref: "Annex IV",
    text: "Electricity consumed per tonne of good and its emission factor (indirect emissions; reported, but not charged for aluminium).",
  },
  {
    dataPoint: "precursors",
    legislation: "cbam",
    groups: AL,
    ref: "Annex IV",
    text: "For aluminium products made from unwrought aluminium: quantity of each precursor, its embedded emissions and the installation that produced it.",
  },
  {
    dataPoint: "carbon-price",
    legislation: "cbam",
    groups: AL,
    ref: "Art. 9",
    text: "Carbon price effectively paid in the country of origin, with evidence, to reduce the number of CBAM certificates to surrender.",
  },
  {
    dataPoint: "microplastics",
    legislation: "espr",
    groups: TX,
    ref: "Annex I(p)",
    text: "Microplastic release, e.g. fibre shedding during washing, per relevant life-cycle stage.",
  },

  // ---------- Circularity & end of life ----------
  {
    dataPoint: "recycled-content",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex I(h)",
    text: "Use or content of recycled materials and recovery of materials, including critical raw materials.",
  },
  {
    dataPoint: "recycled-content",
    legislation: "cbam",
    groups: AL,
    ref: "Implementing rules, aluminium parameters",
    text: "Tonnes of scrap used per tonne of product and the share of pre-consumer scrap.",
  },
  {
    dataPoint: "durability",
    legislation: "espr",
    groups: TX,
    ref: "Annex I(a)",
    text: "Durability and reliability, e.g. guaranteed or technical lifetime, resistance to stresses or ageing (pilling, colour fastness, seam strength).",
  },
  {
    dataPoint: "durability",
    legislation: "wfd",
    groups: TX,
    ref: "Textile EPR, fee modulation",
    text: "EPR fees modulated by ecodesign criteria such as durability and reparability, aligned with ESPR requirements.",
  },
  {
    dataPoint: "repairability",
    legislation: "espr",
    groups: TX,
    ref: "Annex I(b)",
    text: "Ease of repair and maintenance: spare parts, repair instructions, non-destructive disassembly.",
  },
  {
    dataPoint: "recyclability",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex I(d)",
    text: "Design for recycling: easily recyclable materials, access to components, possibility of high-purity sorting.",
  },
  {
    dataPoint: "recyclability",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 6",
    text: "Packaging must be recyclable, with a recyclability performance grade (A–C) documented; grades below C banned from 2030.",
  },
  {
    dataPoint: "recyclability",
    legislation: "wfd",
    groups: TX,
    ref: "Textile EPR, fee modulation",
    text: "EPR fees modulated by recyclability and recycled content of the textile products.",
  },
  {
    dataPoint: "end-of-life-info",
    legislation: "espr",
    groups: BOTH,
    ref: "Art. 7(2)(b)",
    text: "Information for users and recyclers on disassembly, recycling or disposal at end of life.",
  },
  {
    dataPoint: "end-of-life-info",
    legislation: "ppwr",
    groups: AL,
    ref: "Arts. 12–13",
    text: "Harmonised sorting label on the packaging, matching labels on waste receptacles.",
  },
  {
    dataPoint: "end-of-life-info",
    legislation: "wfd",
    groups: TX,
    ref: "Textile EPR",
    text: "Consumers informed about reuse, separate collection points and proper discarding of used textiles.",
  },
  {
    dataPoint: "quantities",
    legislation: "cbam",
    groups: AL,
    ref: "Art. 6",
    text: "Total quantity (tonnes) of each type of good imported during the calendar year, in the annual CBAM declaration.",
  },
  {
    dataPoint: "quantities",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 44",
    text: "Quantities of packaging made available on the market, by weight and material, reported to the producer register.",
  },
  {
    dataPoint: "quantities",
    legislation: "wfd",
    groups: TX,
    ref: "Textile EPR",
    text: "Quantities of textile, textile-related and footwear products made available on the market, reported per Member State.",
  },
  {
    dataPoint: "unsold-products",
    legislation: "espr",
    groups: TX,
    ref: "Arts. 24–25, Annex VII",
    text: "Large enterprises disclose the number and weight of unsold products discarded, with reasons and destination; destroying unsold apparel and footwear banned from 19 July 2026.",
  },

  // ---------- Supply chain & origin ----------
  {
    dataPoint: "production-site",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex III(i)",
    text: "Unique facility identifiers of the sites involved in the product's value chain.",
  },
  {
    dataPoint: "production-site",
    legislation: "cbam",
    groups: AL,
    ref: "Art. 6, Annex IV",
    text: "Country of origin and the installation where each good was produced: name, address, UN/LOCODE and coordinates.",
  },
  {
    dataPoint: "production-site",
    legislation: "flr",
    groups: BOTH,
    ref: "Information requests in investigations",
    text: "Place of production and manufacture of the product, as requested by the competent authority.",
  },
  {
    dataPoint: "supply-chain-operators",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex III(h)",
    text: "Unique operator identifiers of economic operators other than the manufacturer.",
  },
  {
    dataPoint: "supply-chain-operators",
    legislation: "cbam",
    groups: AL,
    ref: "Art. 10, Annex IV",
    text: "Operator of the producing installation, registered in the CBAM registry, communicating embedded emissions to the declarant.",
  },
  {
    dataPoint: "supply-chain-operators",
    legislation: "flr",
    groups: BOTH,
    ref: "Information requests in investigations",
    text: "Manufacturers, producers and suppliers of the product and its components, as requested by the competent authority.",
  },
  {
    dataPoint: "forced-labour",
    legislation: "flr",
    groups: BOTH,
    ref: "Arts. 3, 17",
    text: "Products made with forced labour may not be placed on or exported from the EU market; operators show their due diligence and mitigation measures on request.",
  },

  // ---------- Compliance & information ----------
  {
    dataPoint: "conformity",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex III(e)",
    text: "Compliance documentation such as the EU declaration of conformity, technical documentation and conformity certificates.",
  },
  {
    dataPoint: "conformity",
    legislation: "cpr",
    groups: AL,
    ref: "Arts. 15–16",
    text: "Declaration of performance and conformity (DoPC) covering essential characteristics and product requirements; CE marking.",
  },
  {
    dataPoint: "conformity",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 15",
    text: "EU declaration of conformity and technical documentation for the packaging, kept up to date.",
  },
  {
    dataPoint: "conformity",
    legislation: "gpsr",
    groups: TX,
    ref: "Art. 9(2)–(3)",
    text: "Internal risk analysis and technical documentation, kept for 10 years after the product is placed on the market.",
  },
  {
    dataPoint: "verification",
    legislation: "cbam",
    groups: AL,
    ref: "Art. 8, Annex VI",
    text: "Embedded emissions verified by an accredited verifier; verification report kept with the declaration.",
  },
  {
    dataPoint: "verification",
    legislation: "cpr",
    groups: AL,
    ref: "AVCP systems",
    text: "Assessment and verification of constancy of performance, with notified-body involvement depending on the system.",
  },
  {
    dataPoint: "performance",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex I(s)",
    text: "Functional performance and conditions for use.",
  },
  {
    dataPoint: "performance",
    legislation: "cpr",
    groups: AL,
    ref: "Arts. 15–16",
    text: "Declared performance of essential characteristics (e.g. mechanical resistance, reaction to fire, thermal transmittance) per harmonised standard.",
  },
  {
    dataPoint: "dpp",
    legislation: "espr",
    groups: BOTH,
    ref: "Arts. 9–13",
    text: "Digital product passport reachable via a data carrier (e.g. QR code), with a backup copy kept by a service provider and the identifier in the EU registry.",
  },
  {
    dataPoint: "dpp",
    legislation: "cpr",
    groups: AL,
    ref: "Art. 75",
    text: "Construction product passport, set up by delegated act, carrying the DoPC, technical documentation and instructions.",
  },
  {
    dataPoint: "dpp",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 12",
    text: "Data carrier (e.g. QR code) on the packaging giving access to labelling and conformity information.",
  },
  {
    dataPoint: "instructions",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex III(f)",
    text: "User manuals, instructions, warnings or safety information.",
  },
  {
    dataPoint: "instructions",
    legislation: "cpr",
    groups: AL,
    ref: "Manufacturer obligations",
    text: "Instructions for use and safety information accompanying the product.",
  },
  {
    dataPoint: "instructions",
    legislation: "gpsr",
    groups: TX,
    ref: "Art. 9(7)",
    text: "Clear instructions and safety information in a language consumers easily understand.",
  },
  {
    dataPoint: "instructions",
    legislation: "bpr",
    groups: TX,
    ref: "Art. 58(3)",
    text: "Instructions for use and precautions for the treated article where needed to protect people or the environment.",
  },
  {
    dataPoint: "label",
    legislation: "tlr",
    groups: TX,
    ref: "Arts. 14–16",
    text: "Durable, legible and accessible label or marking in the language of the Member State where sold, visible before purchase including online.",
  },
  {
    dataPoint: "label",
    legislation: "bpr",
    groups: TX,
    ref: "Art. 58(3)",
    text: "Label on the treated article itself, or its packaging, in the official language of the Member State.",
  },
  {
    dataPoint: "label",
    legislation: "cpr",
    groups: AL,
    ref: "CE marking",
    text: "CE marking affixed to the product, its label or accompanying documents together with the DoPC reference.",
  },
  {
    dataPoint: "label",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 12",
    text: "Harmonised packaging label with pictograms, visible, legible and indelible.",
  },
];

export const legislationById = Object.fromEntries(LEGISLATIONS.map((l) => [l.id, l])) as Record<string, Legislation>;

export const appliesTo = (legislation: Legislation, group: ProductGroup) => !!legislation.scope[group];

/** Data points any legislation asks for this product group (or every group when none is chosen). */
export function dataPointsFor(group: ProductGroup | null): Set<string> {
  return new Set(REQUIREMENTS.filter((r) => !group || r.groups.includes(group)).map((r) => r.dataPoint));
}

/** Requirements behind each data point for the chosen group and legislations: the union over legislations. */
export function requirementsByDataPoint(group: ProductGroup, legislations: Set<string>): Map<string, Requirement[]> {
  const out = new Map<string, Requirement[]>();
  for (const r of REQUIREMENTS) {
    if (!r.groups.includes(group) || !legislations.has(r.legislation)) continue;
    const list = out.get(r.dataPoint) ?? [];
    list.push(r);
    out.set(r.dataPoint, list);
  }
  return out;
}

/** Distinct legislations motivating a data point. */
export const legislationCount = (requirements: Requirement[]) => new Set(requirements.map((r) => r.legislation)).size;
