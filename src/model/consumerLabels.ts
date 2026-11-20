/**
 * Consumer-facing certifications and labels a company can get for textiles, as
 * compliance targets of the B2C type.
 *
 * What counts: a scheme whose mark or claim reaches the consumer. Schemes that work
 * only between businesses, such as ZDHC, OEKO-TEX STeP, SA8000, WRAP, amfori BSCI and
 * the Leather Working Group, are left out. The list is what we could verify at each
 * scheme's own source, not everything that exists.
 *
 * What a label asks for is our plain-language reading with a link, not its wording:
 * scheme documents are copyrighted, so `npm run build-seed` rejects quotes here. A
 * version is named only where the scheme's own page states it.
 * `npm run check-labels` checks that the sources still open.
 */
import type { Legislation, LegislationCategory, Provision } from "./legislation";
import type { Standard, StandardLink } from "./standards";

const TEXTILE: Provision["groups"] = ["textile"];

interface Label {
  id: string;
  short: string;
  title: string;
  /** Who runs it, with the version where the source states one. */
  ref: string;
  url: string;
  category: LegislationCategory;
  /** What it certifies and how it is used. */
  scope: string;
  /** What it asks for, by data requirement. */
  data: Record<string, string>;
}

const TEXTILE_EXCHANGE = "Textile Exchange";
const MATERIALS_MATTER = "Moving into the Materials Matter Standard, mandatory from 31 December 2027.";

const LABELS: Label[] = [
  // ---------- Organic content ----------
  {
    id: "gots",
    short: "GOTS",
    title: "Global Organic Textile Standard",
    ref: "Global Standard gGmbH",
    url: "https://global-standards.org/our-standards/gots",
    category: "organic",
    scope:
      "Every processing stage, from fibre to finished product. Two label grades: Organic with at least 95% certified organic fibres, and Made with Organic Materials with at least 70%.",
    data: {
      "organic-content": "At least 70% certified organic fibres, or 95% for the Organic grade, from farms certified to an IFOAM Family standard.",
      "chain-of-custody": "Every company in processing, manufacturing and trading must be certified.",
      "restricted-substances": "Restrictions on chemical inputs at every processing stage.",
      "process-emissions": "Wastewater treatment and greenhouse gas emission management.",
      "energy-resources": "Resource efficiency in processing.",
      "working-conditions": "Safe and hygienic work, no discrimination, freedom of association and collective bargaining.",
      "forced-labour": "Prohibits forced and child labour.",
      durability: "Product safety and durability criteria.",
      verification: "Audited by approved independent certification bodies.",
    },
  },
  {
    id: "ocs",
    short: "OCS",
    title: "Organic Content Standard",
    ref: `${TEXTILE_EXCHANGE}, OCS 3.0`,
    url: "https://textileexchange.org/organic-content-standard/",
    category: "organic",
    scope: `Verifies organic content and its chain of custody, without the processing criteria GOTS adds. ${MATERIALS_MATTER}`,
    data: {
      "organic-content": "Organic material from farms certified to an IFOAM Family standard.",
      "chain-of-custody": "The path of certified material is documented through each supply chain stage.",
      verification: "A third-party certification body audits each stage.",
    },
  },
  {
    id: "ivn-best",
    short: "IVN BEST",
    title: "NATURTEXTIL IVN certified BEST",
    ref: "Internationaler Verband der Naturtextilwirtschaft, version 7.0",
    url: "https://naturtextil.de/",
    category: "organic",
    scope: "GOTS plus ten further requirements, so a certified company must hold GOTS too. Accepts only 100% organic natural fibre, trims aside.",
    data: {
      "organic-content": "100% natural fibre from certified organic farming or animal husbandry, excluding trims.",
      "restricted-substances": "Stricter than GOTS, for example on heavy-metal dyes, chlorine and silicone chemicals.",
      "chain-of-custody": "Certified through the production chain, on top of GOTS.",
      label: "Goods sold at retail must carry the seal, under its terms of use.",
    },
  },
  {
    id: "oeko-organic",
    short: "OEKO-TEX Organic",
    title: "OEKO-TEX ORGANIC COTTON",
    ref: "OEKO-TEX Association",
    url: "https://www.oeko-tex.com/en/our-standards/oeko-tex-organic-cotton",
    category: "organic",
    scope: "Organic cotton verified from farm to product, with laboratory tests on the product itself.",
    data: {
      "organic-content": "Organic cotton, with a quantitative test for genetically modified cotton and for mixing with conventional cotton.",
      "restricted-substances": "Tests for pesticides and other harmful substances, stricter the closer it sits to skin.",
      "chain-of-custody": "Verification from farm to product.",
      verification: "Globally standardised laboratory test criteria.",
    },
  },
  {
    id: "roc",
    short: "ROC",
    title: "Regenerative Organic Certified",
    ref: "Regenerative Organic Alliance",
    url: "https://regenorganic.org/",
    category: "organic",
    scope: "Covers textiles as well as food and personal care. Adds soil health, animal welfare and farmworker fairness to an organic baseline, at Bronze, Silver or Gold.",
    data: {
      "organic-content": "Requires current organic certification, with organic and non-organic content clearly distinguished on the label.",
      "animal-welfare": "Animal welfare is one of its three pillars.",
      "working-conditions": "Farmworker fairness is one of its three pillars.",
    },
  },

  // ---------- Fair trade and working conditions ----------
  {
    id: "fairtrade-textile",
    short: "Fairtrade Textile",
    title: "Fairtrade Textile Standard and Production Mark",
    ref: "Fairtrade International, revision valid from 1 September 2026",
    url: "https://www.fairtrade.net/en/why-fairtrade/how-we-do-it/standards/who-we-have-standards-for/textile-standard.html",
    category: "fairTrade",
    scope: "Factories, workers and brands, only in countries where freedom of association is possible. The revision covers Tier-1 and cut-make-trim factories.",
    data: {
      "working-conditions": "A living wage implemented within six years, with subcontractors meeting labour conditions and grievance procedures.",
      "fair-trade-terms": "Fair, reliable and predictable contracts from all actors, brands included, and a Premium that workers decide how to spend.",
      "supply-chain-operators": "Subcontractors must be registered and agree to audits.",
    },
  },
  {
    id: "fairtrade-cotton",
    short: "Fairtrade Cotton",
    title: "Fairtrade Cotton Mark",
    ref: "Fairtrade International",
    url: "https://www.fairtrade.net/us-en/products/all-products/cotton.html",
    category: "fairTrade",
    scope: "Marks cotton from Fairtrade certified farmers. It speaks to the cotton, not to the factories that make the garment.",
    data: {
      "fair-trade-terms": "A minimum price per kilogram of seed cotton that varies by region, a premium on top, and an organic minimum price 10% higher.",
      "chain-of-custody": "The cotton itself must be Fairtrade certified for the mark to apply.",
    },
  },
  {
    id: "fair-trade-usa",
    short: "Fair Trade USA",
    title: "Fair Trade Certified",
    ref: "Fair Trade USA, Factory Production Standard 2.0.1",
    url: "https://www.fairtradecertified.org/business/standards/",
    category: "fairTrade",
    scope: "Sets social, environmental and economic requirements for products, producers and businesses, with standards tailored to factories and to agriculture.",
    data: {
      "working-conditions": "Social requirements for factories under the Factory Production Standard.",
      "fair-trade-terms": "Economic requirements, with minimum prices and premiums set per product.",
    },
  },
  {
    id: "wfto",
    short: "WFTO",
    title: "WFTO Guaranteed Fair Trade Enterprise",
    ref: "World Fair Trade Organization",
    url: "https://wfto.com/our-fair-trade-system/our-guarantee-system/",
    category: "fairTrade",
    scope: "Verifies the whole enterprise rather than a product; a guaranteed member may use the label on its Fair Trade products. WFTO says it is moving to external certification to meet EU requirements.",
    data: {
      "fair-trade-terms": "The enterprise as a whole operates to the WFTO Fair Trade Standard.",
      "working-conditions": "Part of the same enterprise-level standard.",
      verification: "Verified through the WFTO Guarantee System, moving to external certification.",
    },
  },
  {
    id: "fair-for-life",
    short: "Fair for Life",
    title: "Fair for Life",
    ref: "Ecocert",
    url: "https://www.ecocert.com/en/certification-detail/fair-trade-fair-for-life",
    category: "fairTrade",
    scope: "Fair trade certification that covers textiles among other goods. The logo may appear when 80% of the raw materials come from Fair Trade.",
    data: {
      "fair-trade-terms": "Pricing that aims at fair pay, with a minimum price based on production costs.",
      "working-conditions": "Decent and safe working conditions.",
      verification: "Certified by an independent body such as Ecocert.",
    },
  },
  {
    id: "fair-wear",
    short: "Fair Wear",
    title: "Fair Wear Foundation member",
    ref: "Fair Wear Foundation",
    url: "https://www.fairwear.org/",
    category: "fairTrade",
    scope: "A brand membership, not a product certification. Only members rated Leader or Good may show the logo on garments.",
    data: {
      "working-conditions": "Assesses how a brand's practices affect working conditions in its factories.",
      "forced-labour": "Brand Performance Checks assess human rights due diligence.",
      verification: "Each Brand Performance Check is published.",
    },
  },

  // ---------- Responsible cotton ----------
  {
    id: "bci",
    short: "BCI Cotton",
    title: "BCI Cotton Label",
    ref: "Better Cotton Initiative, Principles and Criteria v3.2",
    url: "https://bettercotton.org/what-we-do/",
    category: "cotton",
    scope: "Cotton farming programme. Sourced as Mass Balance, which tracks volumes, or as Traceable cotton, which is physically segregated, so check which one a claim rests on.",
    data: {
      "chain-of-custody": "A Chain of Custody Standard, by Mass Balance or physically Traceable sourcing.",
      "working-conditions": "The wellbeing of farming communities is a priority area.",
      "energy-resources": "Water stewardship and soil practices on the farm.",
      verification: "Certification bodies accredited to ISO 17065 make the certification decisions.",
    },
  },
  {
    id: "cmia",
    short: "CmiA",
    title: "Cotton made in Africa",
    ref: "Aid by Trade Foundation",
    url: "https://cottonmadeinafrica.org/faq/",
    category: "cotton",
    scope: "Cotton from Sub-Saharan Africa. The seal alone can rest on Mass Balance; the \"Cotton made in Africa Inside\" label means the cotton was kept separate. An Organic variant exists.",
    data: {
      "working-conditions": "Social criteria for farmers, cotton companies and ginneries.",
      "forced-labour": "Bans forced labour and exploitative child labour, in line with ILO conventions 138 and 182.",
      "restricted-substances": "No genetically modified seed, and bans listed pesticides. Other chemical pesticides stay allowed outside the Organic variant.",
      "chain-of-custody": "Mass Balance or Hard Identity Preserved, tracked online.",
      verification: "Independent organisations verify on a two-year cycle.",
    },
  },

  // ---------- Recycled content ----------
  {
    id: "grs",
    short: "GRS",
    title: "Global Recycled Standard",
    ref: `${TEXTILE_EXCHANGE}, GRS 5.0`,
    url: "https://textileexchange.org/recycled-claim-global-recycled-standard/",
    category: "recycled",
    scope: `Recycled content plus social, environmental and chemical processing requirements. ${MATERIALS_MATTER}`,
    data: {
      "recycled-content": "At least 20% recycled content to be certified; at least 50% for a product-specific consumer-facing label.",
      "chain-of-custody": "The path of certified material is documented through each supply chain stage.",
      "working-conditions": "Sites must meet social requirements.",
      "process-emissions": "Sites must meet environmental requirements.",
      "restricted-substances": "Chemicals with harmful potential are not allowed.",
    },
  },
  {
    id: "rcs",
    short: "RCS",
    title: "Recycled Claim Standard",
    ref: `${TEXTILE_EXCHANGE}, RCS 3.0`,
    url: "https://textileexchange.org/recycled-claim-global-recycled-standard/",
    category: "recycled",
    scope: `Recycled content and its chain of custody only, without the GRS processing requirements. ${MATERIALS_MATTER}`,
    data: {
      "recycled-content": "At least 5% recycled content to be certified, a lower threshold than GRS.",
      "chain-of-custody": "The path of certified material is documented through each supply chain stage.",
    },
  },

  // ---------- Animal welfare and vegan ----------
  {
    id: "rws",
    short: "RWS",
    title: "Responsible Wool Standard",
    ref: `${TEXTILE_EXCHANGE}, RWS 2.2`,
    url: "https://textileexchange.org/responsible-wool-standard/",
    category: "animal",
    scope: `Wool farms and every site up to the final business-to-business seller. ${MATERIALS_MATTER}`,
    data: {
      "animal-welfare": "Animal welfare aligned with the Five Domains, with land management protecting soil and biodiversity.",
      "working-conditions": "Working conditions and health and safety on associated farms.",
      "chain-of-custody": "Certified from the farm to the final business-to-business seller.",
    },
  },
  {
    id: "rds",
    short: "RDS",
    title: "Responsible Down Standard",
    ref: `${TEXTILE_EXCHANGE}, RDS 3.0`,
    url: "https://textileexchange.org/responsible-down-standard/",
    category: "animal",
    scope: "Down and feathers. Not in the first version of the Materials Matter Standard, so it stays in use for now.",
    data: {
      "animal-welfare": "Welfare from hatching to slaughter, banning live plucking, molt harvesting and force-feeding.",
      "chain-of-custody": "Tracked through every stage; third-party audits start at the farm.",
    },
  },
  {
    id: "rms",
    short: "RMS",
    title: "Responsible Mohair Standard",
    ref: `${TEXTILE_EXCHANGE}, RMS 1.2`,
    url: "https://textileexchange.org/responsible-mohair-standard/",
    category: "animal",
    scope: `Mohair farms and every site up to the final business-to-business seller. ${MATERIALS_MATTER}`,
    data: {
      "animal-welfare": "Animal welfare aligned with the Five Domains, with land management protecting soil and biodiversity.",
      "working-conditions": "Working conditions and health and safety on associated farms.",
      "chain-of-custody": "Certified from the farm to the final business-to-business seller.",
    },
  },
  {
    id: "ras",
    short: "RAS",
    title: "Responsible Alpaca Standard",
    ref: `${TEXTILE_EXCHANGE}, RAS 1.0`,
    url: "https://textileexchange.org/responsible-alpaca-standard/",
    category: "animal",
    scope: `Alpaca farms and every site up to the final business-to-business seller. ${MATERIALS_MATTER}`,
    data: {
      "animal-welfare": "Animal welfare aligned with the Five Domains, with land management protecting soil and biodiversity.",
      "working-conditions": "Working conditions and health and safety on associated farms.",
      "chain-of-custody": "Certified from the farm to the final business-to-business seller.",
    },
  },
  {
    id: "downpass",
    short: "DOWNPASS",
    title: "DOWNPASS",
    ref: "DOWNPASS 2016",
    url: "https://www.downpass.com/en/",
    category: "animal",
    scope: "Standard and label for down and feathers used as filling.",
    data: {
      "animal-welfare": "Ethically sourced down and feathers, checked against a zero-tolerance standard.",
      "chain-of-custody": "Tightly controlled, traceable supply chains.",
      performance: "The quality of the filling is monitored.",
    },
  },
  {
    id: "gcs",
    short: "Good Cashmere",
    title: "The Good Cashmere Standard",
    ref: "Aid by Trade Foundation",
    url: "https://www.goodcashmere.org/",
    category: "animal",
    scope: "Cashmere from Inner Mongolia, covering goats, herders and the environment.",
    data: {
      "animal-welfare": "Goat welfare with respect to the Five Domains.",
      "working-conditions": "Economic, social and ecological conditions for herders and their communities.",
      verification: "Independent auditors check compliance regularly.",
    },
  },
  {
    id: "vegan-trademark",
    short: "Vegan Trademark",
    title: "Vegan Trademark",
    ref: "The Vegan Society",
    url: "https://www.vegansociety.com/trademark/vegan-trademark-standards",
    category: "animal",
    scope: "Registered per product, not per brand, and open to clothing.",
    data: {
      "animal-origin": "No substances derived from animals in the product or its components.",
      "animal-welfare": "No animal testing by or for the brand, and cross-contamination kept to a minimum.",
      "chain-of-custody": "A traceable supply chain for the product.",
    },
  },
  {
    id: "peta-vegan",
    short: "PETA Vegan",
    title: "PETA-Approved Vegan",
    ref: "PETA",
    url: "https://corporate.peta.de/en/?p=960",
    category: "animal",
    scope: "Marks textiles free of animal materials, after a review of the company by PETA.",
    data: {
      "animal-origin": "Free of animal materials.",
    },
  },

  // ---------- Chemical safety ----------
  {
    id: "oeko-100",
    short: "STANDARD 100",
    title: "OEKO-TEX STANDARD 100",
    ref: "OEKO-TEX Association",
    url: "https://www.oeko-tex.com/en/our-standards/oeko-tex-standard-100",
    category: "chemicalSafety",
    scope: "Tests all components for harmful substances, from yarn to finished product. It does not address organic content or working conditions.",
    data: {
      "restricted-substances": "Tested against a list of over 1,000 harmful substances, covering REACH Annexes XIV and XVII among others.",
      "substances-of-concern": "Covers the ECHA candidate list of substances of very high concern.",
      verification: "Globally standardised laboratory tests, with limits reviewed at least yearly.",
      label: "Each label can be checked online.",
    },
  },
  {
    id: "oeko-mig",
    short: "MADE IN GREEN",
    title: "OEKO-TEX MADE IN GREEN",
    ref: "OEKO-TEX Association",
    url: "https://www.oeko-tex.com/en/our-standards/oeko-tex-made-in-green",
    category: "chemicalSafety",
    scope: "Textiles and leather tested for harmful substances and traceable to socially responsible, environmentally managed production.",
    data: {
      "restricted-substances": "Tested for harmful substances.",
      "process-emissions": "Verified chemical management and wastewater quality.",
      "working-conditions": "Fair wages, regular working hours and workplace safety.",
      "production-site": "Traceable to production through the OEKO-TEX Label Check.",
      label: "Each label can be checked online.",
    },
  },
  {
    id: "bluesign",
    short: "bluesign",
    title: "bluesign product",
    ref: "bluesign technologies",
    url: "https://www.bluesign.com/verify",
    category: "chemicalSafety",
    scope: "Independent certification of consumer products, articles and chemicals, working through the textile value chain from chemicals onward.",
    data: {
      "restricted-substances": "Chemical inventories and safer chemistry assessed along the value chain.",
      verification: "Independent certification on verified primary data; products can be looked up online.",
    },
  },

  // ---------- Ecolabels and multi-issue ----------
  {
    id: "eu-ecolabel",
    short: "EU Ecolabel",
    title: "EU Ecolabel for textile products",
    ref: "Commission Decision 2014/350/EU, valid until 31 December 2028",
    url: "https://eur-lex.europa.eu/eli/dec/2014/350/oj",
    category: "ecolabel",
    scope: "The EU's official ecolabel, with criteria on fibres, chemicals and processes, fitness for use and social responsibility.",
    data: {
      "material-composition": "Criteria per fibre type, including cotton, wool, polyester and man-made cellulose.",
      "organic-content": "Extra label text allowed above set shares of organic or integrated pest management cotton.",
      "recycled-content": "Extra label text allowed above a minimum recycled content for synthetic fibres.",
      "restricted-substances": "A Restricted Substance List for the product and production recipes.",
      "process-emissions": "Treatment of emissions to air and water.",
      "energy-resources": "Washing, drying and curing energy efficiency.",
      durability: "Dimensional change, colour fastness, pilling, abrasion and durability of function.",
      "working-conditions": "Fundamental principles and rights at work.",
      label: "Sets the information appearing on the Ecolabel.",
    },
  },
  {
    id: "nordic-swan",
    short: "Nordic Swan",
    title: "Nordic Swan Ecolabel for clothing, textiles and leather",
    ref: "Nordic Ecolabelling, criteria 039 v5.9",
    url: "https://svanemerket.no/krav/the-nordic-swan-ecolabel-environmental-requirements-for-clothing-textiles-and-leather/",
    category: "ecolabel",
    scope: "The official Nordic ecolabel, licensed separately for products and for manufacturing. Shoes fall under other criteria.",
    data: {
      "organic-content": "Fibres must be organic, recycled or from renewable resources.",
      "recycled-content": "Fibres must be organic, recycled or from renewable resources.",
      "restricted-substances": "Bans carcinogens, reprotoxic and mutagenic substances, halogenated flame retardants, fluorinated and antibacterial additives.",
      "energy-resources": "Factories apply best available water and energy techniques.",
      durability: "Tested for dimensional change, colour fastness and abrasion.",
      "working-conditions": "Production complies with ILO conventions on workers' rights.",
    },
  },
  {
    id: "blue-angel",
    short: "Blue Angel",
    title: "Blue Angel for environmentally friendly textiles",
    ref: "German Environment Agency, DE-UZ 154, edition 2023",
    url: "https://www.blauer-engel.de/en/productworld/textiles",
    category: "ecolabel",
    scope: "Germany's government ecolabel, for products of at least 90% textile fibres by weight, and 70% for bags.",
    data: {
      "organic-content": "Natural fibres from controlled organic cultivation or animal husbandry, without genetically modified organisms.",
      "recycled-content": "At least 50% recycled in staple fibre blends and 20% in filament fibres.",
      "restricted-substances": "A low level of harmful materials.",
      "process-emissions": "Limits on emissions in production wastewater.",
      "animal-welfare": "Does not permit mulesing.",
      "forced-labour": "Shuns forced labour.",
      "working-conditions": "Takes social aspects of production into account, including minimum working age.",
      durability: "Durability is part of the label's promise.",
    },
  },
  {
    id: "green-button",
    short: "Green Button",
    title: "Green Button (Grüner Knopf)",
    ref: "German government",
    url: "https://www.gruener-knopf.de/en",
    category: "ecolabel",
    scope: "A government-run label that certifies the company and the product together. Product proof rests on recognised labels such as GOTS, Fairtrade and STANDARD 100.",
    data: {
      "forced-labour": "Company criteria on human rights and environmental due diligence, and a ban on forced labour.",
      "working-conditions": "Minimum wage, working hours, freedom of association, health and safety.",
      "restricted-substances": "Bans hazardous chemicals, with pollutant testing of natural fibres.",
      "process-emissions": "Wastewater limits and monitoring of air pollution and CO2.",
      verification: "Independent audit of the company, with credible labels as proof for the product.",
    },
  },
  {
    id: "c2c",
    short: "Cradle to Cradle",
    title: "Cradle to Cradle Certified",
    ref: "Cradle to Cradle Products Innovation Institute",
    url: "https://c2ccertified.org/the-standard",
    category: "ecolabel",
    scope: "Multi-attribute standard for materials and products in general, not only textiles.",
    data: {
      "restricted-substances": "The Material Health category.",
      recyclability: "The Product Circularity category.",
      "carbon-footprint": "The Clean Air & Climate Protection category.",
      "process-emissions": "The Water & Soil Stewardship category.",
      "working-conditions": "The Social Fairness category.",
    },
  },

  // ---------- Forest fibres ----------
  {
    id: "fsc",
    short: "FSC",
    title: "FSC for fashion",
    ref: "Forest Stewardship Council",
    url: "https://fsc.org/en/fashion",
    category: "forest",
    scope: "For forest-based fibres such as viscose, lyocell and modal. FSC Recycled is not yet extended to textiles.",
    data: {
      "material-composition": "Man-made cellulosic fibres sourced from responsibly managed forests.",
      "chain-of-custody": "Manufacturers hold chain-of-custody certification to trade FSC materials.",
      label: "FSC trademarks for certified companies; brands and retailers promote finished goods under a licence.",
    },
  },
];

export const CONSUMER_LABELS: Legislation[] = LABELS.map((l) => ({
  id: l.id,
  short: l.short,
  title: l.title,
  ref: l.ref,
  type: "b2c",
  url: l.url,
  category: l.category,
  scope: { textile: l.scope },
}));

/** A scheme's own document stands behind its data requirements, so none reads as "no standard found". */
export const LABEL_STANDARDS: Standard[] = LABELS.map((l) => ({
  id: `label-${l.id}`,
  ref: l.short,
  title: l.title,
  body: l.ref,
  kind: "scheme",
  url: l.url,
}));

export const LABEL_PROVISIONS: Provision[] = LABELS.flatMap((l) =>
  Object.entries(l.data).map(([dataRequirement, text]) => ({
    dataRequirement,
    legislation: l.id,
    groups: TEXTILE,
    ref: l.short,
    text,
    url: l.url,
  })),
);

export const LABEL_LINKS: StandardLink[] = LABELS.flatMap((l) =>
  Object.keys(l.data).map((dataRequirement) => ({
    legislation: l.id,
    standard: `label-${l.id}`,
    dataRequirement,
    basis: "inferred",
    note: "What the scheme asks for.",
  })),
);
