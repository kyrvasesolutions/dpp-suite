/**
 * Standards the legislations in `legislation.ts` name, where they name them, and
 * which data requirement each one bears on.
 *
 * What counts: a specific document a standards body or international organisation
 * publishes, named in the act's text and used as a benchmark for one of its rules.
 * Union law, nomenclatures (IUPAC, CAS), passing mentions of treaties, and generic
 * wording such as "harmonised standards" do not count.
 *
 * `excerpt` is copied word for word from the act; `npm run check-legal-text` verifies
 * it, fails on any standard reference in the acts that is missing here, and fails
 * if two different excerpts cover overlapping text. Standards the act names in one
 * sentence share the same excerpt, and the app shows that passage once.
 * `title` is the act's own wording where it gives one, otherwise the publisher's.
 *
 * Only the latest version of a standard is kept. Where an act also names an older
 * version, that reference is left out, and `npm run build-seed` fails if two versions
 * of one standard are recorded.
 *
 * `STANDARD_TARGETS` holds the second kind of relation: standards no act names, but
 * whose own scope targets a data requirement. They carry no legal weight from the
 * acts, rest on a publisher or catalogue page rather than an excerpt, and are our
 * reading. The list is what we could verify, not everything that exists.
 */
import type { ProductGroup } from "./legislation";


export type StandardKind = "technical" | "test-guideline" | "guideline" | "convention" | "scheme";

export interface Standard {
  id: string;
  /** Reference as published, e.g. "ISO/IEC 15459-4:2014". */
  ref: string;
  title?: string;
  /** Publishing body. */
  body: string;
  kind: StandardKind;
}

/** Operative: in an article or annex. Recital: in the preamble, so not binding by itself. */
export type CitationForce = "operative" | "recital";

/** One place a legislation names a standard. */
export interface Citation {
  legislation: string;
  standard: string;
  /** Article, annex, point or recital. */
  provision: string;
  force: CitationForce;
  /** Word for word from the act. */
  excerpt: string;
  /** The reference as the act writes it, when it differs from `Standard.ref`. */
  citedAs?: string;
  /** CELEX number of the act quoted, when it is an implementing or amending act rather than the legislation itself. */
  source?: string;
}

/**
 * Stated: the cited passage names the data, or the provision behind it.
 * Inferred: our reading of what the standard is used for; the passage does not say so itself.
 */
export type LinkBasis = "stated" | "inferred";

/** A standard behind a data requirement, on the path through one legislation. */
export interface StandardLink {
  legislation: string;
  standard: string;
  dataRequirement: string;
  basis: LinkBasis;
  /** Why this standard bears on this data requirement. */
  note: string;
  /** The citations this link rests on, by provision; all of the pair's citations when absent. */
  provisions?: string[];
}

const iso15459 = (part: number, year: number, title: string): Standard => ({
  id: `iso-iec-15459-${part}`,
  ref: `ISO/IEC 15459-${part}:${year}`,
  title: `Information technology — Automatic identification and data capture techniques — Unique identification — Part ${part}: ${title}`,
  body: "ISO/IEC",
  kind: "technical",
});

const stationary = "Stationary source emissions";
const azoLeather = "Leather – Chemical tests for the determination of certain azo colorants in dyed leathers";
const azoTextile = "Textiles – Methods for determination of certain aromatic amines derived from azo colorants";
const indoorAir = "Construction products – Assessment of release of dangerous substances – Determination of emissions into indoor air";

const iso = (id: string, ref: string, title?: string): Standard => ({ id, ref, title, body: "ISO", kind: "technical" });
const cen = (id: string, ref: string, title?: string): Standard => ({ id, ref, title, body: "CEN", kind: "technical" });
const oecd = (number: string, title: string): Standard => ({
  id: `oecd-tg-${number.toLowerCase()}`,
  ref: `OECD TG ${number}`,
  title,
  body: "OECD",
  kind: "test-guideline",
});

const jtc24 = (id: string, ref: string, title: string): Standard => ({ id, ref, title, body: "CEN/CLC/JTC 24", kind: "technical" });
const scheme = (id: string, ref: string, title: string, body: string): Standard => ({ id, ref, title, body, kind: "scheme" });
const iec = (id: string, ref: string, title: string): Standard => ({ id, ref, title, body: "ISO/IEC", kind: "technical" });

export const STANDARDS: Standard[] = [
  // Unique identifiers
  iso15459(1, 2014, "Individual transport units"),
  iso15459(2, 2015, "Registration procedures"),
  iso15459(3, 2014, "Common rules"),
  iso15459(4, 2014, "Individual products and product packages"),
  iso15459(5, 2014, "Individual returnable transport items (RTIs)"),
  iso15459(6, 2014, "Groupings"),

  // Digital product passport: CEN/CLC/JTC 24, cited in the Official Journal
  jtc24("en-18216-2026", "EN 18216:2026", "Digital product passport – Data exchange protocols"),
  jtc24("en-18219-2026", "EN 18219:2026", "Digital product passport – Unique identifiers"),
  jtc24("en-18220-2026", "EN 18220:2026", "Digital product passport – Data carriers"),
  jtc24("en-18221-2026", "EN 18221:2026", "Digital product passport – Data storage, archiving, and persistence"),
  jtc24("en-18222-2026", "EN 18222:2026", "Digital Product Passport – Application Programming Interfaces (APIs) for product passport lifecycle management and searchability"),
  jtc24("en-18223-2026", "EN 18223:2026", "Digital Product Passport – System interoperability"),

  // Digital product passport: CEN/CLC/JTC 24, published but not in that decision
  jtc24("en-18239-2026", "EN 18239:2026", "Digital product passport - Access rights management, information system security, and business confidentiality"),
  jtc24("en-18246-2026", "EN 18246:2026", "Digital product passport - Data authentication, reliability and integrity"),

  // Labels, footprint and packaging
  cen("en-iso-14024", "EN ISO 14024", "Environmental labels and declarations — Type I environmental labelling — Principles and procedures"),
  cen("en-15804", "EN 15804", "Sustainability of construction works — Environmental product declarations — Core rules for the product category of construction products"),
  cen("en-13432-2000", "EN 13432:2000", "Packaging – Requirements for packaging recoverable by composting and biodegradation – Test scheme and evaluation criteria for final acceptance of packaging"),
  cen("en-13428-2004", "EN 13428:2004", "Packaging – Requirements specific to manufacturing and composition – Prevention by source reduction"),
  iso("iso-14001", "ISO 14001", "Environmental management systems — Requirements with guidance for use"),

  // Emissions monitoring
  { id: "iso-iec-17025", ref: "ISO/IEC 17025", title: "General requirements for the competence of testing and calibration laboratories", body: "ISO/IEC", kind: "technical" },
  iso("iso-13833", "ISO 13833", `${stationary} – Determination of the ratio of biomass (biogenic) and fossil-derived carbon dioxide – Radiocarbon sampling and determination`),
  iso("iso-18466", "ISO 18466", `${stationary} – Determination of the biogenic fraction in CO2 in stack gas using the balance method`),
  iso("iso-20181-2023", "ISO 20181:2023", `${stationary} – Quality assurance of automated measuring systems`),
  iso("iso-14164-1999", "ISO 14164:1999", `${stationary} – Determination of the volume flowrate of gas streams in ducts – Automated method`),
  iso("iso-16911-2", "ISO 16911-2", `${stationary} – Manual and automatic determination of velocity and volume flow rate in ducts`),
  { id: "ipcc-2006", ref: "IPCC 2006 Guidelines", title: "IPCC 2006 Guidelines for National Greenhouse Gas Inventories", body: "IPCC", kind: "guideline" },
  { id: "iai-guidelines", ref: "IAI guidelines", title: "Guidelines provided by the International Aluminium Institute on perfluorocarbon emissions", body: "International Aluminium Institute", kind: "guideline" },

  // Azo colourants (REACH Annex XVII, Appendix 10)
  cen("en-iso-17234-1-2015", "EN ISO 17234-1:2015", `${azoLeather} – Part 1: Determination of certain aromatic amines derived from azo colorants`),
  cen("en-iso-17234-2-2011", "EN ISO 17234-2:2011", `${azoLeather} – Part 2: Determination of 4-aminoazobenzene`),
  cen("en-iso-14362-1-2017", "EN ISO 14362-1:2017", `${azoTextile} – Part 1: Detection of the use of certain azo colorants accessible with and without extracting the fibres`),
  cen("en-iso-14362-3-2017", "EN ISO 14362-3:2017", `${azoTextile} – Part 3: Detection of the use of certain azo colorants, which may release 4-aminoazobenzene`),

  // Other REACH restrictions and annexes
  iso("iso-10156", "ISO 10156", "Gases and gas mixtures – Determination of fire potential and oxidizing ability for the selection of cylinder valve outlets"),
  cen("en-14059", "EN 14059", "Decorative oil lamps"),
  cen("en-16143-2013", "EN 16143:2013", "Petroleum products — Determination of content of Benzo(a)pyrene (BaP) and selected polycyclic aromatic hydrocarbons (PAH) in extender oils — Procedure using double LC cleaning and GC/MS analysis"),
  iso("iso-21461", "ISO 21461", "Rubber vulcanised — Determination of aromaticity of oil in vulcanised rubber compounds"),
  cen("en-14387", "EN 14387", "Respiratory protective devices - Gas filter(s) and combined filter(s) - Requirements, testing, marking"),
  cen("en-15343-2007", "EN 15343:2007", "Plastics - Recycled Plastics - Plastics recycling traceability and assessment of conformity and recycled content"),
  cen("en-16516", "EN 16516", indoorAir),
  iso("iso-12219-1", "ISO 12219-1", "Interior air of road vehicles – Part 1: Whole vehicle test chamber – Specification and method for the determination of volatile organic compounds in cabin interiors"),
  iso("iso-12219-10", "ISO 12219-10", "Interior air of road vehicles – Part 10: Whole vehicle test chamber – Specification and methods for the determination of volatile organic compounds in cabin interiors – Trucks and buses"),
  { id: "din-52025", ref: "DIN 52025", title: "Softening point of pitch", body: "DIN", kind: "technical" },
  { id: "astm-d4359-90", ref: "ASTM D 4359-90", title: "Standard Test Method for Determining Whether a Material Is a Liquid or a Solid", body: "ASTM", kind: "technical" },

  // Biodegradation of polymers (REACH Annex XVII, Appendix 15)
  cen("en-iso-14852-2021", "EN ISO 14852:2021", "Determination of the ultimate aerobic biodegradability of plastic materials in an aqueous medium – Method by analysis of evolved carbon dioxide."),
  cen("en-iso-14851-2019", "EN ISO 14851:2019", "Determination of the ultimate aerobic biodegradability of plastic materials in an aqueous medium – Method by measuring the oxygen demand in a closed respirometer."),
  cen("en-iso-19679-2020", "EN ISO 19679:2020", "Plastics – Determination of aerobic biodegradation of non-floating plastic materials in seawater/sediment interface – Method by analysis of evolved carbon dioxide"),
  cen("en-iso-18830-2016", "EN ISO 18830:2016", "Plastics – Determination of aerobic biodegradation of non-floating plastic materials in seawater/sandy sediment interface – Method by measuring the oxygen demand in closed respirometer"),
  cen("en-iso-17556-2019", "EN ISO 17556:2019", "Plastics – Determination of the ultimate aerobic biodegradability of plastic materials in soil by measuring the oxygen demand in a respirometer or the amount of carbon dioxide evolved"),
  iso("iso-22404-2019", "ISO 22404:2019", "Plastics – Determination of the aerobic biodegradation of non-floating materials exposed to marine sediment – Method by analysis of evolved carbon dioxide"),
  iso("iso-22403-2020", "ISO 22403:2020", "Plastics – Assessment of the intrinsic biodegradability of materials exposed to marine inocula under mesophilic aerobic laboratory conditions – Test methods and requirements"),

  // OECD test guidelines
  oecd("421", "Reproduction/Developmental Toxicity Screening Test"),
  oecd("422", "Combined Repeated Dose Toxicity Study with the Reproduction/Developmental Toxicity Screening Test"),
  oecd("414", "Pre-natal developmental toxicity study"),
  oecd("443", "Extended One-Generation Reproductive Toxicity Study"),
  oecd("416", "Two-Generation Reproductive Toxicity Study"),
  oecd("212", "Fish short-term toxicity tests on embryo and sac-fry stages"),
  oecd("210", "Fish early-life stage (FELS) toxicity test"),
  oecd("215", "Fish juvenile growth test"),
  oecd("301", "Ready Biodegradability"),
  oecd("310", "Ready Biodegradability – CO2 in sealed vessels (Headspace Test)"),
  oecd("306", "Biodegradability in Seawater"),
  oecd("302C", "Inherent Biodegradability: modified MITI Test (II)"),
  oecd("307", "Aerobic and Anaerobic Transformation in Soil"),
  oecd("308", "Aerobic and Anaerobic Transformation in Aquatic Sediment Systems"),
  oecd("309", "Aerobic Mineralisation in Surface Water – Simulation Biodegradation Test"),
  oecd("120", "Solution/Extraction Behaviour of Polymers in Water"),
  oecd("105", "Water Solubility"),
  oecd("428", "Skin Absorption: In vitro Method"),

  // Named by no act: identifiers and traceability
  scheme("gs1-general-specifications", "GS1 General Specifications", "GS1 identification keys, including GTIN and GLN", "GS1"),
  iec("iso-iec-6523", "ISO/IEC 6523", "Information technology — Structure for the identification of organizations and organization parts"),
  iso("iso-17442", "ISO 17442", "Financial services — Legal entity identifier (LEI)"),
  iso("iso-3166-1-2020", "ISO 3166-1:2020", "Codes for the representation of names of countries and their subdivisions — Part 1: Country code"),
  iec("iso-iec-19987-2024", "ISO/IEC 19987:2024", "Information technology — EPC Information Services (EPCIS)"),
  iec("iso-iec-18004", "ISO/IEC 18004", "Information technology — Automatic identification and data capture techniques — QR Code bar code symbology specification"),
  iec("iso-iec-16022", "ISO/IEC 16022", "Information technology — Automatic identification and data capture techniques — Data Matrix bar code symbology specification"),
  { id: "wco-hs-2028", ref: "HS Nomenclature 2028 Edition", title: "Harmonized System nomenclature, in force from 1 January 2028", body: "World Customs Organization", kind: "convention" },

  // Named by no act: composition and substances
  iso("iso-1833-1-2020", "ISO 1833-1:2020", "Textiles — Quantitative chemical analysis — Part 1: General principles of testing"),
  iso("iso-2076-2021", "ISO 2076:2021", "Textiles — Man-made fibres — Generic names"),
  cen("en-573-3-2026", "EN 573-3:2026", "Aluminium and aluminium alloys — Chemical composition and form of wrought products — Part 3: Chemical composition and form of products"),
  iso("iso-14389-2022", "ISO 14389:2022", "Textiles — Determination of the phthalate content — Tetrahydrofuran method"),
  cen("en-17132-2019", "EN 17132:2019", "Textiles and textile products — Determination of polycyclic aromatic hydrocarbons by gas chromatography"),
  iso("iso-14184-1-2011", "ISO 14184-1:2011", "Textiles — Determination of formaldehyde — Part 1: Free and hydrolysed formaldehyde (water extraction method)"),
  iso("iso-18254-1-2016", "ISO 18254-1:2016", "Textiles — Method for the detection and determination of alkylphenol ethoxylates (APEO) — Part 1: Method using HPLC-MS"),
  cen("en-16711-1-2015", "EN 16711-1:2015", "Textiles - Determination of metal content - Part 1: Determination of metals using microwave digestion"),
  cen("en-16711-2-2015", "EN 16711-2:2015", "Textiles - Determination of metal content - Part 2: Determination of metals extracted by acidic artificial perspiration solution"),
  scheme("oeko-tex-standard-100", "OEKO-TEX STANDARD 100", "Testing of textile products and accessories for harmful substances", "OEKO-TEX"),
  scheme("zdhc-mrsl-3-1", "ZDHC MRSL V3.1", "Manufacturing Restricted Substances List", "ZDHC"),
  iso("iso-20743-2021", "ISO 20743:2021", "Textiles — Determination of antibacterial activity of textile products"),
  iso("iso-18184-2025", "ISO 18184:2025", "Textiles — Determination of antiviral activity of textile products"),

  // Named by no act: footprint
  iso("iso-14067-2018", "ISO 14067:2018", "Greenhouse gases — Carbon footprint of products — Requirements and guidelines for quantification"),
  iso("iso-14040-2006", "ISO 14040:2006", "Environmental management — Life cycle assessment — Principles and framework"),
  iso("iso-14044-2006", "ISO 14044:2006", "Environmental management — Life cycle assessment — Requirements and guidelines"),
  iso("iso-14025-2026", "ISO 14025:2026", "Environmental statements and programmes for products — Environmental product declarations (EPDs)"),
  { id: "pef-2021-2279", ref: "Commission Recommendation (EU) 2021/2279", title: "Use of the Environmental Footprint methods to measure and communicate the life cycle environmental performance of products and organisations", body: "European Commission", kind: "guideline" },
  scheme("pefcr-apparel-footwear-3-1", "PEFCR Apparel and Footwear V3.1", "Product Environmental Footprint Category Rules for apparel and footwear", "Sector stakeholders, approved by the European Commission"),
  iso("iso-19694-4-2023", "ISO 19694-4:2023", "Stationary source emissions — Greenhouse gas (GHG) emissions in energy-intensive industries — Part 4: Aluminium industry"),
  iso("iso-14064-1-2018", "ISO 14064-1:2018", "Greenhouse gases — Part 1: Specification with guidance at the organization level for quantification and reporting of greenhouse gas emissions and removals"),
  iso("iso-50001-2018", "ISO 50001:2018", "Energy management systems — Requirements with guidance for use"),
  iso("iso-14046-2014", "ISO 14046:2014", "Environmental management — Water footprint — Principles, requirements and guidelines"),
  iso("iso-4484-1-2023", "ISO 4484-1:2023", "Textiles and textile products — Microplastics from textile sources — Part 1: Determination of material loss from fabrics during washing"),
  iso("iso-4484-2-2023", "ISO 4484-2:2023", "Textiles and textile products — Microplastics from textile sources — Part 2: Qualitative and quantitative analysis of microplastics"),
  iso("iso-4484-3-2023", "ISO 4484-3:2023", "Textiles and textile products — Microplastics from textile sources — Part 3: Measurement of collected material mass released from textile end products by domestic washing method"),

  // Named by no act: circularity
  iso("iso-14021-2016", "ISO 14021:2016", "Environmental labels and declarations — Self-declared environmental claims (Type II environmental labelling)"),
  iso("iso-22095-2020", "ISO 22095:2020", "Chain of custody — General terminology and models"),
  iso("iso-22095-2-2026", "ISO 22095-2:2026", "Chain of custody — Part 2: Requirements and guidelines for mass balance"),
  iso("iso-59020-2024", "ISO 59020:2024", "Circular economy — Measuring and assessing circularity performance"),
  scheme("grs-5-0", "Global Recycled Standard 5.0", "Verification of recycled content and chain of custody", "Textile Exchange"),
  scheme("asi-chain-of-custody-v2", "ASI Chain of Custody Standard V2", "Chain of custody for aluminium, with recycled content as optional sustainability data", "Aluminium Stewardship Initiative"),
  cen("en-45552-2020", "EN 45552:2020", "General method for the assessment of the durability of energy-related products"),
  cen("en-45554", "EN 45554", "General methods for the assessment of the ability to repair, reuse and upgrade energy-related products"),
  cen("en-45555", "EN 45555", "General methods for assessing the recyclability and recoverability of energy-related products"),
  cen("en-45557", "EN 45557", "General method for assessing the proportion of recycled material content in energy-related products"),
  cen("en-45559-2019", "EN 45559:2019", "Methods for providing information relating to material efficiency aspects of energy-related products"),
  cen("en-13430", "EN 13430", "Packaging — Requirements for packaging recoverable by material recycling"),
  iso("iso-12947-2-2016", "ISO 12947-2:2016", "Textiles — Determination of the abrasion resistance of fabrics by the Martindale method — Part 2: Determination of specimen breakdown"),
  iso("iso-12945-2-2020", "ISO 12945-2:2020", "Textiles — Determination of fabric propensity to surface pilling, fuzzing or matting — Part 2: Modified Martindale method"),
  iso("iso-105-c06-2010", "ISO 105-C06:2010", "Textiles — Tests for colour fastness — Part C06: Colour fastness to domestic and commercial laundering"),
  iso("iso-13934-1-2013", "ISO 13934-1:2013", "Textiles — Tensile properties of fabrics — Part 1: Determination of maximum force and elongation at maximum force using the strip method"),
  iso("iso-3758-2023", "ISO 3758:2023", "Textiles — Care labelling code using symbols"),

  // Named by no act: supply chain
  { id: "oecd-garment-footwear", ref: "OECD Garment and Footwear Due Diligence Guidance", title: "OECD Due Diligence Guidance for Responsible Supply Chains in the Garment and Footwear Sector", body: "OECD", kind: "guideline" },
  scheme("sa8000", "SA8000", "Social accountability standard, covering forced labour among its areas", "Social Accountability International"),
  scheme("asi-performance-3-1", "ASI Performance Standard V3.1", "Responsible production of aluminium, with forced labour under criterion 10.3", "Aluminium Stewardship Initiative"),
  iso("iso-26000-2010", "ISO 26000:2010", "Guidance on social responsibility"),
  iso("iso-20400-2017", "ISO 20400:2017", "Sustainable procurement — Guidance"),

  // Named by no act: compliance
  iec("en-iso-iec-17050-1-2010", "EN ISO/IEC 17050-1:2010", "Conformity assessment — Supplier's declaration of conformity — Part 1: General requirements"),
  iec("iso-iec-17065-2012", "ISO/IEC 17065:2012", "Conformity assessment — Requirements for bodies certifying products, processes and services"),
  iec("iso-iec-17029-2019", "ISO/IEC 17029:2019", "Conformity assessment — General principles and requirements for validation and verification bodies"),
  iso("iso-14064-3-2019", "ISO 14064-3:2019", "Greenhouse gases — Part 3: Specification with guidance for the verification and validation of greenhouse gas statements"),
  iso("iso-14065-2020", "ISO 14065:2020", "General principles and requirements for bodies validating and verifying environmental information"),
  cen("en-14351-1-2006-a2-2016", "EN 14351-1:2006+A2:2016", "Windows and doors — Product standard, performance characteristics — Part 1: Windows and external pedestrian doorsets"),
  cen("en-13830-2015-a1-2020", "EN 13830:2015+A1:2020", "Curtain walling — Product standard"),
  { id: "en-iec-ieee-82079-1-2020", ref: "EN IEC/IEEE 82079-1:2020", title: "Preparation of information for use (instructions for use) of products — Part 1: Principles and general requirements", body: "CENELEC", kind: "technical" },

  // International labour standards
  { id: "ilo-c29", ref: "ILO Convention No 29", title: "Forced Labour Convention", body: "ILO", kind: "convention" },
  { id: "ilo-c105", ref: "ILO Convention No 105", title: "Abolition of Forced Labour Convention", body: "ILO", kind: "convention" },
  { id: "ilo-indicators", ref: "ILO indicators of forced labour", body: "ILO", kind: "guideline" },
  { id: "ilo-hard-to-see", ref: "ILO ‘Hard to See, Harder to Count’", title: "ILO guidelines on the signs of forced labour", body: "ILO", kind: "guideline" },
];

const CBAM_METHODS = "32025R2547";
const ANNEX_II = "Annex II, point";

const appendix15 = (standard: string, excerpt: string): Citation => ({
  legislation: "reach",
  standard,
  provision: "Annex XVII, Appendix 15 (entry 78)",
  force: "operative",
  excerpt,
});

const jtc24Citation = (standard: string, no: number, excerpt: string): Citation => ({
  legislation: "espr",
  standard,
  provision: `Annex, no ${no}`,
  force: "operative",
  source: "32026D1736",
  excerpt,
});

export const CITATIONS: Citation[] = [
  // ---------- ESPR: harmonised standards for the passport ----------
  jtc24Citation("en-18216-2026", 1, "EN 18216:2026 Digital product passport – Data exchange protocols"),
  jtc24Citation("en-18219-2026", 2, "EN 18219:2026 Digital product passport – Unique identifiers"),
  jtc24Citation("en-18220-2026", 3, "EN 18220:2026 Digital product passport – Data carriers"),
  jtc24Citation("en-18221-2026", 4, "EN 18221:2026 Digital product passport – Data storage, archiving, and persistence"),
  jtc24Citation("en-18222-2026", 5, "EN 18222:2026 Digital Product Passport – Application Programming Interfaces (APIs) for product passport lifecycle management and searchability"),
  jtc24Citation("en-18223-2026", 6, "EN 18223:2026 Digital Product Passport – System interoperability"),

  // ---------- ESPR ----------
  {
    legislation: "espr",
    standard: "iso-iec-15459-6",
    provision: "Annex III(c)",
    force: "operative",
    citedAs: "ISO/IEC 15459-6",
    excerpt:
      "the Global Trade Identification Number as provided for in International Organization for Standardisation/International Electrotechnical Commission standard ISO/IEC 15459-6 or equivalent of products or their parts",
  },
  ...[
    "iso-iec-15459-1",
    "iso-iec-15459-2",
    "iso-iec-15459-3",
    "iso-iec-15459-4",
    "iso-iec-15459-5",
    "iso-iec-15459-6",
  ].map(
    (standard): Citation => ({
      legislation: "espr",
      standard,
      provision: "Annex III, after point (l)",
      force: "operative",
      excerpt:
        "The data carrier, the unique product identifier referred to in point (b), the unique operator identifiers referred to in points (g), (h) and (k), and the unique facility identifiers referred to in point (i) shall, where relevant for the products concerned, comply with standards ISO/IEC 15459-1:2014, ISO/IEC 15459-2:2015, ISO/IEC 15459-3:2014, ISO/IEC 15459-4:2014, ISO/IEC 15459-5:2014 and ISO/IEC 15459-6:2014.",
    }),
  ),
  {
    legislation: "espr",
    standard: "en-iso-14024",
    provision: "Recital 48",
    force: "recital",
    excerpt:
      "The EU Ecolabel and other nationally or regionally officially recognised EN ISO 14024 type I ecolabels are not to be considered misleading or confusing labels",
  },

  // ---------- CPR ----------
  {
    legislation: "cpr",
    standard: "en-15804",
    provision: "Recital 7",
    force: "recital",
    excerpt:
      "The Commission should make available software to perform the calculation, in particular the characterisation factors applicable in accordance with European standard EN 15804 or future applicable standards.",
  },
  {
    legislation: "cpr",
    standard: "en-iso-14024",
    provision: "Art. 19(1)",
    force: "operative",
    excerpt: "Officially recognised EN ISO 14024 type I ecolabels may be affixed to a product if they fulfil the requirement in the first subparagraph.",
  },
  {
    legislation: "cpr",
    standard: "en-iso-14024",
    provision: "Art. 83(7)",
    force: "operative",
    excerpt:
      "The EU Ecolabel and other national or regional EN ISO 14024 type I ecolabelling schemes officially recognised in accordance with Article 11 of Regulation (EC) No 66/2010",
  },

  // ---------- PPWR ----------
  {
    legislation: "ppwr",
    standard: "en-13432-2000",
    provision: "Recital 55",
    force: "recital",
    excerpt:
      "The requirements of harmonised standard EN 13432:2000 ‘Packaging – Requirements for packaging recoverable by composting and biodegradation – Test scheme and evaluation criteria for final acceptance of packaging’ should be revised",
  },
  {
    legislation: "ppwr",
    standard: "en-13428-2004",
    provision: "Recital 60",
    force: "recital",
    excerpt: "until such time as a new or updated harmonised standard becomes available, the existing standard, EN 13428:2004, can be used.",
  },

  // ---------- CBAM, through its implementing regulation on emissions ----------
  {
    legislation: "cbam",
    standard: "iso-iec-17025",
    provision: `${ANNEX_II} B.5.4.3`,
    force: "operative",
    source: CBAM_METHODS,
    excerpt:
      "Laboratories used to carry out analyses for the determination of calculation factors are recommended to be accredited in accordance with ISO/IEC 17025, for the relevant analytical methods.",
  },
  {
    legislation: "cbam",
    standard: "iso-iec-17025",
    provision: `${ANNEX_II} B.6.3`,
    force: "operative",
    source: CBAM_METHODS,
    excerpt:
      "Laboratories carrying out measurements, calibrations and relevant equipment assessments for continuous measurement systems shall be accredited in accordance with ISO/IEC 17025 for the relevant analytical methods or calibration activities.",
  },
  {
    legislation: "cbam",
    standard: "iso-13833",
    provision: `${ANNEX_II} B.6.2.3`,
    force: "operative",
    source: CBAM_METHODS,
    excerpt:
      "a calculation-based methodology, including methodologies using analyses and sampling based on ISO 13833 (Stationary source emissions – Determination of the ratio of biomass (biogenic) and fossil-derived carbon dioxide – Radiocarbon sampling and determination)",
  },
  {
    legislation: "cbam",
    standard: "iso-18466",
    provision: `${ANNEX_II} B.6.2.3`,
    force: "operative",
    source: CBAM_METHODS,
    excerpt:
      "another method based on a relevant standard, including ISO 18466 (Stationary source emissions – Determination of the biogenic fraction in CO2 in stack gas using the balance method)",
  },
  {
    legislation: "cbam",
    standard: "iso-20181-2023",
    provision: `${ANNEX_II} B.6.3`,
    force: "operative",
    source: CBAM_METHODS,
    excerpt: "ISO 20181:2023 Stationary source emissions – Quality assurance of automated measuring systems",
  },
  {
    legislation: "cbam",
    standard: "iso-14164-1999",
    provision: `${ANNEX_II} B.6.3`,
    force: "operative",
    source: CBAM_METHODS,
    excerpt: "ISO 14164:1999 Stationary source emissions – Determination of the volume flowrate of gas streams in ducts – Automated method",
  },
  {
    legislation: "cbam",
    standard: "iso-16911-2",
    provision: `${ANNEX_II} B.6.3`,
    force: "operative",
    source: CBAM_METHODS,
    excerpt:
      "other relevant ISO standards, in particular ISO 16911-2 (Stationary source emissions – Manual and automatic determination of velocity and volume flow rate in ducts)",
  },
  {
    legislation: "cbam",
    standard: "ipcc-2006",
    provision: `${ANNEX_II} B.5.2`,
    force: "operative",
    source: CBAM_METHODS,
    citedAs: "IPCC guidelines",
    excerpt: "standard factors contained in the latest IPCC guidelines for GHG inventories",
  },
  {
    legislation: "cbam",
    standard: "ipcc-2006",
    provision: `${ANNEX_II} G, Table 1`,
    force: "operative",
    source: CBAM_METHODS,
    citedAs: "IPCC 2006 GL",
    excerpt: "Crude oil 73,3 42,3 IPCC 2006 GL",
  },
  {
    legislation: "cbam",
    standard: "iai-guidelines",
    provision: `${ANNEX_II} B.7`,
    force: "operative",
    source: CBAM_METHODS,
    excerpt:
      "Emissions not related to anode effects shall be determined based on estimation methods in accordance with industry best practice, in particular guidelines provided by the International Aluminium Institute.",
  },
  {
    legislation: "cbam",
    standard: "iai-guidelines",
    provision: `${ANNEX_II} B.7.1`,
    force: "operative",
    source: CBAM_METHODS,
    excerpt:
      "For the determination of those emission factors industry best practice shall be applied, in particular the most recent guidelines provided by the International Aluminium Institute.",
  },

  // ---------- REACH: safety data sheets and registration ----------
  {
    legislation: "reach",
    standard: "iso-10156",
    provision: "Annex II, point 9.2.1(d)",
    force: "operative",
    excerpt:
      "as per ISO 10156 ‘Gases and gas mixtures – Determination of fire potential and oxidizing ability for the selection of cylinder valve outlets’",
  },
  {
    legislation: "reach",
    standard: "oecd-tg-421",
    provision: "Annex VIII, point 8.7.1",
    force: "operative",
    excerpt: "Screening for reproductive/developmental toxicity (OECD TG 421 or TG 422)",
  },
  {
    legislation: "reach",
    standard: "oecd-tg-422",
    provision: "Annex VIII, point 8.7.1",
    force: "operative",
    excerpt: "Screening for reproductive/developmental toxicity (OECD TG 421 or TG 422)",
  },
  {
    legislation: "reach",
    standard: "oecd-tg-414",
    provision: "Annexes VIII–X, point 8.7",
    force: "operative",
    excerpt: "Pre-natal developmental toxicity study (OECD TG 414)",
  },
  {
    legislation: "reach",
    standard: "oecd-tg-443",
    provision: "Annexes VIII–X, point 8.7",
    force: "operative",
    excerpt: "Extended One-Generation Reproductive Toxicity Study (OECD TG 443)",
  },
  {
    legislation: "reach",
    standard: "oecd-tg-416",
    provision: "Annexes VIII–X, point 8.7",
    force: "operative",
    excerpt: "Two-generation reproductive toxicity studies (B.35, OECD TG 416)",
  },
  {
    legislation: "reach",
    standard: "oecd-tg-212",
    provision: "Annex IX, point 9.1.6",
    force: "operative",
    excerpt: "Fish short-term toxicity tests on embryo and sac-fry stages (OECD TG 212)",
  },
  {
    legislation: "reach",
    standard: "oecd-tg-210",
    provision: "Annex IX, point 9.1.6.1",
    force: "operative",
    excerpt: "Fish early-life stage (FELS) toxicity test (OECD TG 210)",
  },
  {
    legislation: "reach",
    standard: "oecd-tg-215",
    provision: "Annex IX, point 9.1.6.3",
    force: "operative",
    excerpt: "Fish juvenile growth test (OECD TG 215)",
  },

  // ---------- REACH: Annex XVII restrictions ----------
  {
    legislation: "reach",
    standard: "en-14059",
    provision: "Annex XVII, entry 3(4)",
    force: "operative",
    excerpt: "the European Standard on Decorative oil lamps (EN 14059) adopted by the European Committee for Standardisation (CEN)",
  },
  {
    legislation: "reach",
    standard: "en-16143-2013",
    provision: "Annex XVII, entry 50(1)",
    force: "operative",
    excerpt:
      "The standard EN 16143:2013 (Petroleum products — Determination of content of Benzo(a)pyrene (BaP) and selected polycyclic aromatic hydrocarbons (PAH) in extender oils — Procedure using double LC cleaning and GC/MS analysis)",
  },
  {
    legislation: "reach",
    standard: "iso-21461",
    provision: "Annex XVII, entry 50(2)",
    force: "operative",
    excerpt: "as measured and calculated by ISO 21461 (Rubber vulcanised — Determination of aromaticity of oil in vulcanised rubber compounds)",
  },
  {
    legislation: "reach",
    standard: "en-14387",
    provision: "Annex XVII, entry 56(1)",
    force: "operative",
    excerpt: "an appropriate gas filter (i.e. type A1 according to standard EN 14387)",
  },
  {
    legislation: "reach",
    standard: "en-15343-2007",
    provision: "Annex XVII, entry 63",
    force: "operative",
    excerpt:
      "Certificates issued by schemes to provide proof of traceability and recycled content, such as those developed according to EN 15343:2007 or equivalent recognised standards",
  },
  {
    legislation: "reach",
    standard: "astm-d4359-90",
    provision: "Annex XVII, entry 78(2)(d)(ii)",
    force: "operative",
    citedAs: "(ASTM) D 4359-90",
    excerpt:
      "the American Society for Testing and Materials (ASTM) D 4359-90 Standard Test Method for Determining Whether a Material Is a Liquid or a Solid",
  },
  {
    legislation: "reach",
    standard: "din-52025",
    provision: "Annex XVII, Appendix 2",
    force: "operative",
    excerpt: "a softening point of 140 to 170 °C according to DIN 52025",
  },

  // Appendix 10: testing methods for azo colourants (entry 43).
  {
    legislation: "reach",
    standard: "en-iso-17234-1-2015",
    provision: "Annex XVII, Appendix 10 (entry 43)",
    force: "operative",
    citedAs: "CEN EN ISO 17234-1:2015",
    excerpt:
      "CEN EN ISO 17234-1:2015 Leather – Chemical tests for the determination of certain azo colorants in dyed leathers – Part 1: Determination of certain aromatic amines derived from azo colorants",
  },
  {
    legislation: "reach",
    standard: "en-iso-17234-2-2011",
    provision: "Annex XVII, Appendix 10 (entry 43)",
    force: "operative",
    citedAs: "CEN EN ISO 17234-2:2011",
    excerpt:
      "CEN EN ISO 17234-2:2011 Leather – Chemical tests for the determination of certain azo colorants in dyed leathers – Part 2: Determination of 4-aminoazobenzene",
  },
  {
    legislation: "reach",
    standard: "en-iso-14362-1-2017",
    provision: "Annex XVII, Appendix 10 (entry 43)",
    force: "operative",
    citedAs: "CEN EN ISO 14362-1:2017",
    excerpt:
      "CEN EN ISO 14362-1:2017 Textiles – Methods for determination of certain aromatic amines derived from azo colorants – Part 1: Detection of the use of certain azo colorants accessible with and without extracting the fibres",
  },
  {
    legislation: "reach",
    standard: "en-iso-14362-3-2017",
    provision: "Annex XVII, Appendix 10 (entry 43)",
    force: "operative",
    citedAs: "CEN EN ISO 14362-3:2017",
    excerpt:
      "CEN EN ISO 14362-3:2017 Textiles – Methods for determination of certain aromatic amines derived from azo colorants – Part 3: Detection of the use of certain azo colorants, which may release 4-aminoazobenzene",
  },

  // Appendix 14: formaldehyde (entry 77).
  {
    legislation: "reach",
    standard: "en-16516",
    provision: "Annex XVII, Appendix 14, point 1(c)",
    force: "operative",
    excerpt: "loading factors in accordance with Section 4.2.2 of EN 16516",
  },
  {
    legislation: "reach",
    standard: "iso-12219-1",
    provision: "Annex XVII, Appendix 14, point 2",
    force: "operative",
    excerpt: "the formaldehyde concentration shall be measured in ambient mode in accordance with the conditions specified in ISO 12219-1",
  },
  {
    legislation: "reach",
    standard: "iso-12219-10",
    provision: "Annex XVII, Appendix 14, point 2",
    force: "operative",
    excerpt: "ISO 12219-10: Interior air of road vehicles – Part 10: Whole vehicle test chamber",
  },

  // Appendices 15 and 16: proving polymers degradable or soluble (entry 78).
  {
    legislation: "reach",
    standard: "iso-iec-17025",
    provision: "Annex XVII, Appendices 15 and 16 (entry 78)",
    force: "operative",
    citedAs: "ISO 17025",
    excerpt: "other international standards recognised as being equivalent by the Commission or the Agency or accredited to ISO 17025.",
  },
  appendix15("oecd-tg-301", "‘Ready Biodegradability’ (OECD TG 301 B, C, D, F)"),
  appendix15("oecd-tg-310", "‘Ready Biodegradability – CO2 in sealed vessels (Headspace Test)’ (OECD TG 310)"),
  appendix15("oecd-tg-306", "‘Biodegradability in Seawater’ (OECD TG 306)"),
  appendix15("oecd-tg-302c", "‘Inherent Biodegradability: modified MITI Test (II)’ (OECD 302C)"),
  appendix15(
    "en-iso-14852-2021",
    "‘Determination of the ultimate aerobic biodegradability of plastic materials in an aqueous medium – Method by analysis of evolved carbon dioxide.’ (EN ISO 14852:2021)",
  ),
  appendix15(
    "en-iso-14851-2019",
    "‘Determination of the ultimate aerobic biodegradability of plastic materials in an aqueous medium – Method by measuring the oxygen demand in a closed respirometer.’ (EN ISO 14851:2019)",
  ),
  appendix15(
    "en-iso-19679-2020",
    "‘Plastics – Determination of aerobic biodegradation of non-floating plastic materials in seawater/sediment interface – Method by analysis of evolved carbon dioxide’ (EN ISO 19679:2020)",
  ),
  appendix15(
    "en-iso-18830-2016",
    "‘Plastics – Determination of aerobic biodegradation of non-floating plastic materials in seawater/sandy sediment interface – Method by measuring the oxygen demand in closed respirometer’ (EN ISO 18830:2016)",
  ),
  appendix15(
    "en-iso-17556-2019",
    "‘Plastics – Determination of the ultimate aerobic biodegradability of plastic materials in soil by measuring the oxygen demand in a respirometer or the amount of carbon dioxide evolved’ (EN ISO 17556:2019)",
  ),
  appendix15(
    "iso-22404-2019",
    "‘Plastics – Determination of the aerobic biodegradation of non-floating materials exposed to marine sediment – Method by analysis of evolved carbon dioxide’ (ISO 22404:2019)",
  ),
  appendix15(
    "iso-22403-2020",
    "The specifications laid down in ISO 22403:2020 ‘Plastics – Assessment of the intrinsic biodegradability of materials exposed to marine inocula under mesophilic aerobic laboratory conditions – Test methods and requirements’",
  ),
  appendix15("oecd-tg-307", "‘Aerobic and Anaerobic Transformation in Soil’ (OECD TG 307)"),
  appendix15("oecd-tg-308", "‘Aerobic and Anaerobic Transformation in Aquatic Sediment Systems’ (OECD TG 308)"),
  appendix15("oecd-tg-309", "‘Aerobic Mineralisation in Surface Water – Simulation Biodegradation Test’ (OECD TG 309)"),
  {
    legislation: "reach",
    standard: "oecd-tg-120",
    provision: "Annex XVII, Appendix 16 (entry 78)",
    force: "operative",
    citedAs: "OECD Guideline 120",
    excerpt: "Permitted test methods: 1. OECD Guideline 120",
  },
  {
    legislation: "reach",
    standard: "oecd-tg-105",
    provision: "Annex XVII, Appendix 16 (entry 78)",
    force: "operative",
    citedAs: "OECD Guideline 105",
    excerpt: "2. OECD Guideline 105",
  },

  // ---------- BPR ----------
  {
    legislation: "bpr",
    standard: "oecd-tg-428",
    provision: "Annex II, Title 1, points 8.7 and 8.7.3",
    force: "operative",
    citedAs: "OECD 428",
    excerpt: "an in vitro dermal penetration study (OECD 428)",
  },

  // ---------- WFD ----------
  {
    legislation: "wfd",
    standard: "iso-14001",
    provision: "Annex IV, point 10",
    force: "operative",
    excerpt: "The promotion of creditable environmental management systems, including EMAS and ISO 14001.",
  },

  // ---------- FLR ----------
  {
    legislation: "flr",
    standard: "ilo-c29",
    provision: "Art. 2(1)",
    force: "operative",
    excerpt: "‘forced labour’ means forced or compulsory labour as defined in Article 2 of ILO Convention No 29, including forced child labour",
  },
  {
    legislation: "flr",
    standard: "ilo-c105",
    provision: "Art. 2(2)",
    force: "operative",
    excerpt: "‘forced labour imposed by state authorities’ means the use of forced labour as described in Article 1 of ILO Convention No 105",
  },
  {
    legislation: "flr",
    standard: "ilo-indicators",
    provision: "Recital 20",
    force: "recital",
    excerpt:
      "the ILO indicators of forced labour and the ILO guidelines entitled ‘Hard to See, Harder to Count’ set out the most common signs that point to the possible existence of forced labour and should be taken into account when implementing this Regulation.",
  },
  {
    legislation: "flr",
    standard: "ilo-hard-to-see",
    provision: "Recital 20",
    force: "recital",
    excerpt:
      "the ILO indicators of forced labour and the ILO guidelines entitled ‘Hard to See, Harder to Count’ set out the most common signs that point to the possible existence of forced labour and should be taken into account when implementing this Regulation.",
  },
];

const links = (
  legislation: string,
  standards: string[],
  dataRequirements: string[],
  basis: LinkBasis,
  note: string,
  provisions?: string[],
): StandardLink[] =>
  standards.flatMap((standard) =>
    dataRequirements.map((dataRequirement) => ({ legislation, standard, dataRequirement, basis, note, provisions })),
  );

const JTC_24_DPP = "Implementing Decision (EU) 2026/1736: harmonised standard satisfying ESPR Articles 10 and 11, the passport's requirements.";
const JTC_24_IDENTIFIERS = "The CEN/CLC/JTC 24 standard for the product, operator and facility identifiers a passport uses.";

const ISO_15459 = ["iso-iec-15459-1", "iso-iec-15459-2", "iso-iec-15459-3", "iso-iec-15459-4", "iso-iec-15459-5", "iso-iec-15459-6"];
const ANNEX_III_IDENTIFIERS = ["Annex III, after point (l)"];

const ANNEX_II_MONITORING = [
  "iso-iec-17025",
  "iso-13833",
  "iso-18466",
  "iso-20181-2023",
  "iso-14164-1999",
  "iso-16911-2",
  "ipcc-2006",
];

/**
 * Only where the legislation has a provision behind that data requirement, so a
 * standard the act cites for something else (e.g. REACH's tyre oils) has no link.
 * `npm run build-seed` fails if one has no citation or no provision.
 */
export const STANDARD_LINKS: StandardLink[] = [
  ...links("espr", ["en-18216-2026", "en-18219-2026", "en-18220-2026", "en-18221-2026", "en-18222-2026", "en-18223-2026"], ["dpp"], "stated", JTC_24_DPP),
  ...links("espr", ["en-18219-2026"], ["product-id", "manufacturer", "importer", "supply-chain-operators", "production-site"], "inferred", JTC_24_IDENTIFIERS),
  ...links("espr", ["en-18220-2026"], ["product-id"], "inferred", "Art. 10(1) connects the product to its identifier through a data carrier, which this standard specifies."),
  ...links(
    "espr",
    ISO_15459,
    ["product-id"],
    "stated",
    "Point (b): the unique product identifier.",
  ),
  ...links(
    "espr",
    ISO_15459,
    ["manufacturer"],
    "stated",
    "Point (g): the manufacturer's unique operator identifier.",
    ANNEX_III_IDENTIFIERS,
  ),
  ...links(
    "espr",
    ISO_15459,
    ["importer"],
    "stated",
    "Point (k): the unique operator identifier of the EU-established responsible operator.",
    ANNEX_III_IDENTIFIERS,
  ),
  ...links(
    "espr",
    ISO_15459,
    ["supply-chain-operators"],
    "stated",
    "Point (h): unique operator identifiers other than the manufacturer's.",
    ANNEX_III_IDENTIFIERS,
  ),
  ...links(
    "espr",
    ISO_15459,
    ["production-site"],
    "stated",
    "Point (i): unique facility identifiers.",
    ANNEX_III_IDENTIFIERS,
  ),
  ...links(
    "espr",
    ISO_15459,
    ["dpp"],
    "stated",
    "The data carrier of the digital product passport.",
    ANNEX_III_IDENTIFIERS,
  ),
  ...links(
    "cpr",
    ["en-15804"],
    ["carbon-footprint", "environmental-footprint"],
    "inferred",
    "Recital 7 takes the characterisation factors of the Commission's calculation software from this standard; Art. 15 requires the results in the declaration.",
  ),
  ...links(
    "cpr",
    ["en-iso-14024"],
    ["label"],
    "stated",
    "Art. 19(1): ecolabels under this standard may be affixed to the product next to the CE marking.",
    ["Art. 19(1)"],
  ),
  ...links(
    "ppwr",
    ["en-13428-2004"],
    ["conformity"],
    "inferred",
    "Recital 60 keeps this standard usable for packaging minimisation (Art. 10), one of the requirements in Arts. 5–12 the EU declaration of conformity covers.",
  ),
  ...links(
    "ppwr",
    ["en-13432-2000"],
    ["conformity"],
    "inferred",
    "Recital 55 refers to this standard for compostable packaging (Art. 9), one of the requirements in Arts. 5–12 the EU declaration of conformity covers.",
  ),
  ...links(
    "cbam",
    ANNEX_II_MONITORING,
    ["carbon-footprint"],
    "inferred",
    "Implementing Regulation (EU) 2025/2547, Annex II sets how actual direct emissions are monitored; those are the embedded emissions the CBAM declaration reports.",
  ),
  ...links(
    "cbam",
    ["iai-guidelines"],
    ["process-emissions"],
    "stated",
    "Implementing Regulation (EU) 2025/2547: perfluorocarbons from primary smelting are monitored under Annex II, point B.7, which applies these guidelines.",
  ),
  ...links(
    "reach",
    ["en-iso-17234-1-2015", "en-iso-17234-2-2011", "en-iso-14362-1-2017", "en-iso-14362-3-2017"],
    ["restricted-substances"],
    "stated",
    "Annex XVII, entry 43: azo colourants in textile and leather articles are tested by the methods in Appendix 10.",
  ),
  ...links(
    "flr",
    ["ilo-c29", "ilo-c105"],
    ["forced-labour"],
    "stated",
    "Art. 2 defines forced labour through these conventions.",
  ),
  ...links(
    "flr",
    ["ilo-indicators", "ilo-hard-to-see"],
    ["forced-labour"],
    "stated",
    "Recital 20: the signs of forced labour to take into account when implementing the regulation.",
  ),
];

const AL: ProductGroup[] = ["aluminium"];
const TX: ProductGroup[] = ["textile"];
const BOTH: ProductGroup[] = ["aluminium", "textile"];

/** A standard no act names, whose own scope targets a data requirement. */
export interface StandardTarget {
  standard: string;
  dataRequirement: string;
  groups: ProductGroup[];
  /** Why it targets this data requirement. */
  note: string;
  /** The publisher or catalogue page this rests on. */
  source: string;
}

const targets = (standard: string, dataRequirements: string[], groups: ProductGroup[], note: string, source: string): StandardTarget[] =>
  dataRequirements.map((dataRequirement) => ({ standard, dataRequirement, groups, note, source }));

const GS1_ISO = "https://ref.gs1.org/docs/2026/GS1-and-SDOs";
const ISO_CATALOGUE = (id: number) => `https://www.iso.org/standard/${id}.html`;
const LIFE_CYCLES = "https://www.iso.org/ics/13.020.60/x/";
const GHG_CATALOGUE = "https://www.iso.org/committee/546318/x/catalogue/";
const CASCO = "https://www.iso.org/files/live/sites/isoorg/files/store/en/PUB100452.pdf";
const JTC_10 = "https://www.cetim.fr/en/Mecatheque/Results-of-collective-works/jtc10-material-efficiency-summary-of-standards";
const ENERGY_RELATED = "Written for energy-related products, so its method is general rather than specific to this product group.";
const OPERATORS = ["manufacturer", "importer", "supply-chain-operators"];

export const STANDARD_TARGETS: StandardTarget[] = [
  // ---------- Digital product passport ----------
  ...targets("en-18239-2026", ["dpp"], BOTH, "CEN/CLC/JTC 24 standard on who may access passport data. Published, but not among the six harmonised standards in Implementing Decision (EU) 2026/1736.", "https://genorma.com/en/standards/en-18239-2026"),
  ...targets("en-18246-2026", ["dpp"], BOTH, "CEN/CLC/JTC 24 standard on authenticating passport data. Published, but not among the six harmonised standards in Implementing Decision (EU) 2026/1736.", "https://genorma.com/en/standards/en-18246-2026"),
  ...targets("iso-iec-18004", ["dpp"], BOTH, "QR Code, a symbology for the passport's data carrier.", GS1_ISO),
  ...targets("iso-iec-16022", ["dpp"], BOTH, "Data Matrix, a symbology for the passport's data carrier.", GS1_ISO),

  // ---------- Identification and operators ----------
  ...targets("gs1-general-specifications", ["product-id"], BOTH, "GTIN identifies the product.", GS1_ISO),
  ...targets("gs1-general-specifications", ["manufacturer", "production-site"], BOTH, "GLN identifies parties and locations.", GS1_ISO),
  ...targets("iso-iec-6523", OPERATORS, BOTH, "Structure for identifying organizations in data exchange.", "https://ref.gs1.org/standards/icd"),
  ...targets("iso-17442", OPERATORS, BOTH, "Legal Entity Identifier, a global identifier for companies.", "https://gleif.org/en/about-lei/iso-17442-the-lei-code-structure"),
  ...targets("wco-hs-2028", ["commodity-code"], BOTH, "The nomenclature that commodity codes such as CN and TARIC build on. This edition enters into force on 1 January 2028.", "https://www.wcoomd.org/en/topics/nomenclature/instrument-and-tools/hs-nomenclature-2028-edition.aspx"),
  ...targets("iso-3166-1-2020", ["production-site"], BOTH, "Codes for the country of origin.", ISO_CATALOGUE(72482)),
  ...targets("iso-iec-19987-2024", ["supply-chain-operators"], BOTH, "Records supply-chain events: what happened, when, where and why.", "https://standards.iteh.ai/catalog/standards/iso/d799a114-aba0-4b07-a3c4-45ff1edfb30f/iso-iec-19987-2024"),
  ...targets("iso-22095-2020", ["supply-chain-operators"], BOTH, "Terminology and models for tracing materials through a supply chain.", CASCO),
  ...targets("asi-chain-of-custody-v2", ["supply-chain-operators"], AL, "Links verified practices along the aluminium supply chain.", "https://aluminium-stewardship.org/asi-standards/chain-of-custody-standard"),

  // ---------- Composition and substances ----------
  ...targets("iso-1833-1-2020", ["material-composition"], TX, "Measures the fibre composition of textile mixtures.", ISO_CATALOGUE(74881)),
  ...targets("iso-2076-2021", ["material-composition"], TX, "Generic names for man-made fibres.", ISO_CATALOGUE(79685)),
  ...targets("en-573-3-2026", ["material-composition"], AL, "Composition limits for wrought aluminium alloys. Catalogues disagree on the latest edition: another lists EN 573-3:2019+A2:2023.", "https://shop.standards.ie/en-ie/standards/en-573-3-2026-330424_saig_cen_cen_3929076/"),
  ...targets("iso-14389-2022", ["restricted-substances"], TX, "Measures phthalates in textiles.", ISO_CATALOGUE(80463)),
  ...targets("en-17132-2019", ["restricted-substances"], TX, "Measures polycyclic aromatic hydrocarbons in textiles.", "https://standards.iteh.ai/catalog/standards/cen/d8c45054-b17b-4d12-abdf-b8aae83dea5f/en-17132-2019"),
  ...targets("iso-14184-1-2011", ["restricted-substances"], TX, "Measures formaldehyde in textiles.", ISO_CATALOGUE(55524)),
  ...targets("iso-18254-1-2016", ["restricted-substances"], TX, "Measures alkylphenol ethoxylates in textiles.", ISO_CATALOGUE(70906)),
  ...targets("en-16711-1-2015", ["restricted-substances"], TX, "Measures metals in textiles, including coated fabrics and components.", "https://evs.ee/en/evs-en-16711-1-2015"),
  ...targets("en-16711-2-2015", ["restricted-substances"], TX, "Measures metals extracted from textiles by artificial perspiration.", "https://www.evs.ee/en/evs-en-16711-2-2015"),
  ...targets("oeko-tex-standard-100", ["restricted-substances"], TX, "Certification scheme testing textiles for legally restricted and other harmful substances.", "https://www.oeko-tex.com/importedmedia/downloadfiles/OEKO-TEX_STANDARD_100_Standard_EN_DE.pdf"),
  ...targets("zdhc-mrsl-3-1", ["restricted-substances"], TX, "Restricts chemicals used in manufacturing, not finished products, and states it is not a statement of legal requirements.", "https://mrsl.roadmaptozero.com/"),
  ...targets("iso-20743-2021", ["biocidal-treatment"], TX, "Tests the antibacterial activity a treated textile claims.", ISO_CATALOGUE(79819)),
  ...targets("iso-18184-2025", ["biocidal-treatment"], TX, "Tests the antiviral activity a treated textile claims.", ISO_CATALOGUE(86323)),

  // ---------- Environmental footprint ----------
  ...targets("iso-14067-2018", ["carbon-footprint"], BOTH, "Quantifies a product's carbon footprint.", ISO_CATALOGUE(71206)),
  ...targets("pef-2021-2279", ["carbon-footprint", "environmental-footprint"], BOTH, "The Commission's life-cycle method, with climate change among its impact categories.", "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32021H2279"),
  ...targets("pefcr-apparel-footwear-3-1", ["carbon-footprint", "environmental-footprint"], TX, "Applies the Commission's method to apparel and footwear; approved by the Commission in May 2025.", "https://environment.ec.europa.eu/news/new-eu-rules-measuring-environmental-impact-clothes-and-shoes-2025-06-25_en"),
  ...targets("iso-19694-4-2023", ["carbon-footprint", "process-emissions"], AL, "Greenhouse gases from aluminium production, including CO2 and PFCs from primary smelting. The international successor to EN 19694-4:2016.", "https://ccn-scc.ca/standardsdb/standards/8178478"),
  ...targets("iso-14040-2006", ["environmental-footprint"], BOTH, "Principles of the life cycle assessment behind a footprint.", LIFE_CYCLES),
  ...targets("iso-14044-2006", ["environmental-footprint"], BOTH, "Requirements for the life cycle assessment behind a footprint.", ISO_CATALOGUE(38498)),
  ...targets("iso-14025-2026", ["environmental-footprint"], BOTH, "Environmental product declarations, a format for reporting a footprint.", "https://www.iso.org/standard/14025"),
  ...targets("iso-14064-1-2018", ["process-emissions"], BOTH, "Quantifies an organization's greenhouse gas emissions.", ISO_CATALOGUE(66453)),
  ...targets("iso-50001-2018", ["energy-resources"], BOTH, "Energy management, a source for energy-use data.", "https://www.iso.org/sectors/environment"),
  ...targets("iso-14046-2014", ["energy-resources"], BOTH, "Water footprint.", LIFE_CYCLES),
  ...targets("iso-4484-1-2023", ["microplastics"], TX, "Collects material lost from fabrics during laundering tests.", ISO_CATALOGUE(82238)),
  ...targets("iso-4484-2-2023", ["microplastics"], TX, "Analyses microplastics in samples from the textile sector.", ISO_CATALOGUE(80011)),
  ...targets("iso-4484-3-2023", ["microplastics"], TX, "Measures material released by domestic washing.", ISO_CATALOGUE(81035)),

  // ---------- Circularity ----------
  ...targets("iso-14021-2016", ["recycled-content"], BOTH, "Rules for claiming recycled content.", "https://www.evs.ee/en/iso-14021-2016-amd-1-2021"),
  ...targets("iso-22095-2020", ["recycled-content"], BOTH, "Models for tracing recycled material through a supply chain.", CASCO),
  ...targets("iso-22095-2-2026", ["recycled-content"], BOTH, "Mass balance, a way to account for recycled input.", CASCO),
  ...targets("iso-59020-2024", ["recycled-content", "recyclability"], BOTH, "Indicators of circularity performance.", ISO_CATALOGUE(80650)),
  ...targets("grs-5-0", ["recycled-content"], TX, "Certification scheme for recycled content. Textile Exchange is moving its recycled standards into a new Materials Matter Standard.", "https://textileexchange.org/app/uploads/2020/08/GRS-101-V5.0-Global-Recycled-Standard.pdf"),
  ...targets("asi-chain-of-custody-v2", ["recycled-content"], AL, "Lists recycled content, with its methodology, as optional data in chain-of-custody documents.", "https://aluminium-stewardship.org/asi-standards/chain-of-custody-standard"),
  ...targets("en-45557", ["recycled-content"], BOTH, ENERGY_RELATED, JTC_10),
  ...targets("en-45552-2020", ["durability"], BOTH, ENERGY_RELATED, JTC_10),
  ...targets("en-45554", ["repairability"], TX, ENERGY_RELATED, JTC_10),
  ...targets("en-45555", ["recyclability"], BOTH, ENERGY_RELATED, JTC_10),
  ...targets("en-45559-2019", ["end-of-life-info"], BOTH, ENERGY_RELATED, "https://standards.iteh.ai/catalog/standards/sist/0310fce0-3c88-4fa4-833b-9563865ba108/sist-en-45559-2019"),
  ...targets("en-13430", ["recyclability"], AL, "Recyclability of packaging, which includes aluminium packaging.", "https://www.productip.com/kb/academy-home/productip-library/standards-related-to-packaging"),
  ...targets("iso-12947-2-2016", ["durability"], TX, "Abrasion resistance of fabrics.", ISO_CATALOGUE(61058)),
  ...targets("iso-12945-2-2020", ["durability"], TX, "Pilling of fabrics.", ISO_CATALOGUE(75375)),
  ...targets("iso-105-c06-2010", ["durability"], TX, "Colour fastness to laundering.", ISO_CATALOGUE(51276)),
  ...targets("iso-13934-1-2013", ["durability"], TX, "Tensile strength of fabrics.", ISO_CATALOGUE(60676)),

  // ---------- Supply chain ----------
  ...targets("oecd-garment-footwear", ["forced-labour"], TX, "Due diligence for the garment and footwear sector, with a module on forced labour.", "https://www.oecd.org/en/publications/oecd-due-diligence-guidance-for-responsible-supply-chains-in-the-garment-and-footwear-sector_9789264290587-en.html"),
  ...targets("sa8000", ["forced-labour"], BOTH, "Certification scheme for workplace social accountability. Sources disagree on the latest edition, so none is stated.", "https://sa-intl.org/?p=2242"),
  ...targets("asi-performance-3-1", ["forced-labour"], AL, "Certification scheme for aluminium that covers forced labour under criterion 10.3.", "https://aluminium-stewardship.org/forced-labour-risks-in-aluminium-how-asi-is-driving-mitigation-efforts"),
  ...targets("iso-26000-2010", ["forced-labour"], BOTH, "General guidance on social responsibility.", "https://shop.standards.ie/en-ie/standards/iso-26000-2010-598290_saig_iso_iso_1370243"),
  ...targets("iso-20400-2017", ["forced-labour"], BOTH, "General guidance on sustainable procurement.", "https://evs.ee/en/iso-20400-2017"),

  // ---------- Compliance and information ----------
  ...targets("en-iso-iec-17050-1-2010", ["conformity"], BOTH, "General requirements for a supplier's declaration of conformity.", "https://insights.snv.ch/en/page/isoiec-17050-12010-standard-overview-requirements-en"),
  ...targets("iso-14064-3-2019", ["verification"], AL, "Verification of greenhouse gas statements.", GHG_CATALOGUE),
  ...targets("iso-14065-2020", ["verification"], AL, "Requirements for bodies verifying environmental information.", GHG_CATALOGUE),
  ...targets("iso-iec-17029-2019", ["verification"], AL, "Requirements for validation and verification bodies.", "https://www.iso.org/news/ref2448.html"),
  ...targets("iso-iec-17065-2012", ["verification"], AL, "Requirements for bodies certifying products. A revision is in development.", ISO_CATALOGUE(46568)),
  ...targets("en-14351-1-2006-a2-2016", ["performance"], AL, "Performance characteristics of windows and external doors, a use of aluminium profiles.", "https://shop.standards.ie/en-ie/standards/en-14351-1-2006-a2-2016-344407_saig_cen_cen_788127"),
  ...targets("en-13830-2015-a1-2020", ["performance"], AL, "Performance of curtain walling, a use of aluminium profiles.", "https://shop.standards.ie/en-ie/standards/en-13830-2015-a1-2020-345885_saig_cen_cen_2847205"),
  ...targets("en-iec-ieee-82079-1-2020", ["instructions"], BOTH, "How to prepare instructions for use.", "https://shop.standards.ie/en-ie/standards/en-iec-ieee-82079-1-2020-1185042_saig_cenelec_cenelec_2829685"),
  ...targets("iso-3758-2023", ["label"], TX, "Care symbols on textile labels.", "https://www.iso.org/obp/ui/#iso:std:iso:3758:ed-4:v1:en:tab:5"),
];
