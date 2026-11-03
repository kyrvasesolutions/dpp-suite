/**
 * EU legislation that asks for product data on aluminium and textile products,
 * and the data points each one requires.
 *
 * Every requirement belongs to one generic data point, so when several
 * legislations ask for the same kind of data (e.g. ESPR's carbon footprint and
 * CBAM's embedded emissions) they show up as one row with both behind it.
 * Where a requirement has `quotes`, they are the act's own words, taken from the
 * Official Journal text (amending and implementing acts included) and checked by
 * `npm run check-legal-text`; `text` is a plain-language reading next to them.
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
  /** CELEX number of the act on EUR-Lex. */
  celex: string;
  category: LegislationCategory;
  /** Why and from when it applies, per product group it covers. */
  scope: Partial<Record<ProductGroup, string>>;
  /** Technical standards the act relies on, when recorded. */
  standards?: Array<{ ref: string; title: string }>;
}

export const eurLex = (celex: string) => `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${celex}`;

export const LEGISLATIONS: Legislation[] = [
  {
    id: "espr",
    short: "ESPR",
    title: "Ecodesign for Sustainable Products Regulation",
    ref: "Regulation (EU) 2024/1781",
    celex: "32024R1781",
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
    celex: "32024R3110",
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
    celex: "32025R0040",
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
    celex: "32023R0956",
    category: "climate",
    scope: {
      aluminium:
        "Unwrought aluminium and aluminium products (CN 7601, 7603–7616) imported into the EU. Definitive period since 1 January 2026; importers under 50 tonnes net mass a year are exempt.",
    },
  },
  {
    id: "reach",
    short: "REACH",
    title: "Registration, Evaluation, Authorisation and Restriction of Chemicals",
    ref: "Regulation (EC) No 1907/2006",
    celex: "32006R1907",
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
    celex: "32012R0528",
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
    celex: "32011R1007",
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
    celex: "32023R0988",
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
    celex: "32008L0098",
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
    celex: "32024R3015",
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
  /** Article, annex or point of the act. */
  ref: string;
  /** Plain-language reading of the provision. */
  text: string;
  /**
   * Excerpts copied word for word from the act (`npm run check-legal-text`
   * verifies them). Several excerpts of one provision are shown joined by an ellipsis.
   */
  quotes?: string[];
  /** CELEX number of the act quoted, when it is an amending or implementing act rather than the legislation itself. */
  source?: string;
}

/** Amending and implementing acts some requirements are quoted from. */
export const SOURCE_ACTS: Record<string, { ref: string; title: string }> = {
  "32025R2083": {
    ref: "Regulation (EU) 2025/2083",
    title: "amending Regulation (EU) 2023/956 as regards simplifying and strengthening the CBAM",
  },
  "32025R2547": {
    ref: "Implementing Regulation (EU) 2025/2547",
    title: "methods for the calculation of emissions embedded in goods under the CBAM",
  },
  "32018L0851": {
    ref: "Directive (EU) 2018/851",
    title: "amending Directive 2008/98/EC on waste",
  },
};

const AL: ProductGroup[] = ["aluminium"];
const TX: ProductGroup[] = ["textile"];
const BOTH: ProductGroup[] = ["aluminium", "textile"];

/** ESPR information requirements bind a product group only once its delegated act sets them. */
const ESPR_DELEGATED = "Applies once the ESPR delegated act for the product group requires it.";

export const REQUIREMENTS: Requirement[] = [
  // ---------- Identification & operators ----------
  {
    dataPoint: "product-id",
    legislation: "espr",
    groups: BOTH,
    ref: "Art. 10(1)(a)–(b)",
    quotes: [
      "it shall be connected through a data carrier to a persistent unique product identifier; (b) the data carrier shall be physically present on the product, its packaging or on documentation accompanying the product",
    ],
    text: `Persistent unique product identifier, reached through a data carrier on the product, packaging or documentation. ${ESPR_DELEGATED}`,
  },
  {
    dataPoint: "product-id",
    legislation: "cpr",
    groups: AL,
    ref: "Art. 22(5)",
    quotes: [
      "The manufacturer shall ensure that its products bear a manufacturer-specific unique identification code of the product type and, where available, a batch or serial number which is easily visible and legible for users.",
    ],
    text: "Unique identification code of the product type, plus batch or serial number where available, on the product.",
  },
  {
    dataPoint: "product-id",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 15(5)",
    quotes: [
      "Manufacturers shall ensure that the packaging bears a type, batch or serial number or other element allowing its identification",
    ],
    text: "Type, batch or serial number on the packaging, or in a document accompanying the packaged product.",
  },
  {
    dataPoint: "product-id",
    legislation: "gpsr",
    groups: TX,
    ref: "Art. 9(5)",
    text: "Type, batch or serial number or another identifying element on the product, or on its packaging or accompanying document where the product is too small.",
  },
  {
    dataPoint: "product-id",
    legislation: "flr",
    groups: BOTH,
    ref: "Art. 27(2)",
    quotes: [
      "shall provide or make available to customs authorities information identifying the product, information about the manufacturer or the producer and information about the product suppliers",
    ],
    text: "At release for free circulation or export, for products or product groups named in a delegated act under Art. 27(1).",
  },
  {
    dataPoint: "commodity-code",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex III(d)",
    quotes: ["relevant commodity codes, such as a TARIC code as defined in Regulation (EEC) No 2658/87"],
    text: `Commodity code of the product in the digital product passport; Art. 13(1) also stores it in the registry for goods released for free circulation. ${ESPR_DELEGATED}`,
  },
  {
    dataPoint: "commodity-code",
    legislation: "cbam",
    groups: AL,
    ref: "Annex I",
    quotes: ["7601 – Unwrought aluminium", "7616 – Other articles of aluminium"],
    text: "CBAM goods are identified by CN code: aluminium is 7601 and 7603 to 7616. The declaration reports per type of goods.",
  },
  {
    dataPoint: "manufacturer",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex III(g)",
    quotes: ["information related to the manufacturer, such as its unique operator identifier and the information referred to in Article 27(7)"],
    text: `Manufacturer identity and contact details, with its unique operator identifier. ${ESPR_DELEGATED}`,
  },
  {
    dataPoint: "manufacturer",
    legislation: "cpr",
    groups: AL,
    ref: "Annex IV, point 1.3; Art. 18(2)(b)",
    quotes: [
      "Contact details of the manufacturer or the authorised representative: (a) name; (b) postal address; (c) telephone; (d) email address; (e) website, where available.",
    ],
    text: "Part of the general product information; the CE marking is also followed by the manufacturer's name and registered address.",
  },
  {
    dataPoint: "manufacturer",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 15(6)",
    quotes: [
      "Manufacturers shall indicate on the packaging or on a QR code or another data carrier their name, registered trade name or registered trademark as well as the postal address at which and, where available, the electronic means of communication by which they can be contacted.",
    ],
    text: "Manufacturer name and postal address on the packaging or through its data carrier.",
  },
  {
    dataPoint: "manufacturer",
    legislation: "gpsr",
    groups: TX,
    ref: "Art. 9(6)",
    text: "Name, registered trade name or trade mark, and postal and electronic address of the manufacturer on the product or its packaging.",
  },
  {
    dataPoint: "manufacturer",
    legislation: "flr",
    groups: BOTH,
    ref: "Art. 27(2)",
    quotes: ["information about the manufacturer or the producer"],
    text: "Given to customs for products or product groups named in a delegated act under Art. 27(1).",
  },
  {
    dataPoint: "importer",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex III(j)–(k)",
    quotes: [
      "information related to the importer, including the information referred to in Article 29(3) and its Economic Operators Registration and Identification (EORI) number; (k) the name, contact details and unique operator identifier of the economic operator established in the Union responsible for carrying out the tasks set out in Article 4 of Regulation (EU) 2019/1020",
    ],
    text: `Importer details with EORI number, and the EU-established operator responsible for the product. ${ESPR_DELEGATED}`,
  },
  {
    dataPoint: "importer",
    legislation: "cbam",
    groups: AL,
    ref: "Art. 5(1) as amended; Annex V, point 1.1",
    source: "32025R2083",
    quotes: [
      "Any importer established in a Member State shall, prior to importing goods into the customs territory of the Union, apply for the status of authorised CBAM declarant",
    ],
    text: "Only an authorised CBAM declarant may import CBAM goods. Records must identify the declarant by name and CBAM account number (Annex V). Importers under 50 tonnes net mass a year are exempt (Art. 2a).",
  },
  {
    dataPoint: "importer",
    legislation: "cpr",
    groups: AL,
    ref: "Art. 24(6)",
    quotes: [
      "importer shall indicate its name, registered trade name or registered trade mark, its place of business, its contact address and, where available, electronic means of communication, either on the product or, where that is not possible, on its packaging, or in a document accompanying the product.",
    ],
    text: "Importer name and contact address on the product, its packaging or accompanying document.",
  },
  {
    dataPoint: "importer",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 18(3)",
    quotes: [
      "Importers shall indicate on the packaging their name and their registered trade name or registered trademark as well as the postal address at which and, where available, the electronic means of communication by which they can be contacted.",
    ],
    text: "Importer name and postal address on the packaging, or through its data carrier or an accompanying document.",
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
    ref: "Art. 44(2)",
    quotes: [
      "Producers shall be obliged to register in the register referred to in paragraph 1 of this Article in each Member State where they make packaging or packaged products available on the territory of the Member State for the first time",
    ],
    text: "Registration in the national register of producers of each Member State where the packaging is first made available.",
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
    quotes: ["material composition and homogeneity, possibility for high-purity sorting"],
    text: `Material composition as a parameter of design for recycling. ${ESPR_DELEGATED}`,
  },
  {
    dataPoint: "material-composition",
    legislation: "cpr",
    groups: AL,
    ref: "Annex IV, point 1.2(e)",
    quotes: ["main materials used."],
    text: "Main materials, as part of the product description in the general product information.",
  },
  {
    dataPoint: "material-composition",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 12(1)",
    quotes: [
      "packaging placed on the market shall be marked with a harmonised label containing information on its material composition in order to facilitate consumer sorting.",
    ],
    text: "From 12 August 2028, or 24 months after the implementing acts, whichever is later.",
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
    quotes: [
      "the information requirements shall make it possible to track the substances of concern, throughout the life cycle of the products concerned",
      "the name or numerical code of the substances of concern present in the product",
      "the location of the substances of concern within the product;",
      "the concentration, maximum concentration or concentration range of the substances of concern, at the level of the product, its relevant components, or spare parts;",
    ],
    text: `Name (IUPAC, EC, CAS), location and concentration of each substance of concern, plus safe-use and end-of-life information. ${ESPR_DELEGATED}`,
  },
  {
    dataPoint: "substances-of-concern",
    legislation: "reach",
    groups: BOTH,
    ref: "Art. 33(1)",
    quotes: [
      "Any supplier of an article containing a substance meeting the criteria in Article 57 and identified in accordance with Article 59(1) in a concentration above 0,1 % weight by weight (w/w) shall provide the recipient of the article with sufficient information, available to the supplier, to allow safe use of the article including, as a minimum, the name of that substance.",
    ],
    text: "Candidate List substances above 0.1 % w/w: inform recipients; consumers on request within 45 days (Art. 33(2)).",
  },
  {
    dataPoint: "substances-of-concern",
    legislation: "reach",
    groups: BOTH,
    ref: "Art. 7(2)",
    quotes: [
      "Any producer or importer of articles shall notify the Agency, in accordance with paragraph 4 of this Article, if a substance meets the criteria in Article 57 and is identified in accordance with Article 59(1)",
      "the substance is present in those articles in quantities totalling over one tonne per producer or importer per year;",
      "the substance is present in those articles above a concentration of 0,1 % weight by weight (w/w).",
    ],
    text: "Notify ECHA when a Candidate List substance is in the articles above 0.1 % w/w and above 1 tonne a year.",
  },
  {
    dataPoint: "substances-of-concern",
    legislation: "wfd",
    groups: BOTH,
    ref: "Art. 9(1)(i)",
    source: "32018L0851",
    quotes: [
      "ensure that any supplier of an article as defined in point 33 of Article 3 of Regulation (EC) No 1907/2006",
      "provides the information pursuant to Article 33(1) of that Regulation to the European Chemicals Agency as from 5 January 2021;",
    ],
    text: "The REACH Art. 33(1) information goes to ECHA's SCIP database.",
  },
  {
    dataPoint: "substances-of-concern",
    legislation: "cpr",
    groups: AL,
    ref: "Art. 15(6)",
    quotes: [
      "The information referred to in Article 31 or, as the case may be, in Article 33 of Regulation (EC) No 1907/2006",
      "shall be provided together with the declaration of performance and conformity.",
    ],
    text: "The REACH safety data sheet or Art. 33 information is supplied with the declaration of performance and conformity.",
  },
  {
    dataPoint: "substances-of-concern",
    legislation: "ppwr",
    groups: AL,
    ref: "Arts. 5(1), 12(1)",
    quotes: [
      "Packaging placed on the market shall be so manufactured that the presence and concentration of substances of concern as constituents of the packaging material or of any of the packaging components is minimised",
      "The packaging placed on the market containing substances of concern shall be marked by means of standardised, open, digital-marking technologies",
    ],
    text: "Substances of concern minimised, and packaging containing them digitally marked.",
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
    ref: "Art. 5(4)–(5)",
    quotes: [
      "the sum of the concentrations of lead, cadmium, mercury and hexavalent chromium resulting from substances present in packaging or packaging components shall not exceed 100 mg/kg.",
      "From 12 August 2026, food-contact packaging shall not be placed on the market if it contains per- and polyfluorinated alkyl substances (PFAS) in a concentration equal to or above the following limit values",
    ],
    text: "Heavy-metal sum limit for all packaging; PFAS limits for food-contact packaging.",
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
    ref: "Art. 7(2)(b)(i); Annex I(n)",
    quotes: [
      "information on the performance of the product in relation to one or more of the product parameters referred to in Annex I, including a repairability score, a durability score, a carbon footprint or an environmental footprint;",
      "the carbon footprint of the product;",
    ],
    text: `Carbon footprint, calculated with the method the delegated act sets. ${ESPR_DELEGATED}`,
  },
  {
    dataPoint: "carbon-footprint",
    legislation: "cbam",
    groups: AL,
    ref: "Art. 6(2)(b); Art. 7(1)",
    quotes: [
      "the total embedded emissions in the goods referred to in point (a) of this paragraph, expressed in tonnes of CO2e emissions per megawatt-hour of electricity or, for other goods, in tonnes of CO2e emissions per tonne of each type of goods",
      "For goods listed in Annex II only direct emissions shall be calculated and taken into account.",
    ],
    text: "Aluminium is in Annex II, so only direct embedded emissions count. They come from actual installation data or default values (Art. 7(2) as amended).",
  },
  {
    dataPoint: "carbon-footprint",
    legislation: "cpr",
    groups: AL,
    ref: "Art. 15(2)–(3)(a); Annex II(a)–(d)",
    quotes: [
      "The declaration of performance and conformity shall include the product’s environmental sustainability performance over its life cycle in respect of the predetermined environmental essential characteristics listed in Annex II for those characteristics that are declared.",
      "essential characteristics listed in points (a) to (d) of Annex II, from 8 January 2026;",
      "climate change effects – total;",
    ],
    text: "Life-cycle climate change effects (total, fossil, biogenic, land use) declared in the DoPC, calculated with the Commission's free software.",
  },
  {
    dataPoint: "environmental-footprint",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex I(m)",
    quotes: [
      "the environmental footprint of the product, expressed as a quantification, in accordance with the applicable delegated act, of a product’s life cycle environmental impacts, whether in relation to one or more environmental impact categories or an aggregated set of impact categories;",
    ],
    text: ESPR_DELEGATED,
  },
  {
    dataPoint: "environmental-footprint",
    legislation: "cpr",
    groups: AL,
    ref: "Art. 15(3)(b)–(c); Annex II(e)–(s)",
    quotes: [
      "essential characteristics listed in points (e) to (m), of Annex II, from 9 January 2030;",
      "essential characteristics listed in points (n) to (s), of Annex II, from 9 January 2032.",
    ],
    text: "Further life-cycle indicators in the DoPC: ozone depletion, acidification, eutrophication, resource depletion and water use from 2030; particulate matter, toxicity and land use from 2032.",
  },
  {
    dataPoint: "process-emissions",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex I(q)",
    quotes: [
      "emissions to air, water or soil released in one or more lifecycle stages of the product as expressed through quantities and nature of emissions",
    ],
    text: ESPR_DELEGATED,
  },
  {
    dataPoint: "process-emissions",
    legislation: "cbam",
    groups: AL,
    ref: "Annex I, point 3.17.2.1",
    source: "32025R2547",
    quotes: [
      "all processes directly or indirectly linked to the production processes emitting CO2 emissions from the consumption of electrodes or electrode pastes;",
      "perfluorocarbon emissions caused by anode effects monitored in accordance with point B.7 of Annex II.",
    ],
    text: "Primary (electrolytic) smelting: monitor CO₂ from anode consumption and PFCs (CF₄, C₂F₆) from anode effects. Secondary melting covers fuel emissions only (point 3.17.2.2).",
  },
  {
    dataPoint: "energy-resources",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex I(g)",
    quotes: ["use or consumption of energy, water and other resources in one or more life cycle stages of the product"],
    text: ESPR_DELEGATED,
  },
  {
    dataPoint: "precursors",
    legislation: "cbam",
    groups: AL,
    ref: "Annex VI, point 2(k)",
    quotes: [
      "quantities of each input material (precursor) used;",
      "the specific embedded emissions associated with each of the input materials (precursors) used;",
    ],
    text: "Complex goods (e.g. aluminium products made from unwrought aluminium) carry the embedded emissions of their precursors; the verification report states them.",
  },
  {
    dataPoint: "carbon-price",
    legislation: "cbam",
    groups: AL,
    ref: "Art. 9(1)–(2) as amended",
    source: "32025R2083",
    quotes: [
      "Where the embedded emissions are determined on the basis of actual emissions, an authorised CBAM declarant may claim in the CBAM declaration a reduction in the number of CBAM certificates to be surrendered in order to take into account the carbon price paid in a third country for the declared embedded emissions.",
      "The authorised CBAM declarant shall also keep evidence of the actual payment of the carbon price.",
    ],
    text: "Optional reduction, backed by documentation certified by an independent person; with default values, only yearly default carbon prices can be used (Art. 9(4)).",
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
    quotes: ["use or content of recycled materials and recovery of materials, including critical raw materials;"],
    text: ESPR_DELEGATED,
  },
  {
    dataPoint: "recycled-content",
    legislation: "cbam",
    groups: AL,
    ref: "Annex I, point 3.17.2.2; Annex II, section F",
    source: "32025R2547",
    quotes: [
      "Secondary melting (recycling) of aluminium uses aluminium scrap as main input.",
      "Off-spec products, by-products, waste, and scrap produced in a production process, irrespective of whether they are returned to production processes, delivered to other installations, or disposed of, shall not be included in the determination of the activity level. They shall therefore be assigned zero embedded emissions when entering another production process.",
    ],
    text: "No recycled-content share is declared, but the production route (primary or secondary) must be known: scrap enters with zero embedded emissions.",
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
    legislation: "cpr",
    groups: AL,
    ref: "Annex IV, point 1.2(d)",
    quotes: ["estimated average and minimum service life span for declared use (durability);"],
    text: "Part of the product description in the general product information.",
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
    quotes: [
      "design for recycling, ease and quality of recycling as expressed through use of easily recyclable materials",
    ],
    text: ESPR_DELEGATED,
  },
  {
    dataPoint: "recyclability",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 6(1), (3)",
    quotes: [
      "All packaging placed on the market shall be recyclable.",
      "Packaging recyclability shall be expressed in the recyclability performance grades A, B or C as described in Table 3 of Annex II.",
    ],
    text: "Grades A–C required from 2030 (or 24 months after the delegated acts); only A or B from 2038.",
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
    ref: "Art. 7(2)(b)(iii)",
    quotes: ["information for treatment facilities on disassembly, reuse, refurbishment, recycling, or disposal at end-of-life;"],
    text: ESPR_DELEGATED,
  },
  {
    dataPoint: "end-of-life-info",
    legislation: "cpr",
    groups: AL,
    ref: "Annex IV, point 1.4(a)",
    quotes: ["information on installation, maintenance, use, deconstruction and demolition;"],
    text: "Contact point for deconstruction and demolition information, where different from the manufacturer's contact details.",
  },
  {
    dataPoint: "end-of-life-info",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 12(1)",
    quotes: [
      "economic operators may place a QR code or other type of standardised, open, digital data carrier on the packaging that contains information on the destination of each separate component of the packaging in order to facilitate consumer sorting.",
    ],
    text: "Optional, in addition to the mandatory harmonised sorting label.",
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
    ref: "Art. 6(2)(a) as amended",
    source: "32025R2083",
    quotes: [
      "the total quantity of each type of goods imported during the preceding calendar year, expressed in megawatt-hours for electricity and in tonnes for other goods, including the imported goods below the single mass-based threshold;",
    ],
    text: "In the annual CBAM declaration, due by 30 September for the preceding year (first in 2027 for 2026).",
  },
  {
    dataPoint: "quantities",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 44(7); Annex IX, Part B, point 1(c)",
    quotes: [
      "quantities by weight of packaging categories as set out in Table 1 of Annex II that the producer makes available on the territory of the Member State for the first time",
    ],
    text: "Reported to the register of producers by 1 June for the preceding year.",
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
    quotes: ["unique facility identifiers;"],
    text: ESPR_DELEGATED,
  },
  {
    dataPoint: "production-site",
    legislation: "cbam",
    groups: AL,
    ref: "Annex V, points 1.2(b) and 2(a)",
    quotes: ["country of origin;", "identification of the installation where the goods were produced;"],
    text: "Records kept by the declarant; the installation is needed whenever actual emissions are used.",
  },
  {
    dataPoint: "production-site",
    legislation: "cbam",
    groups: AL,
    ref: "Art. 10(2)(b)",
    quotes: [
      "the location of each installation including the complete address and geographical coordinates expressed in longitude and latitude, including six decimals;",
    ],
    text: "When the third-country operator registers its installation in the CBAM registry.",
  },
  {
    dataPoint: "supply-chain-operators",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex III(h)",
    quotes: ["unique operator identifiers other than that of the manufacturer;"],
    text: ESPR_DELEGATED,
  },
  {
    dataPoint: "supply-chain-operators",
    legislation: "cbam",
    groups: AL,
    ref: "Art. 10(2)(a) as amended",
    source: "32025R2083",
    quotes: [
      "the name, address, corporate or activity registration number and contact information of the operator, and, if applicable, of its controlling entities including the parent company of that operator, together with the supporting documents;",
    ],
    text: "Third-country installation operators register in the CBAM registry and can share verified emissions with declarants (Art. 10(7)).",
  },
  {
    dataPoint: "supply-chain-operators",
    legislation: "flr",
    groups: BOTH,
    ref: "Art. 27(2)",
    quotes: ["information about the product suppliers"],
    text: "Given to customs for products or product groups named in a delegated act under Art. 27(1).",
  },
  {
    dataPoint: "forced-labour",
    legislation: "flr",
    groups: BOTH,
    ref: "Arts. 3, 17(1)–(2)",
    quotes: [
      "Economic operators shall not place or make available on the Union market products that are made with forced labour, nor shall they export such products.",
      "the relevant actions they have taken in order to identify, prevent, mitigate, bring to an end or remediate risks of forced labour in their operations and supply chains with respect to the products under assessment",
    ],
    text: "Applies from 14 December 2027. When assessed, operators answer within 30 working days on their due diligence.",
  },

  // ---------- Compliance & information ----------
  {
    dataPoint: "conformity",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex III(e)",
    quotes: [
      "compliance documentation and information required under this Regulation or other Union law applicable to the product, such as the declaration of conformity, technical documentation or conformity certificates;",
    ],
    text: ESPR_DELEGATED,
  },
  {
    dataPoint: "conformity",
    legislation: "cpr",
    groups: AL,
    ref: "Art. 15(1)",
    quotes: [
      "The declaration of performance and conformity shall express the performance of products in relation to the essential characteristics of those products in accordance with the relevant harmonised technical specifications or European assessment document.",
    ],
    text: "Declaration of performance and conformity (DoPC), drawn up on the Annex V model.",
  },
  {
    dataPoint: "conformity",
    legislation: "ppwr",
    groups: AL,
    ref: "Arts. 15(2), 39(1)",
    quotes: [
      "Before placing packaging on the market, manufacturers shall carry out the conformity assessment procedure referred to in Article 38 or have it carried out on their behalf, and shall draw up the technical documentation referred to in Annex VII.",
      "The EU declaration of conformity shall state that the fulfilment of the requirements laid down in or pursuant to Articles 5 to 12 has been demonstrated.",
    ],
    text: "Technical documentation and EU declaration of conformity, kept 5 years (single-use) or 10 years (reusable).",
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
    ref: "Art. 8(1) as amended",
    source: "32025R2083",
    quotes: [
      "Where the embedded emissions are determined on the basis of actual emissions, the authorised CBAM declarant shall ensure that the total embedded emissions declared in the CBAM declaration submitted pursuant to Article 6 are verified by a verifier accredited pursuant to Article 18, based on the verification principles set out in Annex VI.",
    ],
    text: "Not needed when default values are used. The verification report goes with the declaration (Art. 6(2)(d)).",
  },
  {
    dataPoint: "verification",
    legislation: "cpr",
    groups: AL,
    ref: "Art. 10(1)",
    quotes: ["shall be carried out in accordance with one or more of the systems set out in Annex IX."],
    text: "Assessment and verification system set per product family; may involve a notified body.",
  },
  {
    dataPoint: "performance",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex I(s)",
    quotes: ["functional performance and conditions for use"],
    text: ESPR_DELEGATED,
  },
  {
    dataPoint: "performance",
    legislation: "cpr",
    groups: AL,
    ref: "Art. 22(1)",
    quotes: [
      "The manufacturer shall ensure that the product’s performance is assessed in relation to both mandatory essential characteristics and those essential characteristics intended to be declared.",
    ],
    text: "Essential characteristics come from the harmonised technical specification for the product family.",
  },
  {
    dataPoint: "dpp",
    legislation: "espr",
    groups: BOTH,
    ref: "Arts. 9(1), 10(4), 13(4)",
    quotes: [
      "products can only be placed on the market or put into service if a digital product passport is available in accordance with the applicable delegated acts adopted pursuant to Article 4 and with Articles 10 and 11.",
      "The economic operator, when placing the product on the market, shall make available a back-up copy of the digital product passport through a digital product passport service provider.",
      "The economic operator placing the product on the market or putting it into service shall upload, in the registry, the data referred to in paragraphs 1 and 2.",
    ],
    text: ESPR_DELEGATED,
  },
  {
    dataPoint: "dpp",
    legislation: "cpr",
    groups: AL,
    ref: "Art. 22(7); Art. 76(2)",
    quotes: [
      "By 18 months after the entry into force of the delegated act referred to in Article 75(1) the manufacturer shall make available a digital product passport referred to in Article 76, through the construction digital product passport system referred to in Article 75, connected to a data carrier referred to in Article 18(2), point (g).",
    ],
    text: "The passport carries the DoPC, general product information and instructions, technical documentation, label and unique identifiers.",
  },
  {
    dataPoint: "instructions",
    legislation: "espr",
    groups: BOTH,
    ref: "Annex III(f)",
    quotes: ["user manuals, instructions, warnings or safety information, as required by other Union law applicable to the product;"],
    text: ESPR_DELEGATED,
  },
  {
    dataPoint: "instructions",
    legislation: "cpr",
    groups: AL,
    ref: "Art. 22(6); Annex IV",
    quotes: [
      "When making a product available on the market, the manufacturer shall ensure that it is accompanied by general product information, instructions for use and safety information, as set out in Annex IV in a language to be determined by the Member State concerned or, in absence of such determination, in a language which can be easily understood by users.",
    ],
    text: "Covers safety in transport, installation, maintenance and demolition, compatibility, maintenance needs and safe use.",
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
    ref: "Art. 18(1)–(2)",
    quotes: [
      "The CE marking shall be affixed visibly, legibly and indelibly to the product.",
      "the unique identification code of the product-type;",
      "the declaration code of the declaration of performance and conformity;",
    ],
    text: "The CE marking is followed by the year, manufacturer, product-type code, DoPC code, notified body number and a data carrier.",
  },
  {
    dataPoint: "label",
    legislation: "ppwr",
    groups: AL,
    ref: "Art. 12(1)",
    quotes: ["The label shall be based on pictograms and be easily understandable, including for persons with disabilities."],
    text: "Harmonised packaging label from 12 August 2028, or 24 months after the implementing acts.",
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
