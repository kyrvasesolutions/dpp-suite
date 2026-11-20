/**
 * IDTA submodel templates for the Asset Administration Shell, as vocabularies: each
 * template is an ontology, the elements that define a data requirement are its terms,
 * and the elements that hold a value are data points.
 *
 * `npm run fetch-idta` reads the templates into db/source/idta-submodels.json.
 */
import type { TermMatch } from "./ontologies";

export const IDTA_REPOSITORY = "admin-shell-io/submodel-templates";

export interface IdtaTemplate {
  /** The IDTA number, e.g. "02023" or, for a part, "02035-3". */
  id: string;
  name: string;
  /** Under `published/` in the repository. */
  folder: string;
}

export const IDTA_TEMPLATES: IdtaTemplate[] = [
  { id: "02099-1", name: "Digital Product Passport, Part 1", folder: "Digital Product Passport/Digital Product Passport Part-1" },
  { id: "02006", name: "Digital Nameplate", folder: "Digital nameplate" },
  { id: "02023", name: "Carbon Footprint", folder: "Carbon Footprint" },
  { id: "02003", name: "Technical Data", folder: "Technical_Data" },
  { id: "02004", name: "Handover Documentation", folder: "Handover Documentation" },
  { id: "02002", name: "Contact Information", folder: "Contact Information" },
  { id: "02011", name: "Hierarchical Structures enabling Bills of Material", folder: "Hierarchical Structures enabling Bills of Material" },
  { id: "02080", name: "Material Data for Plastic Waste", folder: "Material Data for Plastic Waste" },
];

/**
 * The element of a template that defines a data requirement, and how closely: the
 * same reading as `RequirementTerm`. The build fails on a path the template lacks.
 */
export interface IdtaRequirementTerm {
  dataRequirement: string;
  template: string;
  /** The element's idShort path; empty for the submodel as a whole. */
  element: string;
  match: TermMatch;
  /** Our reading of where the element and the data requirement differ. */
  note?: string;
}

export const IDTA_REQUIREMENT_TERMS: IdtaRequirementTerm[] = [
  { dataRequirement: "product-id", template: "02099-1", element: "uniqueProductIdentifier", match: "exact" },
  {
    dataRequirement: "commodity-code",
    template: "02003",
    element: "ProductClassifications/ProductClassification",
    match: "broad",
    note: "A class in any classification system; the CN or HS code would be one such entry.",
  },
  { dataRequirement: "manufacturer", template: "02006", element: "ManufacturerName", match: "close", note: "The name." },
  {
    dataRequirement: "manufacturer",
    template: "02002",
    element: "ContactInformation",
    match: "close",
    note: "The contact details; they can also be those of a service provider.",
  },
  {
    dataRequirement: "importer",
    template: "02099-1",
    element: "economicOperatorId",
    match: "broad",
    note: "Identifies any actor in the product's life cycle, of which the importer is one.",
  },
  {
    dataRequirement: "producer-registration",
    template: "02099-1",
    element: "economicOperatorId",
    match: "broad",
    note: "An identifier for any actor; the acts mean a number in a national register of producers.",
  },
  {
    dataRequirement: "supply-chain-operators",
    template: "02099-1",
    element: "economicOperatorId",
    match: "close",
    note: "Identifies the actor, without naming its role in the chain.",
  },
  {
    dataRequirement: "material-composition",
    template: "02080",
    element: "InformationCharacteristics",
    match: "narrow",
    note: "Plastic waste material only, not a finished product's full composition.",
  },
  {
    dataRequirement: "substances-of-concern",
    template: "02080",
    element: "InformationCharacteristics/PresenceOfModifyingAdditives",
    match: "narrow",
    note: "Additives in plastic material, by name and CAS number; ESPR sets its own legal definition of the wider class.",
  },
  {
    dataRequirement: "carbon-footprint",
    template: "02023",
    element: "ProductCarbonFootprints",
    match: "close",
    note: "Embedded emissions under CBAM have a narrower boundary.",
  },
  {
    dataRequirement: "environmental-footprint",
    template: "02023",
    element: "ProductCarbonFootprints",
    match: "narrow",
    note: "Greenhouse gases only, one indicator among the several a multi-indicator footprint reports.",
  },
  {
    dataRequirement: "precursors",
    template: "02011",
    element: "EntryNode/HasPart",
    match: "broad",
    note: "Links a product to its components; each input's embedded emissions would sit in that component's own carbon footprint submodel.",
  },
  {
    dataRequirement: "recycled-content",
    template: "02080",
    element: "InformationCharacteristics/RecycledContent",
    match: "narrow",
    note: "Recycled plastic only, as calculated under EN 18065.",
  },
  { dataRequirement: "production-site", template: "02006", element: "CountryOfOrigin", match: "close", note: "The country." },
  { dataRequirement: "production-site", template: "02099-1", element: "facilityId", match: "close", note: "The site." },
  {
    dataRequirement: "chain-of-custody",
    template: "02080",
    element: "InformationCharacteristics/ChainOfCustody",
    match: "narrow",
    note: "The attribution model for plastic waste material, not custody records along a whole supply chain.",
  },
  {
    dataRequirement: "conformity",
    template: "02006",
    element: "AssetSpecificProperties/GuidelineSpecificProperties/item1/GuidelineForConformityDeclaration",
    match: "close",
    note: "Names what conformity was determined against, not the declaration itself.",
  },
  {
    dataRequirement: "verification",
    template: "02006",
    element: "Markings/Marking/DesignationOfCertificateOrApproval",
    match: "broad",
    note: "Identifies a certificate or approval, whoever issued it; says nothing of third-party independence.",
  },
  {
    dataRequirement: "verification",
    template: "02080",
    element: "InformationCharacteristics/CertificateOfAnalysis",
    match: "narrow",
    note: "An inspection certificate for plastic waste material under EN 10204.",
  },
  {
    dataRequirement: "performance",
    template: "02003",
    element: "TechnicalPropertyAreas",
    match: "broad",
    note: "Holds any technical properties; the template leaves which ones to the product class.",
  },
  {
    dataRequirement: "performance",
    template: "02080",
    element: "PropertyCharacteristics",
    match: "narrow",
    note: "Measured properties of plastic waste material only.",
  },
  { dataRequirement: "dpp", template: "02099-1", element: "", match: "exact" },
  {
    dataRequirement: "instructions",
    template: "02004",
    element: "Documents/Document",
    match: "broad",
    note: "Metadata for any handed-over document; instructions and safety information are classes of document.",
  },
  {
    dataRequirement: "label",
    template: "02006",
    element: "Markings/Marking",
    match: "close",
    note: "A marking such as CE and its symbol, not all the text a label must carry.",
  },
];

/** IDTA elements are named by semantic IDs, many of which are not web addresses that open. */
export const isIdtaOntology = (ontology: string) => ontology.startsWith("idta-");
