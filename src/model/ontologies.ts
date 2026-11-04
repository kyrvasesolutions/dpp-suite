/**
 * Open vocabularies that define the data requirements, with each term's definition
 * word for word as its publisher gives it (`npm run check-ontology-terms` verifies
 * them against the published files).
 *
 * Terms come from the most formal source that defines the concept: ontologies and
 * web vocabularies first, then a thesaurus or knowledge base where those have no
 * term. Only sources under an open licence are used.
 */

export interface Ontology {
  id: string;
  name: string;
  uri: string;
  description: string;
  license: string;
  /** The licence, or the page stating it when the source doesn't name a version. */
  licenseUrl: string;
  /** When the definitions were copied. */
  retrieved: string;
}

export interface OntologyTerm {
  id: string;
  ontology: string;
  /** The label as published, even where it reads like code, e.g. "productID". */
  label: string;
  uri: string;
  /** Copied word for word; a leading part of the published text when the rest is only usage notes. */
  definition: string;
}

/**
 * How the term relates to the data requirement, after SKOS mapping properties:
 * exact and close match, a term broader than the data requirement, or a narrower one.
 */
export type TermMatch = "exact" | "close" | "broad" | "narrow";

export interface RequirementTerm {
  dataRequirement: string;
  term: string;
  match: TermMatch;
  /** Our reading of where the term and the data requirement differ. */
  note?: string;
}

const RETRIEVED = "2026-11-04";

export const ONTOLOGIES: Ontology[] = [
  {
    id: "schema",
    name: "Schema.org",
    uri: "https://schema.org/",
    description: "Shared vocabulary for structured data on the web.",
    license: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
    retrieved: RETRIEVED,
  },
  {
    id: "gs1",
    name: "GS1 Web Vocabulary",
    uri: "https://ref.gs1.org/voc/",
    description: "Ontology of product, party and regulatory data for GS1 identified goods.",
    license: "Apache-2.0",
    licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    retrieved: RETRIEVED,
  },
  {
    id: "untp",
    name: "UN Transparency Protocol",
    uri: "https://vocabulary.uncefact.org/untp/",
    description: "UN/CEFACT vocabulary behind digital product passports and conformity credentials.",
    license: "GPL-3.0",
    licenseUrl: "https://github.com/uncefact/spec-untp/blob/main/LICENSE",
    retrieved: RETRIEVED,
  },
  {
    id: "oeo",
    name: "Open Energy Ontology",
    uri: "https://openenergyplatform.org/ontology/oeo/",
    description: "OWL ontology of energy systems, emissions and their economics.",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    retrieved: RETRIEVED,
  },
  {
    id: "ncit",
    name: "NCI Thesaurus OBO Edition",
    uri: "http://purl.obolibrary.org/obo/ncit.owl",
    description: "OWL edition of the National Cancer Institute's reference terminology, in the OBO Foundry.",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    retrieved: RETRIEVED,
  },
  {
    id: "gemet",
    name: "GEMET",
    uri: "https://www.eionet.europa.eu/gemet/",
    description: "The European Environment Agency's General Multilingual Environmental Thesaurus. A thesaurus rather than a formal ontology.",
    license: "CC BY",
    licenseUrl: "https://www.eea.europa.eu/en/legal-notice",
    retrieved: RETRIEVED,
  },
  {
    id: "wikidata",
    name: "Wikidata",
    uri: "https://www.wikidata.org/",
    description: "Community-edited knowledge base. Its descriptions are short and can change.",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    retrieved: RETRIEVED,
  },
];

const schema = (local: string, label: string, definition: string): OntologyTerm => ({
  id: `schema:${local}`,
  ontology: "schema",
  label,
  uri: `https://schema.org/${local}`,
  definition,
});

const gs1 = (local: string, label: string, definition: string): OntologyTerm => ({
  id: `gs1:${local}`,
  ontology: "gs1",
  label,
  uri: `https://ref.gs1.org/voc/${local}`,
  definition,
});

const untp = (local: string, label: string, definition: string): OntologyTerm => ({
  id: `untp:${local}`,
  ontology: "untp",
  label,
  uri: `https://vocabulary.uncefact.org/untp/${local}`,
  definition,
});

const oeo = (local: string, label: string, definition: string): OntologyTerm => ({
  id: `oeo:${local}`,
  ontology: "oeo",
  label,
  uri: `https://openenergyplatform.org/ontology/oeo/${local}`,
  definition,
});

const ncit = (local: string, label: string, definition: string): OntologyTerm => ({
  id: `ncit:${local}`,
  ontology: "ncit",
  label,
  uri: `http://purl.obolibrary.org/obo/NCIT_${local}`,
  definition,
});

const gemet = (local: string, label: string, definition: string): OntologyTerm => ({
  id: `gemet:${local}`,
  ontology: "gemet",
  label,
  uri: `http://www.eionet.europa.eu/gemet/concept/${local}`,
  definition,
});

const wikidata = (local: string, label: string, definition: string): OntologyTerm => ({
  id: `wikidata:${local}`,
  ontology: "wikidata",
  label,
  uri: `https://www.wikidata.org/wiki/${local}`,
  definition,
});

export const ONTOLOGY_TERMS: OntologyTerm[] = [
  schema("productID", "productID", "The product identifier, such as ISBN."),
  schema("material", "material", "A material that something is made from, e.g. leather, wool, cotton, paper."),
  schema(
    "substanceOfConcern",
    "substanceOfConcern",
    "A substance of concern (SoC) contained within the product, typically based on regulatory lists like REACH or RoHS.",
  ),
  schema("recycledContentPercentage", "recycledContentPercentage", "The percentage of recycled material in the product."),
  schema(
    "DeclarationOfConformity",
    "DeclarationOfConformity",
    "A Declaration of Conformity (DoC), a formal document issued by a manufacturer declaring that a product meets specific regulatory requirements.",
  ),
  schema(
    "DigitalProductPassport",
    "DigitalProductPassport",
    "A digital product passport (DPP), a record containing information about a product's lifecycle, sustainability, and compliance.",
  ),

  gs1("manufacturer", "Has Manufacturer", "The organization that produces the item."),
  gs1(
    "OrganizationRoleType-IMPORTER",
    "Importer",
    "Organization who makes - or on whose behalf a Customs clearing agent or other authorized person makes - an import declaration. This may include a person who has possession of the goods or to whom the goods are consigned.",
  ),
  gs1(
    "RegulationTypeCode-TREATED_WITH_BIOCIDE_REGULATION",
    "Biocide regulation treated article",
    "Regulation (e.g., EU Reg 528/2012) harmonising the rules on making available on the market and trade items treated with biocidal products ('treated articles'), whilst ensuring a high level of protection of both human and animal health and the environment.",
  ),
  gs1(
    "consumerRecyclingInstructions",
    "Consumer Recycling Instructions",
    "Expresses in text the consumer recycling instructions which are normally held on the label or accompanying the product. Instructions may refer to the 'how' the consumer is supposed to sort the product and packaging materials for recycling.",
  ),
  gs1("countryOfOrigin", "Has Country Of Origin", "Code indicating the country of origin of the product."),
  gs1(
    "RegulatoryIdentifierType-DUE_DILIGENCE_STATEMENT",
    "Due Diligence Statement",
    "A document or dataset that states the due diligence activities undertaken by a person or organization to meet regulatory compliance requirements.",
  ),
  gs1(
    "consumerUsageInstructions",
    "Consumer Usage Instructions",
    "Free text containing the usage instructions of a product, which are normally held on the label or accompanying the product.",
  ),
  gs1("consumerSafetyInformation", "Consumer Safety Information", "Information on consumer safety regarding the product."),

  untp(
    "registeredId",
    "registeredId",
    "The registration number (alphanumeric) of the Party within the register. Unique within the register.",
  ),
  untp(
    "massFraction",
    "massFraction",
    "The mass fraction as a decimal of the product (or facility reporting period) represented by this material.",
  ),
  untp("quantity", "quantity", "The quantity of product subject to this lifecycle event."),
  untp(
    "ProductStatus#disposed",
    "Disposed",
    "Product has reached end of life and has been disposed of or destroyed without material recovery.",
  ),
  untp("Facility", "Facility", "The physical site (eg farm or factory) where the product or materials was produced."),
  untp("Party", "Party", "An organisation. May be a supply chain actor, a certifier, a government agency."),
  untp("AssessorLevel#3rdParty", "Independent third party assessment", "3rd party (independent) conformity assessment"),
  untp(
    "Performance",
    "Performance",
    "A claimed, assessed, or required performance level defined either by a scoring system or a numeric measure.",
  ),

  oeo(
    "OEO_00000147",
    "emission",
    "emission is a process releasing by-products from human activity (e.g. production, distribution or consumption) into the environment.",
  ),
  oeo("OEO_00010210", "energy use", "Energy use is the consumption of an energy carrier making use of the energy it carries."),
  oeo("OEO_00010269", "CO2 price", "A CO2 price is an emission price of emitting a certain CO2 emission value."),

  ncit("C48044", "Precursor", "A substance from which another substance is formed."),
  ncit("C43361", "Barcode", "A machine-readable representation of information in a visual format on a surface."),

  gemet("15155", "environmental footprint", "environmental impact of a product, a service, and/or a company, over its lifecycle"),
  gemet(
    "15279",
    "resource use",
    "appropriation and use of resources, ecosystems and naturally occurring materials, such as soil, wood, water, and minerals",
  ),
  gemet(
    "3854",
    "hazardous substance",
    "Any material that poses a threat to human health and/or the environment. Typical hazardous substances are toxic, corrosive, ignitable, explosive, or chemically reactive.",
  ),
  gemet(
    "7009",
    "recyclability",
    "Characteristic of materials that still have useful physical or chemical properties after serving their original purpose and that can, therefore, be reused or remanufactured into additional products.",
  ),
  gemet(
    "4566",
    "labelling",
    "Attaching a notice to a product or container bearing information concerning its contents, proper use, manufacturer and any cautions or hazards of use.",
  ),

  wikidata(
    "Q55237506",
    "Harmonized System Code",
    "identifier of a good, product or object that may be traded internationally and is classified in the Harmonized System",
  ),
  wikidata("Q629103", "animal product", "material derived from the bodies of animals"),
  wikidata(
    "Q310667",
    "carbon footprint",
    "total set of greenhouse gas emissions caused by an individual, event, organisation, or product, expressed as carbon dioxide equivalent",
  ),
  wikidata("Q6839919", "microplastics", "fragments of plastic less than 5 mm in length"),
  wikidata(
    "Q10269116",
    "durability",
    "ability of an item to perform its role over a long period of time under potentially challenging conditions",
  ),
  wikidata("Q30748592", "repairability", "the degree to which something can be repaired, including the ease of doing so"),
  wikidata("Q705818", "forced labor", "work people are employed in, but against their will"),
];

export const REQUIREMENT_TERMS: RequirementTerm[] = [
  {
    dataRequirement: "product-id",
    term: "schema:productID",
    match: "close",
    note: "Names the identifier; says nothing of the uniqueness or persistence ESPR asks for.",
  },
  {
    dataRequirement: "commodity-code",
    term: "wikidata:Q55237506",
    match: "close",
    note: "The CN code used in the EU extends this six-digit code.",
  },
  {
    dataRequirement: "manufacturer",
    term: "gs1:manufacturer",
    match: "close",
    note: "Defines the party, not its contact details.",
  },
  {
    dataRequirement: "importer",
    term: "gs1:OrganizationRoleType-IMPORTER",
    match: "close",
    note: "Defines the importer, not the EU responsible operator.",
  },
  {
    dataRequirement: "producer-registration",
    term: "untp:registeredId",
    match: "close",
    note: "A number in any register; the acts mean national registers of producers.",
  },

  { dataRequirement: "material-composition", term: "schema:material", match: "close", note: "The material itself." },
  {
    dataRequirement: "material-composition",
    term: "untp:massFraction",
    match: "close",
    note: "The share of the product that material makes up.",
  },
  {
    dataRequirement: "animal-origin",
    term: "wikidata:Q629103",
    match: "broad",
    note: "Any material from animals, not only non-textile parts.",
  },
  {
    dataRequirement: "substances-of-concern",
    term: "schema:substanceOfConcern",
    match: "close",
    note: "Pending in Schema.org. ESPR sets its own legal definition.",
  },
  {
    dataRequirement: "restricted-substances",
    term: "gemet:3854",
    match: "broad",
    note: "No open vocabulary we searched defines a restricted substance; this is the wider class restrictions draw from.",
  },
  {
    dataRequirement: "biocidal-treatment",
    term: "gs1:RegulationTypeCode-TREATED_WITH_BIOCIDE_REGULATION",
    match: "close",
    note: "Defines the rule for treated articles, not the data their label must carry.",
  },

  {
    dataRequirement: "carbon-footprint",
    term: "wikidata:Q310667",
    match: "close",
    note: "Embedded emissions under CBAM have a narrower boundary.",
  },
  { dataRequirement: "environmental-footprint", term: "gemet:15155", match: "exact" },
  {
    dataRequirement: "process-emissions",
    term: "oeo:OEO_00000147",
    match: "broad",
    note: "Any emission from human activity; the production route has no term of its own.",
  },
  { dataRequirement: "energy-resources", term: "oeo:OEO_00010210", match: "close", note: "The energy part." },
  { dataRequirement: "energy-resources", term: "gemet:15279", match: "close", note: "The resource part." },
  {
    dataRequirement: "precursors",
    term: "ncit:C48044",
    match: "broad",
    note: "A chemical sense; CBAM precursors are input goods with embedded emissions.",
  },
  {
    dataRequirement: "carbon-price",
    term: "oeo:OEO_00010269",
    match: "close",
    note: "CBAM counts only a price paid in the country of origin.",
  },
  {
    dataRequirement: "microplastics",
    term: "wikidata:Q6839919",
    match: "close",
    note: "Defines the particles, not their release.",
  },

  {
    dataRequirement: "recycled-content",
    term: "schema:recycledContentPercentage",
    match: "exact",
    note: "Pending in Schema.org.",
  },
  { dataRequirement: "durability", term: "wikidata:Q10269116", match: "exact" },
  { dataRequirement: "repairability", term: "wikidata:Q30748592", match: "exact" },
  {
    dataRequirement: "recyclability",
    term: "gemet:7009",
    match: "close",
    note: "Describes materials; ESPR also looks at design for recycling.",
  },
  {
    dataRequirement: "end-of-life-info",
    term: "gs1:consumerRecyclingInstructions",
    match: "close",
    note: "Consumer recycling and sorting only, not deconstruction or disposal information.",
  },
  {
    dataRequirement: "quantities",
    term: "untp:quantity",
    match: "broad",
    note: "The quantity in any lifecycle event; no open term covers quantities placed on the market.",
  },
  {
    dataRequirement: "unsold-products",
    term: "untp:ProductStatus#disposed",
    match: "broad",
    note: "Any disposed product; no open term separates unsold ones.",
  },

  { dataRequirement: "production-site", term: "gs1:countryOfOrigin", match: "close", note: "The country." },
  { dataRequirement: "production-site", term: "untp:Facility", match: "close", note: "The site." },
  {
    dataRequirement: "supply-chain-operators",
    term: "untp:Party",
    match: "broad",
    note: "Any party, of which supply-chain actors are one kind.",
  },
  {
    dataRequirement: "forced-labour",
    term: "wikidata:Q705818",
    match: "close",
    note: "The Forced Labour Regulation defines the term through ILO conventions.",
  },
  {
    dataRequirement: "forced-labour",
    term: "gs1:RegulatoryIdentifierType-DUE_DILIGENCE_STATEMENT",
    match: "close",
    note: "The due diligence part.",
  },

  {
    dataRequirement: "conformity",
    term: "schema:DeclarationOfConformity",
    match: "close",
    note: "Pending in Schema.org. Does not cover the declaration of performance under the CPR.",
  },
  { dataRequirement: "verification", term: "untp:AssessorLevel#3rdParty", match: "exact" },
  {
    dataRequirement: "performance",
    term: "untp:Performance",
    match: "close",
    note: "A performance level; the acts also cover the characteristics behind it.",
  },
  {
    dataRequirement: "dpp",
    term: "schema:DigitalProductPassport",
    match: "exact",
    note: "Pending in Schema.org.",
  },
  {
    dataRequirement: "dpp",
    term: "ncit:C43361",
    match: "narrow",
    note: "The data carrier part: barcodes are one kind, and ESPR allows others.",
  },
  { dataRequirement: "instructions", term: "gs1:consumerUsageInstructions", match: "close", note: "Instructions for use." },
  { dataRequirement: "instructions", term: "gs1:consumerSafetyInformation", match: "close", note: "Safety information." },
  {
    dataRequirement: "label",
    term: "gemet:4566",
    match: "close",
    note: "The act of labelling rather than the label.",
  },
];
