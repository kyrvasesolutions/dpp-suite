/**
 * Data spaces as compliance targets, and what a company does to join one.
 *
 * A data space is not law: a company joins to exchange data with its customers, and
 * the "provisions" here are what its standards ask for in a use case. They are our
 * plain-language reading with a link to the source, never quotes: the Catena-X
 * copyright notice does not allow its documents to be copied, so `npm run build-seed`
 * rejects quotes here. `npm run check-data-spaces` checks that each standard is still
 * published in the version recorded.
 *
 * Read for release CX-Titan of the Catena-X Library.
 */
import type { Legislation, Provision } from "./legislation";
import type { Standard, StandardLink } from "./standards";

const LIBRARY = "https://catenax-ev.github.io/docs";
const PARTICIPATE = "https://catena-x.net/de/participate";
const BOTH: Provision["groups"] = ["aluminium", "textile"];
const ALUMINIUM: Provision["groups"] = ["aluminium"];

export const DATA_SPACES: Legislation[] = [
  {
    id: "catena-x",
    short: "Catena-X",
    title: "Automotive data ecosystem",
    ref: "Catena-X Library, release CX-Titan",
    type: "b2b",
    url: `${LIBRARY}/standards/overview`,
    category: "automotive",
    scope: {
      aluminium:
        "For aluminium supplied into vehicles. Not law: you join to exchange data with automotive customers. Its footprint rulebook and tariff standard both address aluminium directly.",
      textile:
        "Only for textile parts supplied into vehicles, such as seat covers. No standard is specific to textiles, and apparel and home textiles are outside its automotive scope.",
    },
  },
];

const cx = (ref: string, slug: string, title: string, path = `standards/${slug}`): Standard => ({
  id: ref.toLowerCase(),
  ref,
  title,
  body: "Catena-X",
  kind: "technical",
  url: `${LIBRARY}/${path}`,
});

/** `title` is the page's own, with its version; `npm run check-data-spaces` compares them. */
export const DATA_SPACE_STANDARDS: Standard[] = [
  cx("CX-0010", "CX-0010-BusinessPartnerNumber", "Business Partner Number v3.0.1"),
  cx("CX-0125", "CX-0125-TraceabilityUseCase", "Traceability Use Case v2.3.1"),
  cx("CX-0126", "CX-0126-IndustryCorePartType", "Industry Core: Part Type 2.1.1"),
  cx("CX-0127", "CX-0127-IndustryCorePartInstance", "Industry Core: Part Instance 2.0.2"),
  cx("CX-0131", "CX-0131-CircularityCore", "Circularity Core v1.1.1"),
  cx("CX-0135", "CX-0135-CompanyCertificateManagement", "Business Partner Company Certificate Management v2.4.0"),
  cx("CX-0136", "CX-0136-UseCasePCF", "Use Case PCF 2.2.2"),
  cx(
    "CX-0143",
    "",
    "Use Case Circular Economy - Digital Product Passport v1.4.0",
    "standards/CX-0143-UseCaseCircularEconomyDigitalProductPassportStandard/introduction",
  ),
  cx("CX-0144", "CX-0144-ESSUseCaseStandard", "ESS Use Case Standard 1.0.1"),
  cx("CX-0153", "CX-0153-TariffsUseCase", "Tariffs Use Case v.2.0.0"),
  cx("CX-0159", "CX-0159-Material-Accounting", "Material Accounting v.1.0.0"),
  { ...cx("CX-NFR-PCF", "", "PCF Rulebook v4.0", "rulebooks/CX-NFR-PCF"), kind: "guideline" },
  { ...cx("CX-NFR-VF", "", "PCF Verification and Certification Framework v2.0", "rulebooks/CX-NFR-VF"), kind: "guideline" },
];

const urlOf = (ref: string) => DATA_SPACE_STANDARDS.find((s) => s.ref === ref)!.url!;

const provision = (dataRequirement: string, refs: string[], groups: Provision["groups"], text: string): Provision => ({
  dataRequirement,
  legislation: "catena-x",
  groups,
  ref: refs.join("; "),
  text,
  url: urlOf(refs[0]),
});

export const DATA_SPACE_PROVISIONS: Provision[] = [
  provision(
    "product-id",
    ["CX-0126", "CX-0127"],
    BOTH,
    "A digital twin for each part type, carrying your manufacturer part ID, and identifiers for each batch or serial part made.",
  ),
  provision(
    "commodity-code",
    ["CX-0153"],
    ALUMINIUM,
    "A customs classification code, such as an HS code, for the part and its materials, to prepare U.S. tariff declarations.",
  ),
  provision(
    "manufacturer",
    ["CX-0010"],
    BOTH,
    "A Business Partner Number for your legal entity, and for each site and address that takes part.",
  ),
  provision(
    "supply-chain-operators",
    ["CX-0125"],
    BOTH,
    "Direct suppliers and customers only: parts link one level up and one level down through as-built bills of material.",
  ),
  provision(
    "material-composition",
    ["CX-0153"],
    ALUMINIUM,
    "The materials in a part containing aluminium, with how its weight and value split across origins.",
  ),
  provision("material-composition", ["CX-0143"], BOTH, "The components and materials of the product, in its passport."),
  provision("substances-of-concern", ["CX-0143"], BOTH, "The chemical substances in the product, in its passport."),
  provision(
    "carbon-footprint",
    ["CX-0136", "CX-NFR-PCF"],
    ALUMINIUM,
    "Product carbon footprint per part type, calculated under Rulebook v4. Its annexes add requirements for users of the European Aluminium and International Aluminium Institute methods.",
  ),
  provision(
    "carbon-footprint",
    ["CX-0136", "CX-NFR-PCF"],
    ["textile"],
    "Product carbon footprint per part type, calculated under Rulebook v4. It has no textile-specific rules, so the general ones apply.",
  ),
  provision("environmental-footprint", ["CX-0143"], BOTH, "The environmental impact of the product, in its passport."),
  provision(
    "recycled-content",
    ["CX-0159", "CX-0131"],
    BOTH,
    "Secondary material flows and content, traced from end of life back into production. Its material classes include aluminium alloys and textiles.",
  ),
  provision("repairability", ["CX-0143"], BOTH, "Reparability information and spare parts, in the passport."),
  provision(
    "end-of-life-info",
    ["CX-0143", "CX-0131"],
    BOTH,
    "Professional disposal information in the passport, with end-of-life and dismantling services alongside it.",
  ),
  provision(
    "production-site",
    ["CX-0127"],
    BOTH,
    "Production date, country and site for each batch or serial part.",
  ),
  provision(
    "production-site",
    ["CX-0153"],
    ALUMINIUM,
    "The countries of origin of the materials, and where steps such as smelting took place.",
  ),
  provision(
    "forced-labour",
    ["CX-0144"],
    BOTH,
    "Environmental and social incidents, including human rights breaches, are passed through the network to the company they arose at.",
  ),
  provision("verification", ["CX-NFR-VF"], BOTH, "Verification and certification of footprint values."),
  provision("verification", ["CX-0135"], BOTH, "Company certificates, such as ISO 9001, shared per site with your partners."),
  provision("dpp", ["CX-0143"], BOTH, "A digital product passport in the Catena-X data model, with its scope aligned to ESPR."),
];

const link = (standardRef: string, dataRequirement: string, note: string, groups?: Provision["groups"]): StandardLink => ({
  legislation: "catena-x",
  standard: standardRef.toLowerCase(),
  dataRequirement,
  basis: "inferred",
  note,
  groups,
});

export const DATA_SPACE_LINKS: StandardLink[] = [
  link("CX-0126", "product-id", "Part type twins and the identifiers on them."),
  link("CX-0127", "product-id", "Batch and serial part twins and their identifiers."),
  link("CX-0127", "production-site", "Manufacturing information on each part instance."),
  link("CX-0153", "commodity-code", "Customs classification for parts containing steel or aluminium.", ALUMINIUM),
  link("CX-0153", "material-composition", "Materials, origins and processing for tariff declarations.", ALUMINIUM),
  link("CX-0153", "production-site", "Materials, origins and processing for tariff declarations.", ALUMINIUM),
  link("CX-0010", "manufacturer", "Identifies legal entities, sites and addresses."),
  link("CX-0125", "supply-chain-operators", "Traces parts one level up and down."),
  link("CX-0143", "material-composition", "The generic passport's data."),
  link("CX-0143", "substances-of-concern", "The generic passport's data."),
  link("CX-0143", "environmental-footprint", "The generic passport's data."),
  link("CX-0143", "repairability", "The generic passport's data."),
  link("CX-0143", "end-of-life-info", "The generic passport's data."),
  link("CX-0143", "dpp", "The generic passport itself."),
  link("CX-0136", "carbon-footprint", "How footprint values are exchanged."),
  link("CX-NFR-PCF", "carbon-footprint", "How footprint values are calculated."),
  link("CX-NFR-VF", "verification", "How footprint values are verified."),
  link("CX-0135", "verification", "How company certificates are exchanged."),
  link("CX-0159", "recycled-content", "Accounts for secondary material along the reverse value chain."),
  link("CX-0131", "recycled-content", "Frames secondary material content and material accounting."),
  link("CX-0131", "end-of-life-info", "Frames end-of-life and dismantling services."),
  link("CX-0144", "forced-labour", "How incidents are raised and passed on."),
];

export interface JoinStep {
  id: string;
  legislation: string;
  /** Null when it applies to every product group. */
  group: Provision["groups"][number] | null;
  title: string;
  detail: string;
  /** The document it rests on. */
  source: string;
  url: string;
}

const step = (
  id: string,
  group: JoinStep["group"],
  title: string,
  detail: string,
  source: string,
  url: string,
): JoinStep => ({ id, legislation: "catena-x", group, title, detail, source, url });

const standard = (ref: string) => urlOf(ref);
const onboarding = `${LIBRARY}/standards/CX-0006-RegistrationAndInitialOnboarding`;
const operations = `${LIBRARY}/operating-model/how-data-space-operations`;

/** In the order a company does them. */
export const JOIN_STEPS: JoinStep[] = [
  step(
    "textile-scope",
    "textile",
    "Check you are in scope",
    "Catena-X serves the automotive value chain and no standard is specific to textiles. Carry on only if you supply parts for vehicles or a customer there asks you to.",
    "Onboarding guide",
    PARTICIPATE,
  ),
  step(
    "use-cases",
    null,
    "Choose your use cases",
    "Decide which exchanges your customers need, such as carbon footprint or traceability. They set the data and applications you need later.",
    "Onboarding guide",
    PARTICIPATE,
  ),
  step(
    "aluminium-use-cases",
    "aluminium",
    "Look at footprint and tariffs first",
    "These two address aluminium directly: the footprint rulebook has annexes for aluminium methods, and CX-0153 covers tariff data for parts containing aluminium.",
    "CX-0153",
    standard("CX-0153"),
  ),
  step(
    "role",
    null,
    "Pick your role",
    "A company exchanging its own data is a data provider and consumer. Some roles need a certificate of conformity from a conformity assessment body before registering.",
    "Operating model",
    `${LIBRARY}/operating-model/who-roles-in-the-catena-x-ecosystem`,
  ),
  step(
    "invitation",
    null,
    "Contact an onboarding service provider",
    "Registration is by invitation: it goes through a certified onboarding service provider or the core service provider. Cofinity-X is one place to start.",
    "CX-0006",
    onboarding,
  ),
  step(
    "registration-data",
    null,
    "Gather your registration data",
    "Company name, full address with country, and VAT ID. A clearing house validates them before your Business Partner Number is issued.",
    "Onboarding guide",
    PARTICIPATE,
  ),
  step(
    "identity",
    null,
    "Pass identity proofing and choose a wallet",
    "The core service provider verifies your identity. Bring your own compliant wallet or have one provided.",
    "CX-0149",
    `${LIBRARY}/standards/CX-0149-WalletRequirements`,
  ),
  step(
    "credentials",
    null,
    "Receive your BPN and credentials",
    "You get a Business Partner Number, and membership, BPN and framework agreement credentials in your wallet. The membership credential completes onboarding.",
    "CX-0006",
    onboarding,
  ),
  step(
    "framework",
    null,
    "Sign the General Data Exchange Framework",
    "Required before you exchange data with partners. Involve your legal team early.",
    "Operating model",
    operations,
  ),
  step(
    "connector",
    null,
    "Get a connector",
    "Every participant needs an Eclipse Dataspace Connector: inside a business application, as a managed service, or run in-house. Involve IT early.",
    "CX-0018",
    `${LIBRARY}/standards/CX-0018-DataspaceConnectivity`,
  ),
  step(
    "certified-solution",
    null,
    "Check certification for your solution",
    "Certified applications are ready to exchange data with other participants. CX-0018 also lists data providers and consumers among roles certified against it, so ask your provider what applies to you.",
    "CX-0018",
    `${LIBRARY}/standards/CX-0018-DataspaceConnectivity`,
  ),
  step(
    "twins",
    null,
    "Model your parts as digital twins",
    "Register part types, then batches or serial parts. An upload tool is an option if you don't integrate your systems directly.",
    "CX-0007",
    `${LIBRARY}/standards/CX-0007-MinimalDataProviderServicesOffering`,
  ),
  step(
    "aluminium-pcf",
    "aluminium",
    "Align your footprint method to the rulebook",
    "If you use the European Aluminium or International Aluminium Institute method, check your calculation against the extra requirements in the rulebook's annexes.",
    "PCF Rulebook",
    standard("CX-NFR-PCF"),
  ),
  step(
    "textile-pcf",
    "textile",
    "Calculate footprints under the general rules",
    "The rulebook has no textile-specific rules, so apply its general ones, and ask your customer what they expect.",
    "PCF Rulebook",
    standard("CX-NFR-PCF"),
  ),
  step(
    "data",
    null,
    "Provide the data your use cases need",
    "Start with what you already hold for legislation: the list alongside shows which data does double duty.",
    "CX-0007",
    `${LIBRARY}/standards/CX-0007-MinimalDataProviderServicesOffering`,
  ),
];
