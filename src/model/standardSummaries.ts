/**
 * What each standard is about, in one short line under its name in the Standards
 * column. These are our plain-language readings of each standard's title and scope,
 * not the publisher's words, and carry no legal weight.
 *
 * `npm run build-seed` fails if a standard has no summary, if a summary names an
 * unknown standard, or if one is longer than `SUMMARY_MAX`, which is what fits on
 * one line at the column's usual width.
 */
export const SUMMARY_MAX = 44;

export const STANDARD_SUMMARIES: Record<string, string> = {
  // Unique identifiers
  "iso-iec-15459-1": "Unique IDs for individual transport units",
  "iso-iec-15459-2": "Registering issuers of unique IDs",
  "iso-iec-15459-3": "Common rules for unique IDs",
  "iso-iec-15459-4": "Unique IDs for products and packages",
  "iso-iec-15459-5": "Unique IDs for returnable transport items",
  "iso-iec-15459-6": "Unique IDs for groupings",

  // Digital product passport
  "en-18216-2026": "Data exchange protocols for passports",
  "en-18219-2026": "Unique identifiers for passports",
  "en-18220-2026": "Data carriers linking product to passport",
  "en-18221-2026": "Storing and archiving passport data",
  "en-18222-2026": "APIs to manage and search passports",
  "en-18223-2026": "Interoperability between passport systems",
  "en-18239-2026": "Passport access rights and data security",
  "en-18246-2026": "Authenticity and integrity of passport data",

  // Labels, footprint and packaging
  "en-iso-14024": "Rules for Type I ecolabelling schemes",
  "en-15804": "EPD rules for construction products",
  "en-13432-2000": "Proving packaging can be composted",
  "en-13428-2004": "Minimising packaging by source reduction",
  "iso-14001": "Environmental management systems",

  // Emissions monitoring
  "iso-iec-17025": "Competence of test and calibration labs",
  "iso-13833": "Biogenic vs fossil CO2 by radiocarbon",
  "iso-18466": "Biogenic CO2 in stack gas, balance method",
  "iso-20181-2023": "Quality of automated emission monitors",
  "iso-14164-1999": "Automated gas flow measurement in ducts",
  "iso-16911-2": "Gas velocity and flow measurement in ducts",
  "ipcc-2006": "National greenhouse gas inventory methods",
  "iai-guidelines": "Measuring PFCs from aluminium smelters",

  // Azo colourants
  "en-iso-17234-2-2011": "Testing leather for 4-aminoazobenzene",
  "en-iso-14362-1-2017": "Detecting certain azo dyes in textiles",
  "en-iso-14362-3-2017": "Detecting 4-aminoazobenzene in textiles",

  // Other REACH restrictions and annexes
  "iso-10156": "Fire potential of gases and gas mixtures",
  "en-14059": "Safety of decorative oil lamps",
  "en-16143-2013": "Measuring PAHs in extender oils",
  "iso-21461": "Oil aromaticity in vulcanised rubber",
  "en-14387": "Gas filters for respiratory protection",
  "en-15343-2007": "Traceability of recycled plastics",
  "en-16516": "Indoor air emissions of building products",
  "iso-12219-1": "Cabin air VOCs, whole-vehicle test",
  "iso-12219-10": "Cabin air VOCs in trucks and buses",
  "astm-d4359-90": "Whether a material is a liquid or solid",

  // Biodegradation of polymers
  "en-iso-14852-2021": "Plastics biodegrading in water, by CO2",
  "en-iso-14851-2019": "Plastics biodegrading in water, by oxygen",
  "en-iso-19679-2020": "Plastics biodegrading in seawater, by CO2",
  "en-iso-18830-2016": "Plastics biodegrading in seawater, by O2",
  "en-iso-17556-2019": "Plastics biodegrading in soil",
  "iso-22404-2019": "Plastics biodegrading in marine sediment",
  "iso-22403-2020": "Intrinsic biodegradability in marine tests",

  // OECD test guidelines
  "oecd-tg-421": "Screening for reproductive toxicity",
  "oecd-tg-422": "Repeated-dose and reproductive screening",
  "oecd-tg-414": "Prenatal developmental toxicity",
  "oecd-tg-443": "One-generation reproductive toxicity",
  "oecd-tg-416": "Two-generation reproductive toxicity",
  "oecd-tg-212": "Toxicity to fish embryos and larvae",
  "oecd-tg-210": "Toxicity to early-life stage fish",
  "oecd-tg-215": "Effects on juvenile fish growth",
  "oecd-tg-301": "Ready biodegradability",
  "oecd-tg-310": "Ready biodegradability, headspace test",
  "oecd-tg-306": "Biodegradability in seawater",
  "oecd-tg-302c": "Inherent biodegradability",
  "oecd-tg-307": "Breakdown of chemicals in soil",
  "oecd-tg-308": "Breakdown in aquatic sediment",
  "oecd-tg-309": "Mineralisation in surface water",
  "oecd-tg-120": "How polymers dissolve in water",
  "oecd-tg-105": "Water solubility of a substance",
  "oecd-tg-428": "Skin absorption, in vitro",

  // Identifiers and traceability
  "gs1-general-specifications": "GTIN, GLN and other identification keys",
  "iso-iec-6523": "Identifying organizations in data exchange",
  "iso-17442": "Legal Entity Identifier (LEI) for companies",
  "iso-3166-1-2020": "Country codes",
  "iso-iec-19987-2024": "Recording supply-chain events (EPCIS)",
  "iso-iec-18004": "QR Code symbology",
  "iso-iec-16022": "Data Matrix symbology",
  "wco-hs-2028": "Customs goods codes, in force 1 Jan 2028",

  // Composition and substances
  "iso-1833-1-2020": "Measuring fibre composition of textiles",
  "iso-2076-2021": "Generic names for man-made fibres",
  "en-573-3-2026": "Composition of wrought aluminium alloys",
  "iso-14389-2022": "Measuring phthalates in textiles",
  "en-17132-2019": "Measuring PAHs in textiles",
  "iso-14184-1-2011": "Measuring formaldehyde in textiles",
  "iso-18254-1-2016": "Measuring APEOs in textiles",
  "en-16711-1-2015": "Measuring metals in textiles",
  "en-16711-2-2015": "Metals extracted by artificial perspiration",
  "oeko-tex-standard-100": "Harmful-substance testing of textiles",
  "iso-20743-2021": "Antibacterial activity of textiles",
  "iso-18184-2025": "Antiviral activity of textiles",

  // Footprint
  "iso-14067-2018": "Carbon footprint of products",
  "iso-14040-2006": "Life cycle assessment: principles",
  "iso-14044-2006": "Life cycle assessment: requirements",
  "iso-14025-2026": "Environmental product declarations",
  "pef-2021-2279": "EU product environmental footprint method",
  "pefcr-apparel-footwear-3-1": "EU footprint rules for clothes and shoes",
  "iso-19694-4-2023": "GHG emissions from aluminium production",
  "iso-14064-1-2018": "Organization greenhouse gas reporting",
  "iso-50001-2018": "Energy management system requirements",
  "iso-14046-2014": "Water footprint",
  "iso-4484-1-2023": "Material lost from fabric in laundering",
  "iso-4484-2-2023": "Analysing microplastics from textiles",
  "iso-4484-3-2023": "Material released by domestic washing",

  // Circularity
  "iso-22095-2020": "Chain of custody terms and models",
  "iso-22095-2-2026": "Mass balance chain of custody",
  "iso-59020-2024": "Measuring circularity performance",
  "grs-5-0": "Recycled content with processing rules",
  "asi-chain-of-custody-v2": "Chain of custody for aluminium",
  "en-45552-2020": "Durability of energy-related products",
  "en-45554": "Assessing repair, reuse and upgrade",
  "en-45555": "Assessing recyclability and recoverability",
  "en-45557": "Assessing recycled material content",
  "en-45559-2019": "Communicating material efficiency",
  "en-13430": "Packaging recoverable by recycling",
  "iso-12947-2-2016": "Fabric abrasion, Martindale method",
  "iso-12945-2-2020": "Fabric pilling, Martindale method",
  "iso-105-c06-2010": "Colour fastness to laundering",
  "iso-13934-1-2013": "Fabric tensile strength, strip method",
  "iso-3758-2023": "Care symbols on textile labels",

  // Supply chain
  "oecd-garment-footwear": "Due diligence for garments and footwear",
  sa8000: "Decent work certification for workplaces",
  "asi-performance-3-1": "Responsible aluminium production",
  "iso-26000-2010": "Guidance on social responsibility",
  "iso-20400-2017": "Guidance on sustainable procurement",

  // Compliance
  "en-iso-iec-17050-1-2010": "Supplier's declaration of conformity",
  "iso-iec-17065-2012": "Requirements for product certifiers",
  "iso-iec-17029-2019": "Rules for validation and verification bodies",
  "iso-14064-3-2019": "Verifying greenhouse gas statements",
  "iso-14065-2020": "Bodies verifying environmental information",
  "en-14351-1-2006-a2-2016": "Performance of windows and external doors",
  "en-13830-2015-a1-2020": "Performance of curtain walling",
  "en-iec-ieee-82079-1-2020": "Writing instructions for use",

  // International labour standards
  "ilo-c29": "Defines and bans forced labour",
  "ilo-c105": "Bans forced labour for five listed purposes",
  "ilo-indicators": "Common signs of forced labour",
  "ilo-hard-to-see": "Survey guidelines to estimate forced labour",

  // Catena-X
  "cx-0010": "Company, site and address identifiers",
  "cx-0125": "Tracing parts one level up and down",
  "cx-0126": "Digital twins of part types",
  "cx-0127": "Digital twins of batches and serial parts",
  "cx-0131": "Circular economy data framework",
  "cx-0135": "Sharing company certificates",
  "cx-0136": "Exchanging product carbon footprints",
  "cx-0143": "Digital product passport data model",
  "cx-0144": "Raising environmental and social incidents",
  "cx-0153": "Customs data for tariff declarations",
  "cx-0159": "Accounting for secondary material",
  "cx-nfr-pcf": "Rules for calculating carbon footprints",
  "cx-nfr-vf": "Verifying and certifying carbon footprints",

  // Consumer labels
  "label-gots": "Organic fibres, processing and social rules",
  "label-ocs": "Organic content and chain of custody",
  "label-ivn-best": "Stricter than GOTS, 100% organic fibre",
  "label-oeko-organic": "Organic cotton verified, farm to product",
  "label-roc": "Organic plus soil, animals and farmworkers",
  "label-fairtrade-textile": "Fair conditions in textile factories",
  "label-fairtrade-cotton": "Cotton from Fairtrade certified farmers",
  "label-fair-trade-usa": "Social, environmental and economic rules",
  "label-wfto": "Verifies a whole fair trade enterprise",
  "label-fair-for-life": "Fair trade certification across goods",
  "label-fair-wear": "Brand membership for fair garment labour",
  "label-bci": "Cotton farming programme",
  "label-cmia": "Cotton from Sub-Saharan Africa",
  "label-grs": "Recycled content with processing rules",
  "label-rcs": "Recycled content and chain of custody",
  "label-rws": "Welfare and land use on wool farms",
  "label-rds": "Animal welfare for down and feathers",
  "label-rms": "Animal and land responsibility for mohair",
  "label-ras": "Alpaca welfare and their ecosystems",
  "label-downpass": "Down and feathers used as filling",
  "label-gcs": "Cashmere: goats, herders, environment",
  "label-vegan-trademark": "Vegan registration per product",
  "label-peta-vegan": "Textiles free of animal materials",
  "label-oeko-100": "Harmful-substance testing of textiles",
  "label-oeko-mig": "Tested textiles from responsible production",
  "label-bluesign": "Chemicals and products across textile chain",
  "label-eu-ecolabel": "EU's official ecolabel for textiles",
  "label-nordic-swan": "Official Nordic ecolabel for textiles",
  "label-blue-angel": "German government ecolabel for textiles",
  "label-green-button": "German label for company and product",
  "label-c2c": "Multi-attribute standard for products",
  "label-fsc": "Forest-based fibres such as viscose",
};
