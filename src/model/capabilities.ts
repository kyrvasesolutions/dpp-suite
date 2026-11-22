/**
 * What each screen offers, which plan functions it relates to, and how far it can be relied on
 * (assessment criteria §2.3; shared exit criterion Cn-G3). Only "supported" counts towards completeness;
 * the UI shows every other label so a prototype screen is never read as a supported DPP function.
 *
 * A label changes only at a cycle exit, with the evidence that justifies it in the cycle's evidence log.
 */
export const CAPABILITY_LABELS = ["supported", "experimental", "disabled", "untested"] as const;

export type CapabilityLabel = (typeof CAPABILITY_LABELS)[number];

export interface Capability {
  /** The screen, as in the URL hash. */
  id: "profile" | "import" | "record" | "readiness" | "outputs" | "requirements" | "prepare" | "validation" | "mapping" | "graph";
  name: string;
  label: CapabilityLabel;
  /**
   * Plan functions (2_FunctionCatalog) whose N slice this screen delivers, under this screen's label.
   * A function is cited here by one screen only, so it never carries two labels (criteria §2.3).
   */
  functions: string[];
  /** Plan functions this screen goes beyond, as an extension (F3, no completeness credit, criteria §2.6). */
  extends?: string[];
  /**
   * A label of its own for a delivered function whose slice is only partly met, so it never inherits the
   * screen's "supported" (re-assessment R2-3).
   */
  functionLabels?: Record<string, CapabilityLabel>;
  /** One sentence on why the label is what it is. */
  basis: string;
}

export const CAPABILITY_TEXT: Record<CapabilityLabel, string> = {
  supported: "Supported",
  experimental: "Experimental",
  disabled: "Disabled",
  untested: "Untested",
};

/** Labels from the Cycle 0 baseline (20 November 2026) and the Cycle 1 to 3 exits (21 November 2026) and the Cycle 4 exit (22 November 2026), docs/assessment. */
export const CAPABILITIES: Capability[] = [
  {
    id: "profile",
    name: "Profile",
    label: "supported",
    functions: ["FUNC-001", "FUNC-025", "FUNC-027", "FUNC-028", "FUNC-029", "FUNC-030", "FUNC-031", "FUNC-081", "FUNC-085", "FUNC-091"],
    basis: "Cycle 1 exit: the frozen N profile, verified against its pinned files, with every N02 criterion passed.",
  },
  {
    id: "import",
    name: "Import",
    label: "supported",
    functions: ["FUNC-039", "FUNC-017", "FUNC-065"],
    extends: ["FUNC-125"],
    basis: "Cycle 2 exit: strict import of the two N source files with verbatim source assertions, flags and challenged values. The export side of FUNC-125 is on the Outputs screen.",
  },
  {
    id: "record",
    name: "Record",
    label: "untested",
    functions: ["FUNC-005", "FUNC-006", "FUNC-076"],
    basis: "Cycle 5: one record from its sources to each route's output, with status, flags, kind and access, a correction of one value as a new version, and the difference between versions. Not yet independently reviewed.",
  },
  {
    id: "readiness",
    name: "Readiness",
    label: "supported",
    functions: ["FUNC-002", "FUNC-012", "FUNC-126", "FUNC-019", "FUNC-046"],
    basis: "Cycle 3 exit: selected structural, completeness and route checks per route, a fixed recipient matrix and derived disclosure; no conformity claim.",
  },
  {
    id: "outputs",
    name: "Outputs",
    label: "supported",
    functions: ["FUNC-041", "FUNC-042", "FUNC-043", "FUNC-125", "FUNC-022", "FUNC-023", "FUNC-063", "FUNC-064"],
    basis: "Cycle 4 exit: the customer PDF, the ERP staging CSV and the registry preparation draft (on hold), the central record with versions, lineage and the release manifest.",
  },
  {
    id: "requirements",
    name: "Requirements",
    label: "experimental",
    functions: [],
    extends: ["FUNC-001", "FUNC-025", "FUNC-028", "FUNC-043", "FUNC-081"],
    basis: "The wider legal chain and ontology terms, checked against their sources; the N profile itself is on the Profile screen.",
  },
  {
    id: "prepare",
    name: "Prepare",
    label: "experimental",
    functions: [],
    basis: "Data-space joining steps; outside the plan's N, F and P scope.",
  },
  {
    id: "validation",
    name: "Validation",
    label: "untested",
    functions: [],
    extends: ["FUNC-002"],
    basis: "Lists uploaded files only; no values are validated yet. Record checks are on the Readiness screen.",
  },
  {
    id: "mapping",
    name: "Mapping",
    label: "experimental",
    functions: [],
    extends: ["FUNC-012", "FUNC-039", "FUNC-091"],
    basis: "Field names are mapped to requirements; values are not imported and mappings are not executed.",
  },
  {
    id: "graph",
    name: "Graph compliance",
    label: "experimental",
    functions: [],
    extends: ["FUNC-076"],
    basis: "Shows how legislation reaches data requirements; no product record or outputs.",
  },
];

export const capabilityOf = (id: Capability["id"]): Capability => {
  const found = CAPABILITIES.find((c) => c.id === id);
  if (!found) throw new Error(`No capability recorded for screen "${id}"`);
  return found;
};

/** The label a plan function carries in this build: its own label if it has one, otherwise its screen's. */
export const labelOfFunction = (func: string): CapabilityLabel | undefined => {
  const screen = CAPABILITIES.find((c) => c.functions.includes(func));
  return screen ? (screen.functionLabels?.[func] ?? screen.label) : undefined;
};
