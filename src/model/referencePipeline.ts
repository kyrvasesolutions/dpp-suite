/**
 * Executable TypeScript pipeline for the pinned reference specification (Cycle 9: C9-02..C9-06).
 *
 * Executes the pinned contracts directly from `pack.contracts` (with ZERO hard-coded private
 * property IDs so both the private pack and the synthetic public stand-in share one code path):
 *   - Import: SRC-ERP-CSV-01 + SRC-LAB-JSON-01 via MAP-IMP-ERP-01 + MAP-IMP-LAB-01 -> REC-ALU-24-01 (DPPPayload)
 *   - Outcomes: IMPORTED | IMPORTED_WITH_SHAPE_ISSUES | REJECT; route status RELEASED | HOLD
 *   - Exports:
 *       1. customer -> TARGET-CUSTOMER-JSON-01 (leaf-allowlisted projection; EN & DE; metros; derived RC & Pb)
 *       2. internal -> TARGET-INTERNAL-CSV-01 (12-column formula-safe staging CSV)
 *       3. registry -> RegistryRequest (always HOLD: TARGET_PROFILE_UNCONFIRMED, not_a_registration_request: true)
 *   - Typed context validation (S5-SEM-CONTEXT-rev2) & deterministic manifest verification (REF-14..16).
 */
import { canonical } from "./canonical";
import { validateOperationContext, type OperationContext } from "./context";
import { sha256Hex, type PinnedReferenceContracts, type ProfilePack, type Route } from "./profile";
import { checkBoundedSchema } from "./recordSchemaCheck";

export type ReferenceImportStatus = "IMPORTED" | "IMPORTED_WITH_SHAPE_ISSUES" | "REJECT";
export type ReferenceRouteStatus = "RELEASED" | "RELEASED_REFERENCE_VIEW" | "HOLD";

export interface RawSourceFile {
  source_id: "SRC-ERP-CSV-01" | "SRC-LAB-JSON-01";
  media_type: "text/csv" | "application/json";
  raw_content: string;
  sha256: string;
}

export interface ReferenceAssertion {
  assertion_id: string;
  property_id: string;
  source_id: string;
  source_paths: string[];
  source_values: Record<string, unknown>;
  mapped_value: unknown;
  mapping_id: string;
  mapping_version: string;
  presence: "present" | "missing";
  challenge_status: string;
  source_assurance: string;
}

export interface DppPayloadRecord {
  "@context": Record<string, unknown>;
  record_id: string;
  revision: string;
  synthetic: true;
  properties: Record<string, unknown>;
  assertions: ReferenceAssertion[];
  source_files: RawSourceFile[];
  metadata: {
    assessment_context: Record<string, unknown>;
    recycled_context: Record<string, unknown>;
    cost_context: Record<string, unknown>;
    methods: unknown[];
    interpretation_resource_digests: Record<string, string>;
  };
  issues: Array<Record<string, unknown>>;
}

export interface ReferenceImportResult {
  status: ReferenceImportStatus;
  record: DppPayloadRecord | null;
  source_files: RawSourceFile[];
  raw_assertions: Array<{ source_id: string; path: string; raw_value: unknown }>;
  private_issues: string[];
}

export interface SafeHoldEnvelope {
  status: "HOLD";
  synthetic: true;
  code: string;
  message: string;
}

export interface CustomerProjectionPayload {
  product_model: string;
  designation: string;
  alloy: string;
  temper: string;
  customer_material_code: string;
  nominal_dimensions_m: { thickness: number; width: number; length: number };
  recycled_content: {
    declared_percent: number;
    basis: {
      basis_id: string;
      numerator: string;
      denominator: string;
      includes: string;
      excludes: string[];
      mass_unit: string;
    };
    method: string;
    qualification: string;
  };
  carbon_footprint: {
    value: number;
    unit: string;
    reference_quantity: {
      id: string;
      quantity: number;
      unit: string;
      basis_type: string;
      reference_product: string;
    };
    method: { id: string; version: string; conformity_status: string };
    boundary: { id: string; label: string; included: string[]; excluded: string[]; module_assignment: unknown };
    representativeness: { id: string; period: string; geography: string; coverage: string; batch_specific: boolean };
    qualification: string;
  };
  description: { language: string; text: string; text_revision: string };
  lead_screening: { statement: string; rule_id: string; rule_version: string; qualification: string };
}

export type CustomerRouteOutput =
  | { status: "RELEASED_REFERENCE_VIEW"; synthetic: true; payload: CustomerProjectionPayload; scope: string }
  | SafeHoldEnvelope;

export type InternalRouteOutput =
  | { status: "RELEASED_REFERENCE_VIEW"; synthetic: true; csv: string; scope: string }
  | SafeHoldEnvelope;

export interface RegistryRequestEnvelope extends SafeHoldEnvelope {
  not_a_registration_request: true;
  semantic_core_metadata_preview: {
    digitalProductPassportId: string;
    uniqueProductIdentifier: string;
    granularity: string;
    dppStatus: null;
    lastUpdate: string;
    contentSpecificationIds: string[];
  };
  limitations: string[];
}

export interface RoutePrivateDiagnostic {
  kind: string;
  property_id?: string;
  scope?: string;
  private_detail?: string;
}

export interface ReferenceExecutionResult {
  status: "EXECUTED_REFERENCE" | "RESOURCE_REJECT";
  resource_errors?: string[];
  import?: ReferenceImportResult;
  outputs?: {
    customer: CustomerRouteOutput;
    internal: InternalRouteOutput;
    registry: RegistryRequestEnvelope;
  };
  private_diagnostics?: Record<Route, RoutePrivateDiagnostic[]>;
  manifest?: Record<string, unknown>;
}

// ── Helpers ──

const IMPORT_OPERATORS = new Set([
  "lookup_model",
  "string",
  "designation",
  "batch_identifier",
  "manufacturer",
  "site",
  "alloy",
  "temper",
  "nominal_mm",
  "recycled_fraction",
  "pre_consumer_assertion",
  "customer_identifier",
  "cost",
  "measurement_array",
  "copy",
  "array",
]);

const EXPORT_OPERATORS = new Set([
  "customer_identity_nominal",
  "recycled_check",
  "compatible_assessment_projection",
  "authorised_language",
  "synthetic_guard_band_screen",
  "internal_csv",
  "registry_preparation",
]);

class RouteHold extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteHold";
  }
}

export function canonicalDigest(value: unknown): Promise<string> {
  return sha256Hex(canonical(value));
}

export function parseNumericStrict(value: unknown): number {
  if (typeof value === "boolean") throw new Error("Boolean is not a numeric quantity");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number rejected");
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error("Non-finite number rejected");
    return n;
  }
  throw new Error("Invalid numeric quantity");
}

function atPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split(".")) {
    if (typeof cur !== "object" || cur === null || !(key in (cur as Record<string, unknown>))) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** RFC 4180 comma CSV parser returning array of row objects (preserves exact cell strings). */
export function parseCommaCsvRows(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        cell += ch;
        i++;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
      i++;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else {
      cell += ch;
      i++;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0]!;
  return rows.slice(1).filter((r) => !(r.length === 1 && r[0] === "")).map((r) => {
    const rec: Record<string, string> = {};
    header.forEach((h, idx) => {
      rec[h] = r[idx] ?? "";
    });
    return rec;
  });
}

/** Explicit leaf allowlist projection: nested private members never inherit permission (REF-23, REF-24). */
export function projectFields<T extends Record<string, unknown>>(obj: Record<string, unknown>, allowed: readonly (keyof T & string)[]): T {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (!Object.hasOwn(obj, key)) throw new RouteHold(`missing_projected_leaf:${key}`);
    out[key] = structuredClone(obj[key]);
  }
  return out as T;
}

export function safeHoldEnvelope(code = "REQUIREMENTS_NOT_SATISFIED"): SafeHoldEnvelope {
  return {
    status: "HOLD",
    synthetic: true,
    code,
    message: "This route is not releasable. An authorised internal operator can inspect the detailed reason.",
  };
}

/** Resolves a property ID from the pinned catalogue by semantic URI suffix (never hard-codes private property IDs). */
export function propIdBySemanticSuffix(contracts: PinnedReferenceContracts, suffix: string): string {
  const found = contracts.catalogue.find((p) => p.semantic_uri.endsWith(`/${suffix}`));
  if (!found) throw new Error(`Pinned catalogue has no property ending with /${suffix}`);
  return found.id;
}

/** Validates resource integrity before execution (matches run_reference.py validate_resources). */
export function validateReferenceContracts(contracts: PinnedReferenceContracts): string[] {
  const errors: string[] = [];
  const expectedIds = new Set(contracts.catalogue.map((p) => p.id));
  if (expectedIds.size !== 24) errors.push("Duplicate business property identity");
  for (const p of contracts.catalogue) {
    if (contracts.contextLd["@context"][p.id] !== p.semantic_uri) {
      errors.push("Context/property semantic identity mismatch");
      break;
    }
  }
  const importTargets: string[] = [];
  for (const m of [contracts.importErp, contracts.importLab, contracts.exportCustomer, contracts.exportInternal, contracts.exportRegistry]) {
    const ops = m.direction === "import" ? IMPORT_OPERATORS : EXPORT_OPERATORS;
    if (m.rules.some((r) => !ops.has(r.operator))) errors.push(`Unapproved operator in ${m.id}`);
    if (m.direction === "import") importTargets.push(...m.rules.map((r) => r.target));
  }
  if (importTargets.length !== 24 || importTargets.some((t) => !expectedIds.has(t))) {
    errors.push("Import contracts do not cover each selected property exactly once");
  }
  const expectedGroups: Record<string, string[]> = {
    exportCustomer: ["customer_identity_nominal", "recycled_check", "compatible_assessment_projection", "authorised_language", "synthetic_guard_band_screen"],
    exportInternal: ["internal_csv"],
    exportRegistry: ["registry_preparation"],
  };
  for (const [key, group] of Object.entries(expectedGroups)) {
    const actual = (contracts[key as "exportCustomer" | "exportInternal" | "exportRegistry"]).rules.map((r) => r.operator);
    if (JSON.stringify(actual) !== JSON.stringify(group)) errors.push(`Unsupported export operator composition: ${key}`);
  }
  const routeMap = [
    ["customer", contracts.exportCustomer],
    ["internal", contracts.exportInternal],
    ["registry", contracts.exportRegistry],
  ] as const;
  for (const [route, exp] of routeMap) {
    const mapped = new Set(exp.rules.flatMap((r) => r.selector));
    const req = new Set(contracts.profilePolicy[route].route_required_source_properties);
    if (mapped.size !== req.size || [...mapped].some((x) => !req.has(x))) {
      errors.push(`Export selectors/profile dependency mismatch: ${route}`);
    }
  }
  if (contracts.profilePolicy.registry.aluminium_registration_profile_confirmed !== false) {
    errors.push("A flag cannot establish an unsupported aluminium registration contract");
  }
  return errors;
}

function makeIdentifier(value: string, scheme: string, issuer: string) {
  return { value, scheme_id: scheme, scheme_version: "1.0.0", issuer_ref: issuer };
}

function evalErpOperator(
  operator: string,
  raw: Record<string, unknown>,
  row: Record<string, string>,
  lookup: ReferenceCodeListEntry,
  _standIn: boolean,
  customerRecipient: string,
): unknown {
  if (Object.values(raw).some((v) => v === null || v === undefined || v === "")) return null;
  const first = String(Object.values(raw)[0]);
  const pfx = customerRecipient.split("-")[0] ?? "ST";
  const modelScheme = `${pfx}-PRODUCT-MODEL`;
  const batchScheme = `${pfx}-BATCH`;
  const custScheme = `${pfx}-CUSTOMER-MATERIAL`;
  if (operator === "lookup_model") return makeIdentifier(lookup.model_id, modelScheme, row.manufacturer_id!);
  if (operator === "string") return first;
  if (operator === "designation") {
    return { designation: first, reference_family: "synthetic_5754_alloy_family", reference_relationship: "fictional_instance", record_is_synthetic: true };
  }
  if (operator === "batch_identifier") return makeIdentifier(first, batchScheme, row.manufacturer_id!);
  if (operator === "manufacturer") {
    return { party_id: row.manufacturer_id!, legal_name: row.manufacturer_name!, role: "manufacturer", identity_status: "synthetic_fixture", jurisdiction: "DE" };
  }
  if (operator === "site") return { site_id: row.site_id!, country: row.site_country!, operator_party_id: row.manufacturer_id! };
  if (operator === "alloy") {
    if (first !== "5754") throw new Error("Unsupported alloy code");
    return { system: "EN AW", designation: "EN AW-5754", family: "synthetic_5754_alloy_family" };
  }
  if (operator === "temper") {
    if (first !== "O") throw new Error("Unsupported temper code");
    return { system: "aluminium_temper_designation", designation: first, selection_status: "synthetic_instance" };
  }
  if (operator === "nominal_mm") return { value: parseNumericStrict(first), unit_id: "mm", quantity_kind: "length", value_kind: "nominal_specification" };
  if (operator === "recycled_fraction") return { value: parseNumericStrict(first), unit_id: "%", quantity_kind: "mass_fraction", basis: "RC-BASIS-001", value_kind: "declared_synthetic" };
  if (operator === "pre_consumer_assertion") {
    return { preferred_assertion: { value: parseNumericStrict(first), unit_id: "%", evidence_ref: "EV-RC-DECL-001" }, conflicting_assertion: null, resolution_status: "no_conflict_reported" };
  }
  if (operator === "customer_identifier") return [makeIdentifier(first, custScheme, customerRecipient)];
  if (operator === "cost") return { value: parseNumericStrict(first), currency: "EUR", denominator_unit: "kg", context_ref: "COST-CONTEXT-001", value_kind: "synthetic_cost_estimate" };
  throw new Error(`Unsupported import operator ${operator}`);
}

type ReferenceCodeListEntry = PinnedReferenceContracts["codeList"]["entries"][number];

/** Executes MAP-IMP-ERP-01 and MAP-IMP-LAB-01, producing REC-ALU-24-01 (DPPPayload) and raw source preservation. */
export async function importReferencePair(
  erpText: string,
  lab: Record<string, unknown>,
  contracts: PinnedReferenceContracts,
  options: { standIn?: boolean; labRawText?: string } = {},
): Promise<ReferenceImportResult> {
  const labText = options.labRawText ?? `${JSON.stringify(lab, null, 2)}\n`;
  if (JSON.stringify(JSON.parse(labText)) !== JSON.stringify(lab)) {
    throw new Error("Raw JSON does not match parsed source");
  }
  const sources: RawSourceFile[] = [
    { source_id: "SRC-ERP-CSV-01", media_type: "text/csv", raw_content: erpText, sha256: await sha256Hex(erpText) },
    { source_id: "SRC-LAB-JSON-01", media_type: "application/json", raw_content: labText, sha256: await sha256Hex(labText) },
  ];
  const rows = parseCommaCsvRows(erpText);
  const rawAssertions: Array<{ source_id: string; path: string; raw_value: unknown }> = [];
  rows.forEach((row, idx) => {
    for (const [k, v] of Object.entries(row)) {
      rawAssertions.push({ source_id: "SRC-ERP-CSV-01", path: `row[${idx}].${k}`, raw_value: v });
    }
  });
  const rejectWith = (msg: string): ReferenceImportResult => ({
    status: "REJECT",
    record: null,
    source_files: sources,
    raw_assertions: rawAssertions,
    private_issues: [msg],
  });

  if (rows.length !== 1) return rejectWith("CSV requires exactly one data row");
  const row = rows[0]!;
  const matches = contracts.codeList.entries.filter(
    (x) => x.source_company === row.source_company && x.code_list_version === row.code_list_version && x.material_code === row.material_code,
  );
  if (matches.length !== 1) return rejectWith("Unknown or duplicate company-code lookup");
  if (lab.synthetic !== true || lab.batch_id !== row.batch_id) return rejectWith("Synthetic marker or batch identity mismatch");

  const allowedIds = new Set(contracts.catalogue.map((p) => p.id));
  const overrides = (lab.state_overrides ?? {}) as Record<string, { challenge_status?: string; source_assurance?: string }>;
  for (const key of Object.keys(overrides)) {
    if (!allowedIds.has(key)) return rejectWith("Unknown property state override");
  }

  const standIn = options.standIn ?? false;
  const values: Record<string, unknown> = {};
  const assertions: ReferenceAssertion[] = [];
  const issues: Array<Record<string, unknown>> = [];

  try {
    for (const [contract, source] of [
      [contracts.importErp, row],
      [contracts.importLab, lab],
    ] as const) {
      for (const rule of contract.rules) {
        const raw: Record<string, unknown> = {};
        for (const p of rule.selector) {
          raw[p] = atPath(source, p);
          rawAssertions.push({ source_id: contract.source_contract, path: p, raw_value: structuredClone(raw[p]) });
        }
        if (contract.direction !== "import") throw new Error("Wrong direction");
        let value: unknown;
        if (contract.id === "MAP-IMP-ERP-01") {
          value = evalErpOperator(rule.operator, raw, row, matches[0]!, standIn, contracts.profilePolicy.customer.recipient);
        } else {
          value = structuredClone(Object.values(raw)[0]);
          if (value !== null && value !== undefined && (rule.operator === "array" || rule.operator === "measurement_array")) {
            if (rule.operator === "measurement_array" && typeof value === "object") {
              (value as Record<string, unknown>).batch_id = row.batch_id;
            }
            value = [value];
          } else if (rule.operator !== "copy" && value !== null && value !== undefined) {
            throw new Error("Unsupported JSON import operator");
          }
        }
        const prop = rule.target;
        values[prop] = value ?? null;
        const st = overrides[prop] ?? {};
        assertions.push({
          assertion_id: `ASSERT-${rule.id}`,
          property_id: prop,
          source_id: contract.source_contract,
          source_paths: Object.keys(raw),
          source_values: structuredClone(raw),
          mapped_value: structuredClone(value ?? null),
          mapping_id: contract.id,
          mapping_version: contract.version,
          presence: value === null || value === undefined ? "missing" : "present",
          challenge_status: st.challenge_status ?? "none",
          source_assurance: st.source_assurance ?? String(lab.source_assurance ?? ""),
        });
      }
    }

    // Handle conflicting pre-consumer recycled content (REF-07)
    const preProp = propIdBySemanticSuffix(contracts, "preConsumerRecycledContent");
    const conflict = atPath(lab, "recycled_content.conflicting_pre_percent");
    if (conflict !== null && conflict !== undefined) {
      const c = { value: parseNumericStrict(conflict), unit_id: "%", evidence_ref: "EV-RC-CONFLICT-001" };
      const preVal = values[preProp] as Record<string, unknown> | null;
      if (preVal && typeof preVal === "object") {
        preVal.conflicting_assertion = c;
        preVal.resolution_status = "unresolved";
      }
      for (const a of assertions) {
        if (a.property_id === preProp) {
          a.challenge_status = "open";
          a.mapped_value = structuredClone(values[preProp]);
        }
      }
      assertions.push({
        assertion_id: "ASSERT-RC-CONFLICT",
        property_id: preProp,
        source_id: "SRC-LAB-JSON-01",
        source_paths: ["recycled_content.conflicting_pre_percent"],
        source_values: { "recycled_content.conflicting_pre_percent": conflict },
        mapped_value: c,
        mapping_id: contracts.importLab.id,
        mapping_version: contracts.importLab.version,
        presence: "present",
        challenge_status: "open",
        source_assurance: String(lab.source_assurance ?? ""),
      });
      issues.push({
        id: "ISSUE-RC-001",
        property_id: preProp,
        kind: "conflicting_source_assertions",
        requires_followup: "external clarification; no review execution in reference package",
      });
    }

    for (const a of assertions) {
      if (a.presence === "missing") issues.push({ property_id: a.property_id, kind: "missing_source_value" });
    }

    const baseUri = String(contracts.contextLd["@context"]["@base"] ?? "https://standin.example/demo/");
    const rcRaw = (lab.recycled_content ?? {}) as Record<string, unknown>;
    const recycledContext: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rcRaw)) {
      if (k !== "evidence" && k !== "conflicting_pre_percent") recycledContext[k] = structuredClone(v);
    }

    const record: DppPayloadRecord = {
      "@context": structuredClone(contracts.contextLd["@context"]),
      record_id: `${baseUri}${matches[0]!.model_id}`,
      revision: "pending_digest",
      synthetic: true,
      properties: values,
      assertions,
      source_files: sources,
      metadata: {
        assessment_context: structuredClone((lab.assessment as Record<string, unknown>).context as Record<string, unknown>),
        recycled_context: recycledContext,
        cost_context: structuredClone(lab.cost_context as Record<string, unknown>),
        methods: structuredClone(lab.methods as unknown[]),
        interpretation_resource_digests: {
          catalogue: await canonicalDigest(contracts.catalogue),
          record_schema: await canonicalDigest(contracts.recordSchema),
          context: await canonicalDigest(contracts.contextLd),
          code_list: await canonicalDigest(contracts.codeList),
          import_erp: await canonicalDigest(contracts.importErp),
          import_lab: await canonicalDigest(contracts.importLab),
        },
      },
      issues,
    };

    const shapeErrors = checkBoundedSchema(record, contracts.recordSchema);
    if (shapeErrors.length > 0) {
      for (const e of shapeErrors) {
        record.issues.push({ kind: "selected_record_shape_error", private_detail: e });
      }
    }
    const { revision: _rev, ...withoutRev } = record;
    record.revision = await canonicalDigest(withoutRev);

    return {
      status: shapeErrors.length === 0 ? "IMPORTED" : "IMPORTED_WITH_SHAPE_ISSUES",
      record,
      source_files: sources,
      raw_assertions: rawAssertions,
      private_issues: shapeErrors,
    };
  } catch (err) {
    return rejectWith(err instanceof Error ? err.message : String(err));
  }
}

function collectRouteIssues(record: DppPayloadRecord, contracts: PinnedReferenceContracts, route: Route): RoutePrivateDiagnostic[] {
  const policy = contracts.profilePolicy;
  const req = policy[route];
  const values = record.properties;
  const issues: RoutePrivateDiagnostic[] = [];
  if (record.issues.some((i) => i.kind === "selected_record_shape_error")) {
    issues.push({ kind: "selected_record_structure_invalid" });
  }
  for (const prop of req.route_required_source_properties) {
    if (req.deny_processing_properties.includes(prop) || !req.permitted_processing_properties.includes(prop)) {
      issues.push({ property_id: prop, kind: "processing_not_permitted" });
    }
    if (values[prop] === null || values[prop] === undefined) {
      issues.push({ property_id: prop, kind: "required_source_missing" });
      continue;
    }
    const related = record.assertions.filter((a) => a.property_id === prop);
    if (related.length === 0) issues.push({ property_id: prop, kind: "assertion_provenance_missing" });
    if (related.some((a) => a.challenge_status !== "none")) issues.push({ property_id: prop, kind: "unresolved_source_challenge" });
    if (related.some((a) => a.source_assurance !== policy.source_assurance_required)) issues.push({ property_id: prop, kind: "source_state_not_accepted" });
  }
  return issues;
}

function buildCustomerProjection(
  record: DppPayloadRecord,
  contracts: PinnedReferenceContracts,
  languageOverride?: string,
): CustomerRouteOutput {
  const p = record.properties as Record<string, any>;
  const policy = contracts.profilePolicy;
  const profile = policy.customer;
  const id = (suffix: string) => propIdBySemanticSuffix(contracts, suffix);

  const idModel = id("productModelIdentifier");
  const idRev = id("productDefinitionRevision");
  const idDesig = id("commercialProductDesignation");
  const idAlloy = id("alloyDesignation");
  const idTemper = id("temperDesignation");
  const idNomT = id("nominalSheetThickness");
  const idNomW = id("nominalSheetWidth");
  const idNomL = id("nominalSheetLength");
  const idRcTotal = id("declaredTotalRecycledContent");
  const idRcPre = id("preConsumerRecycledContent");
  const idRcPost = id("postConsumerRecycledContent");
  const idRcBasis = id("recycledContentMassBasis");
  const idPcf = id("productCarbonFootprintResult");
  const idTexts = id("authorisedProductDescriptions");
  const idCustCode = id("customerMaterialCode");
  const idLead = id("measuredLeadMassFraction");

  const directOutputDeps = new Set([idModel, idRev, idDesig, idAlloy, idTemper, idNomT, idNomW, idNomL, idRcTotal, idRcBasis, idPcf, idTexts, idCustCode]);
  if (profile.forbid_raw_disclosure.some((f) => directOutputDeps.has(f))) {
    throw new RouteHold("required_raw_output_disclosure_denied");
  }

  // Nominal dimensions mm -> m (A-08)
  const dims: { thickness: number; width: number; length: number } = { thickness: 0, width: 0, length: 0 };
  for (const [name, prop] of [
    ["thickness", idNomT],
    ["width", idNomW],
    ["length", idNomL],
  ] as const) {
    const q = p[prop];
    if (!q || q.unit_id !== "mm" || q.quantity_kind !== "length" || q.value_kind !== "nominal_specification") {
      throw new RouteHold("nominal_dimension_semantics");
    }
    const n = parseNumericStrict(q.value);
    if (n <= 0) throw new RouteHold("non_positive_dimension");
    dims[name] = n / 1000;
  }

  // Recycled content derived representation (recycled_total_with_basis)
  const total = parseNumericStrict(p[idRcTotal].value);
  const pre = parseNumericStrict(p[idRcPre].preferred_assertion.value);
  const post = parseNumericStrict(p[idRcPost].value);
  if (Math.abs(total - pre - post) > 1e-9) throw new RouteHold("recycled_balance_mismatch");
  if (p[idRcTotal].basis !== p[idRcBasis].basis_id || p[idRcPost].basis !== p[idRcBasis].basis_id) {
    throw new RouteHold("recycled_basis_mismatch");
  }
  const rc = record.metadata.recycled_context as Record<string, unknown>;
  const expectedRcMethod = `${policy.customer.recipient.split("-")[0] ?? "ST"}-RC-PHYSICAL-01`;
  if (rc.method_id !== expectedRcMethod || rc.eligibility !== "synthetic_fixture_eligible_under_demo_method") {
    throw new RouteHold("recycled_method_or_eligibility");
  }
  if (!profile.allowed_derived_representations.includes("recycled_total_with_basis")) {
    throw new RouteHold("derived_recycled_disclosure_denied");
  }
  const publicBasis = projectFields<CustomerProjectionPayload["recycled_content"]["basis"]>(p[idRcBasis], [
    "basis_id",
    "numerator",
    "denominator",
    "includes",
    "excludes",
    "mass_unit",
  ]);

  // Carbon footprint compatibility
  if (!Array.isArray(p[idPcf]) || p[idPcf].length !== 1) throw new RouteHold("assessment_selection_ambiguous");
  const result = p[idPcf][0];
  const ctx = record.metadata.assessment_context as Record<string, any>;
  const subject = `${p[idModel].value}/${p[idRev]}`;
  if (ctx.reference_unit.reference_product !== subject) throw new RouteHold("footprint_subject_revision_mismatch");
  if (
    result.method_ref !== profile.expected_pcf_method ||
    result.reference_unit !== profile.expected_reference_unit ||
    result.system_boundary !== profile.expected_boundary
  ) {
    throw new RouteHold("footprint_semantics_incompatible");
  }
  if (
    result.method_ref !== ctx.method.id ||
    result.reference_unit !== ctx.reference_unit.id ||
    result.system_boundary !== ctx.boundary.id ||
    result.allocation !== ctx.allocation.id ||
    result.period !== ctx.representativeness.id ||
    result.geography !== ctx.representativeness.id
  ) {
    throw new RouteHold("footprint_context_unresolved");
  }
  if (result.unit_id !== "kg_CO2e" || ctx.reference_unit.quantity !== 1 || ctx.reference_unit.unit !== "kg") {
    throw new RouteHold("footprint_unit_or_basis");
  }

  // Authorised description (language = en or de, REF-17)
  const lang = languageOverride ?? profile.language;
  const texts = (p[idTexts] as Array<Record<string, any>>).filter(
    (t) =>
      t.subject_ref === subject &&
      t.language === lang &&
      t.sector === "cross_sector_material_description" &&
      t.market === "EU" &&
      t.approval_state === "authorised_in_synthetic_fixture",
  );
  if (texts.length !== 1) throw new RouteHold("authorised_text_missing_or_ambiguous");

  // Lead screening derived representation (lead_screening, REF-10/12/13)
  if (!profile.allowed_derived_representations.includes("lead_screening")) {
    throw new RouteHold("derived_lead_disclosure_denied");
  }
  if (!Array.isArray(p[idLead]) || p[idLead].length !== 1) throw new RouteHold("lead_measurement_selection_ambiguous");
  const lead = p[idLead][0];
  const rule = policy.screening_rule;
  const u = lead.uncertainty;
  if (lead.method_ref !== rule.accepted_method || lead.qualifier !== rule.accepted_qualifier) {
    throw new RouteHold("lead_method_or_qualifier_incompatible");
  }
  if (
    lead.unit_id !== "mg/kg" ||
    u.unit_id !== "mg/kg" ||
    u.uncertainty_kind !== rule.accepted_uncertainty_kind ||
    u.coverage_factor !== rule.accepted_coverage_factor
  ) {
    throw new RouteHold("lead_uncertainty_interpretation");
  }
  if (lead.mass_basis !== "uncoated_alloy_specimen_mass") throw new RouteHold("lead_basis_incompatible");
  if (parseNumericStrict(lead.value) + parseNumericStrict(u.value) >= rule.threshold_mg_per_kg) {
    throw new RouteHold("synthetic_screen_not_passed");
  }

  const payload: CustomerProjectionPayload = {
    product_model: p[idModel].value,
    designation: p[idDesig].designation,
    alloy: p[idAlloy].designation,
    temper: p[idTemper].designation,
    customer_material_code: p[idCustCode][0].value,
    nominal_dimensions_m: dims,
    recycled_content: {
      declared_percent: total,
      basis: publicBasis,
      method: String(rc.method_id),
      qualification: "Synthetic supplier declaration; arithmetic check only, no independent verification.",
    },
    carbon_footprint: {
      value: result.result,
      unit: "kg CO2-equivalent",
      reference_quantity: projectFields(ctx.reference_unit, ["id", "quantity", "unit", "basis_type", "reference_product"]),
      method: projectFields(ctx.method, ["id", "version", "conformity_status"]),
      boundary: projectFields(ctx.boundary, ["id", "label", "included", "excluded", "module_assignment"]),
      representativeness: projectFields(ctx.representativeness, ["id", "period", "geography", "coverage", "batch_specific"]),
      qualification: "Imported synthetic result; no LCA performed; no EPD or legal conformity asserted.",
    },
    description: {
      language: texts[0]!.language,
      text: texts[0]!.text,
      text_revision: texts[0]!.revision,
    },
    lead_screening: {
      statement: rule.statement,
      rule_id: rule.id,
      rule_version: rule.version,
      qualification: rule.qualification,
    },
  };

  const outKeys = Object.keys(payload).sort();
  const reqKeys = [...profile.required_output_fields].sort();
  if (JSON.stringify(outKeys) !== JSON.stringify(reqKeys)) throw new RouteHold("output_contract_fields");

  return {
    status: "RELEASED_REFERENCE_VIEW",
    synthetic: true,
    payload,
    scope: "Customer JSON projection only; PDF is rendered from this exact projection.",
  };
}

const CSV_FORMULA_DANGEROUS = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;
const STRICT_NUM = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function safeCsvCell(raw: string, numeric: boolean): string {
  const prefixed = CSV_FORMULA_DANGEROUS.test(raw) && !(numeric && STRICT_NUM.test(raw));
  const safe = prefixed ? `'${raw}` : raw;
  return /[,"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function buildInternalProjection(record: DppPayloadRecord, contracts: PinnedReferenceContracts): InternalRouteOutput {
  const p = record.properties as Record<string, any>;
  const id = (suffix: string) => propIdBySemanticSuffix(contracts, suffix);

  const idModel = id("productModelIdentifier");
  const idBatch = id("batchIdentifier");
  const idCustCode = id("customerMaterialCode");
  const idNomT = id("nominalSheetThickness");
  const idMeasT = id("measuredSheetThickness");
  const idNomW = id("nominalSheetWidth");
  const idNomL = id("nominalSheetLength");
  const idMg = id("measuredMagnesiumMassFraction");
  const idLead = id("measuredLeadMassFraction");
  const idCost = id("internalUnitConversionCost");

  for (const prop of [idNomT, idNomW, idNomL]) {
    if (p[prop].unit_id !== "mm" || p[prop].quantity_kind !== "length" || p[prop].value_kind !== "nominal_specification") {
      throw new RouteHold("internal_nominal_unit_or_kind");
    }
  }
  const pfx = contracts.profilePolicy.customer.recipient.split("-")[0] ?? "ST";
  const expectedMethods = [
    [idMeasT, "mm", `${pfx}-DIM-METHOD-01`],
    [idMg, "%", `${pfx}-CHEM-METHOD-01`],
    [idLead, "mg/kg", contracts.profilePolicy.screening_rule.accepted_method],
  ] as const;
  for (const [prop, unit, method] of expectedMethods) {
    if (!Array.isArray(p[prop]) || p[prop].length !== 1) throw new RouteHold("internal_observation_selection_ambiguous");
    const v = p[prop][0];
    if (v.unit_id !== unit || v.property_ref !== prop || v.method_ref !== method || v.batch_id !== p[idBatch].value) {
      throw new RouteHold("internal_measurement_context_or_unit");
    }
  }
  if (p[idMg][0].analyte?.symbol !== "Mg" || p[idMg][0].mass_basis !== "uncoated_alloy_specimen_mass") {
    throw new RouteHold("internal_magnesium_semantics");
  }
  const cost = p[idCost];
  const costCtx = record.metadata.cost_context as Record<string, unknown>;
  if (
    cost.currency !== "EUR" ||
    cost.denominator_unit !== "kg" ||
    costCtx.currency !== "EUR" ||
    costCtx.denominator_unit !== "kg" ||
    cost.context_ref !== costCtx.id
  ) {
    throw new RouteHold("internal_cost_basis");
  }

  const headers = [
    "product_model",
    "batch",
    "customer_material_code",
    "nominal_thickness_mm",
    "measured_thickness_mm",
    "nominal_width_mm",
    "nominal_length_mm",
    "magnesium_mass_percent",
    "lead_mg_per_kg",
    "lead_qualifier",
    "internal_conversion_cost_eur_per_kg",
    "synthetic",
  ];
  const fmtFloat = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));
  const rowCells: Array<[string, boolean]> = [
    [String(p[idModel].value), false],
    [String(p[idBatch].value), false],
    [String(p[idCustCode][0].value), false],
    [fmtFloat(Number(p[idNomT].value)), true],
    [String(p[idMeasT][0].value), true],
    [fmtFloat(Number(p[idNomW].value)), true],
    [fmtFloat(Number(p[idNomL].value)), true],
    [String(p[idMg][0].value), true],
    [String(p[idLead][0].value), true],
    [String(p[idLead][0].qualifier), false],
    [String(p[idCost].value), true],
    ["True", false],
  ];
  const csv = `${headers.join(",")}\n${rowCells.map(([v, num]) => safeCsvCell(v, num)).join(",")}\n`;
  return {
    status: "RELEASED_REFERENCE_VIEW",
    synthetic: true,
    csv,
    scope: "Selected internal staging file; accompanying canonical record retains full context.",
  };
}

function buildRegistryProjection(record: DppPayloadRecord, contracts: PinnedReferenceContracts): RegistryRequestEnvelope {
  const p = record.properties as Record<string, any>;
  const idModel = propIdBySemanticSuffix(contracts, "productModelIdentifier");
  const modelVal = String(p[idModel]?.value ?? "");
  const baseHost = String(contracts.contextLd["@context"]["@base"] ?? "https://standin.example/demo/").replace(/\/demo\/?$/, "");
  return {
    status: "HOLD",
    synthetic: true,
    code: "TARGET_PROFILE_UNCONFIRMED",
    message: "Aluminium registration profile is absent or unconfirmed for the pinned interface. No request was sent.",
    not_a_registration_request: true,
    semantic_core_metadata_preview: {
      digitalProductPassportId: `${baseHost}/demo/dpp/${modelVal}`,
      uniqueProductIdentifier: record.record_id,
      granularity: "https://repository.product-passport.ec.europa.eu/core/vocabs/granularity-level#model",
      dppStatus: null,
      lastUpdate: "2026-10-31T00:00:00Z",
      contentSpecificationIds: [`${baseHost}/profile/aluminium-demo/1.0.0`],
    },
    limitations: [
      "Illustrative semantic-core metadata only; not asserted to conform to the complete official semantic core.",
      "No confirmed aluminium registration contract; a semantic-core validation cannot establish registration-request support.",
      "Status remains unset; no official verification, registration or publication is asserted.",
    ],
  };
}

/** Exports one route (customer, internal, or registry) with optional recipient, language, and S5-SEM-CONTEXT-rev2 checks. */
export function exportReferenceRoute(
  record: DppPayloadRecord | null,
  contracts: PinnedReferenceContracts,
  route: Route,
  options: {
    recipient?: string;
    language?: string;
    context?: OperationContext;
    expectedProfileReleaseId?: string;
  } = {},
): { output: CustomerRouteOutput | InternalRouteOutput | RegistryRequestEnvelope; diagnostics: RoutePrivateDiagnostic[] } {
  const policy = contracts.profilePolicy;
  const expectedRecipient = policy[route].recipient;
  if (options.recipient !== undefined && options.recipient !== expectedRecipient) {
    return { output: safeHoldEnvelope(), diagnostics: [{ kind: "recipient_context_not_permitted" }] };
  }
  if (options.context !== undefined) {
    const expectedPurpose = route === "registry" ? null : policy[route].purpose;
    const ctxCheck = validateOperationContext(options.context, {
      route,
      expectedProfileReleaseId: options.expectedProfileReleaseId ?? `${policy.id}@${policy.version}#sha256:${contracts.digests.profilePolicy}`,
      expectedRecipient,
      expectedPurpose,
    });
    if (!ctxCheck.ok) {
      return {
        output: safeHoldEnvelope(ctxCheck.code ?? "CONTEXT_TYPING_UNRESOLVED"),
        diagnostics: ctxCheck.issues.map((d) => ({ kind: ctxCheck.code ?? "CONTEXT_TYPING_UNRESOLVED", private_detail: d })),
      };
    }
  }
  if (!record) return { output: safeHoldEnvelope(), diagnostics: [{ kind: "canonical_record_unavailable" }] };
  const routeIssues = collectRouteIssues(record, contracts, route);
  if (routeIssues.length > 0) return { output: safeHoldEnvelope(), diagnostics: routeIssues };

  try {
    if (route === "customer") return { output: buildCustomerProjection(record, contracts, options.language), diagnostics: [] };
    if (route === "internal") return { output: buildInternalProjection(record, contracts), diagnostics: [] };
    if (route === "registry") {
      return {
        output: buildRegistryProjection(record, contracts),
        diagnostics: [{ kind: "target_profile_unconfirmed", scope: "aluminium" }],
      };
    }
    throw new RouteHold("unsupported_route");
  } catch (err) {
    return {
      output: safeHoldEnvelope(),
      diagnostics: [{ kind: "route_validation_failure", private_detail: err instanceof Error ? err.message : String(err) }],
    };
  }
}

/** Runs the full reference execution pipeline (import + 3 routes + deterministic manifest with manifest_digest). */
export async function executeReferencePipeline(
  erpText: string,
  lab: Record<string, unknown>,
  contracts: PinnedReferenceContracts,
  options: { standIn?: boolean; labRawText?: string; language?: string } = {},
): Promise<ReferenceExecutionResult> {
  const r = structuredClone(contracts);
  const resourceErrors = validateReferenceContracts(r);
  if (resourceErrors.length > 0) return { status: "RESOURCE_REJECT", resource_errors: resourceErrors };

  const imported = await importReferencePair(erpText, lab, r, options);
  const cust = exportReferenceRoute(imported.record, r, "customer", { language: options.language });
  const intl = exportReferenceRoute(imported.record, r, "internal");
  const reg = exportReferenceRoute(imported.record, r, "registry");

  const outputs = {
    customer: cust.output as CustomerRouteOutput,
    internal: intl.output as InternalRouteOutput,
    registry: reg.output as RegistryRequestEnvelope,
  };
  const privateDiagnostics: Record<Route, RoutePrivateDiagnostic[]> = {
    customer: cust.diagnostics,
    internal: intl.diagnostics,
    registry: reg.diagnostics,
  };

  const body: Record<string, unknown> = {
    format: "DPP reference execution manifest",
    version: "1.0.0",
    classification: "internal_only",
    synthetic: true,
    runtime: "dpp_suite_ts_cycle9_1.0.0",
    input_digests: Object.fromEntries(imported.source_files.map((x) => [x.source_id, x.sha256])),
    resource_digests: {
      catalogue: await canonicalDigest(r.catalogue),
      code_list: await canonicalDigest(r.codeList),
      context: await canonicalDigest(r.contextLd),
      export_customer: await canonicalDigest(r.exportCustomer),
      export_internal: await canonicalDigest(r.exportInternal),
      export_registry: await canonicalDigest(r.exportRegistry),
      import_erp: await canonicalDigest(r.importErp),
      import_lab: await canonicalDigest(r.importLab),
      profile_policy: await canonicalDigest(r.profilePolicy),
      record_schema: await canonicalDigest(r.recordSchema),
    },
    import_status: imported.status,
    record_digest: await canonicalDigest(imported.record),
    output_digests: {
      customer: await canonicalDigest(outputs.customer),
      internal: await canonicalDigest(outputs.internal),
      registry: await canonicalDigest(outputs.registry),
    },
    private_route_diagnostics: privateDiagnostics,
    time_policy: "No run timestamp in this deterministic manifest. Production execution timestamps belong in declared generated metadata.",
  };
  const manifest = { ...body, manifest_digest: await canonicalDigest(body) };

  return {
    status: "EXECUTED_REFERENCE",
    import: imported,
    outputs,
    private_diagnostics: privateDiagnostics,
    manifest,
  };
}

export async function verifyReferenceManifest(manifest: Record<string, unknown>): Promise<boolean> {
  const { manifest_digest, ...body } = manifest;
  if (typeof manifest_digest !== "string") return false;
  return (await canonicalDigest(body)) === manifest_digest;
}

/** Convenience wrapper executing the reference pipeline directly against a loaded ProfilePack. */
export function executeWithPack(
  pack: ProfilePack,
  erpText: string,
  lab: Record<string, unknown>,
  options: { labRawText?: string; language?: string } = {},
) {
  return executeReferencePipeline(erpText, lab, pack.contracts, { standIn: pack.standIn, ...options });
}
