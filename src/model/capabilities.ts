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
  id: "profile" | "requirements" | "prepare" | "validation" | "mapping" | "graph";
  name: string;
  label: CapabilityLabel;
  /** Plan functions (2_FunctionCatalog) the screen relates to; empty for capabilities outside the plan. */
  functions: string[];
  /** One sentence on why the label is what it is. */
  basis: string;
}

export const CAPABILITY_TEXT: Record<CapabilityLabel, string> = {
  supported: "Supported",
  experimental: "Experimental",
  disabled: "Disabled",
  untested: "Untested",
};

/** Labels from the Cycle 0 baseline assessment of 20 November 2026 (docs/assessment/cycle-0). */
export const CAPABILITIES: Capability[] = [
  {
    id: "profile",
    name: "Profile",
    label: "untested",
    functions: ["FUNC-001", "FUNC-025", "FUNC-027", "FUNC-028", "FUNC-029", "FUNC-030", "FUNC-031", "FUNC-081", "FUNC-085", "FUNC-091"],
    basis: "New in Cycle 1: shows the frozen N profile from its pinned files; not yet assessed at a cycle exit.",
  },
  {
    id: "requirements",
    name: "Requirements",
    label: "experimental",
    functions: ["FUNC-025", "FUNC-028", "FUNC-081", "FUNC-001", "FUNC-043"],
    basis: "Legal text and terms are checked against their sources, but not against the frozen N profile.",
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
    functions: ["FUNC-002"],
    basis: "Lists uploaded files only; no values are validated yet.",
  },
  {
    id: "mapping",
    name: "Mapping",
    label: "experimental",
    functions: ["FUNC-039", "FUNC-091", "FUNC-012"],
    basis: "Field names are mapped to requirements; values are not imported and mappings are not executed.",
  },
  {
    id: "graph",
    name: "Graph compliance",
    label: "experimental",
    functions: ["FUNC-076"],
    basis: "Shows how legislation reaches data requirements; no product record or outputs.",
  },
];

export const capabilityOf = (id: Capability["id"]): Capability => {
  const found = CAPABILITIES.find((c) => c.id === id);
  if (!found) throw new Error(`No capability recorded for screen "${id}"`);
  return found;
};
