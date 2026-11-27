/**
 * Route readiness (Cycle 3: FUNC-002, 012 and 126 slices; aligned in Cycle 9 to PROFILE-ALU-24-01,
 * RELEASED / HOLD outcomes, processing vs raw-disclosure separation, and S5-SEM-CONTEXT-rev2).
 *
 * Pure and deterministic: the same record, pack, and context always give the same verdict.
 * Reports selected structural, completeness, and route checks; never claims legal conformity.
 */
import { buildOperationContextForRecord, validateOperationContext, type OperationContext } from "./context";
import { derive } from "./derived";
import { byRole, type Assertion, type Flag, type ProductRecord, type RecordValue } from "./ingress";
import { decide, isProcessingPermitted, isRawDisclosureForbidden } from "./policy";
import { ROUTES, type ProfilePack, type Route } from "./profile";
import { checkBoundedSchema } from "./recordSchemaCheck";
import { exportReferenceRoute } from "./referencePipeline";

export type PropertyState = "present" | "missing" | "inaccessible" | "challenged";

/** Aligned route outcome vocabulary (A-16, C9-07). */
export type RouteStatus = "RELEASED" | "HOLD";

export interface RequiredProperty {
  property: string;
  state: PropertyState;
  assured: boolean;
  flags: Flag[];
}

export interface HoldReason {
  ruleId: string;
  property: string | null;
  member?: string;
  detail?: string;
  field?: string;
  sources: Assertion["source"][];
}

export interface FootprintSelection {
  state: "none" | "selected" | "several";
  candidates: Array<{ qualifier?: string; source: Assertion["source"] }>;
  selected?: { qualifier?: string; source: Assertion["source"] };
}

export interface RouteReadiness {
  route: Route;
  recipient: string;
  status: RouteStatus;
  required: RequiredProperty[];
  holds: HoldReason[];
  footprint: FootprintSelection;
}

export interface StructuralCheck {
  id: string;
  text: string;
  passed: boolean;
  detail?: string;
}

export interface AssessOptions {
  /** Extra properties a route requires (for negative prohibited-disclosure route variants). */
  requires?: Partial<Record<Route, string[]>>;
  /** Subset of routes to evaluate (defaults to all three routes). */
  routes?: readonly Route[];
  /** Customer output language ("en" or "de"; defaults to pack policy language). */
  language?: "en" | "de";
  /** Optional S5-SEM-CONTEXT-rev2 17-field operation context to validate before release (C9-05). */
  context?: Partial<Record<Route, OperationContext>>;
}

const sourceOf = (a: Assertion) => a.source;
const effective = (v: RecordValue): Assertion[] => (v.status === "corrected" ? v.assertions.slice(0, 1) : v.assertions);
const unique = <T>(xs: T[]) => [...new Set(xs)];
const keyOf = (s: Assertion["source"]) => `${s.file}|${s.location}`;

export function selectFootprint(pack: ProfilePack, record: ProductRecord): FootprintSelection {
  const property = byRole(pack, "footprint");
  const candidates = record.values
    .filter((v) => v.property === property && !v.member)
    .flatMap((v) => effective(v).map((a) => ({ ...(v.qualifier ? { qualifier: v.qualifier } : {}), source: sourceOf(a) })));
  if (candidates.length === 0) return { state: "none", candidates };
  if (candidates.length === 1) return { state: "selected", candidates, selected: candidates[0] };
  return { state: "several", candidates };
}

export function ruleText(pack: ProfilePack, id: string): string {
  const found = [...pack.policy.readiness.rules, ...pack.policy.readiness.checks].find((r) => r.id === id);
  if (!found) throw new Error(`The readiness rules have no ${id}`);
  return found.text;
}

export function structuralChecks(pack: ProfilePack, record: ProductRecord): StructuralCheck[] {
  const modelProp = byRole(pack, "model");
  const revProp = byRole(pack, "revision");
  const batchProp = byRole(pack, "batch");
  const hasModel = record.values.some((v) => v.property === modelProp);
  const hasRev = record.values.some((v) => v.property === revProp);
  const hasBatch = record.values.some((v) => v.property === batchProp);
  const known = new Map(pack.properties.map((p) => [p.id, new Set(p.members.map((m) => m.id))]));
  const unknown = record.values.filter((v) => !known.has(v.property) || (v.member !== undefined && !known.get(v.property)!.has(v.member)));
  const schemaErrors = record.dppPayload ? checkBoundedSchema(record.dppPayload, pack.contracts.recordSchema) : [];
  return [
    {
      id: "CK-IDENTIFIERS",
      text: ruleText(pack, "CK-IDENTIFIERS"),
      passed: hasModel && hasRev && hasBatch,
      ...(!hasModel || !hasRev || !hasBatch
        ? { detail: `missing: ${[!hasModel && "model", !hasRev && "revision", !hasBatch && "batch"].filter(Boolean).join(", ")}` }
        : {}),
    },
    {
      id: "CK-PROFILE",
      text: ruleText(pack, "CK-PROFILE"),
      passed: unknown.length === 0,
      ...(unknown.length ? { detail: `not in the profile: ${unique(unknown.map((v) => (v.member ? `${v.property}/${v.member}` : v.property))).join(", ")}` } : {}),
    },
    {
      id: "CK-RECORD-SCHEMA",
      text: ruleText(pack, "CK-RECORD-SCHEMA"),
      passed: schemaErrors.length === 0,
      ...(schemaErrors.length ? { detail: schemaErrors[0] } : {}),
    },
  ];
}

export function assess(pack: ProfilePack, record: ProductRecord, options: AssessOptions = {}): RouteReadiness[] {
  const footprintProperty = byRole(pack, "footprint");
  const narrativeProperty = byRole(pack, "narrative");
  const modelProperty = byRole(pack, "model");
  const revisionProperty = byRole(pack, "revision");
  const footprint = selectFootprint(pack, record);
  const byProp = new Map<string, RecordValue[]>();
  for (const v of record.values) {
    let bucket = byProp.get(v.property);
    if (!bucket) {
      bucket = [];
      byProp.set(v.property, bucket);
    }
    bucket.push(v);
  }
  const valuesOf = (property: string): RecordValue[] => byProp.get(property) ?? [];
  const routes = options.routes ?? ROUTES;
  const lang = options.language ?? (pack.contracts.profilePolicy.customer.language as "en" | "de");
  const subjectRef = `${record.model}/${record.revision ?? valuesOf(revisionProperty)[0]?.assertions[0]?.raw ?? ""}`;

  // Direct customer output properties whose raw disclosure denial holds customer output (REF-28)
  const directCustomerProps = new Set([
    modelProperty,
    revisionProperty,
    byRole(pack, "name"),
    byRole(pack, "alloy"),
    byRole(pack, "temper"),
    byRole(pack, "nominalThickness"),
    byRole(pack, "nominalWidth"),
    byRole(pack, "nominalLength"),
    byRole(pack, "recycledTotal"),
    byRole(pack, "recycledBasis"),
    footprintProperty,
    narrativeProperty,
    byRole(pack, "customerCode"),
  ]);

  const shapeInvalid =
    record.importStatus === "IMPORTED_WITH_SHAPE_ISSUES" ||
    record.values.some((v) => effective(v).some((a) => a.flags.includes("shape-issue")));

  return routes.map((route) => {
    const info = pack.routes[route];
    const extraReqs = new Set(options.requires?.[route] ?? []);
    const requiredIds = pack.properties.filter((p) => p.requiredBy[route] || extraReqs.has(p.id)).map((p) => p.id);
    const holds: HoldReason[] = [];
    const holdIndex = new Map<string, { hold: HoldReason; seen: Set<string> }>();
    const add = (ruleId: string, property: string | null, member: string | undefined, sources: Assertion["source"][], detail?: string) => {
      const hKey = `${ruleId}\0${property ?? ""}\0${member ?? ""}\0${detail ?? ""}`;
      let entry = holdIndex.get(hKey);
      if (!entry) {
        const seen = new Set<string>();
        const deduped: Assertion["source"][] = [];
        for (const s of sources) {
          const sk = keyOf(s);
          if (!seen.has(sk)) {
            seen.add(sk);
            deduped.push(s);
          }
        }
        const hold: HoldReason = { ruleId, property, ...(member ? { member } : {}), ...(detail ? { detail } : {}), sources: deduped };
        holds.push(hold);
        entry = { hold, seen };
        holdIndex.set(hKey, entry);
      } else {
        for (const s of sources) {
          const sk = keyOf(s);
          if (!entry.seen.has(sk)) {
            entry.seen.add(sk);
            entry.hold.sources.push(s);
          }
        }
      }
    };

    // 1. Standing hold (registry: TARGET_PROFILE_UNCONFIRMED)
    if (info.status === "HOLD") {
      add("RR-STANDING-HOLD", null, undefined, [], "TARGET_PROFILE_UNCONFIRMED");
    }

    // 2. Selected-record structural shape issues (REF-20, REF-21)
    if (shapeInvalid) {
      const shapeSources = record.values.flatMap((v) => effective(v).filter((a) => a.flags.includes("shape-issue")).map(sourceOf));
      add("RR-SHAPE-ERROR", null, undefined, shapeSources, "selected_record_structure_invalid");
    }

    // 3. Mandatory S5-SEM-CONTEXT-rev2 17-field typed operation context validation (C9-05)
    // If the caller passes `options.context`, the route's binding must be explicitly present (never defaulted).
    // Otherwise derive the deterministic 17-field record context and validate all bindings against the pack.
    const defaultCtx = buildOperationContextForRecord(pack, route, record);
    const opCtx = options.context !== undefined ? options.context[route] : defaultCtx;
    const pol = pack.contracts.profilePolicy;
    const ctxRes = validateOperationContext(opCtx, {
      route,
      expectedProfileReleaseId: `${pol.id}@${pol.version}#sha256:${pack.contracts.digests.profilePolicy}`,
      expectedRecipient: pol[route].recipient,
      expectedPurpose: route === "registry" ? null : pol[route].purpose,
      expectedOrganizationId: typeof defaultCtx.organization_id === "string" ? defaultCtx.organization_id : undefined,
      expectedSubjectId: typeof defaultCtx.subject_id === "string" ? defaultCtx.subject_id : undefined,
      expectedSubjectRevision: typeof defaultCtx.subject_revision === "string" ? defaultCtx.subject_revision : undefined,
      expectedProductGroupId: typeof defaultCtx.product_group_id === "string" ? defaultCtx.product_group_id : undefined,
      expectedChainNodeId: typeof defaultCtx.chain_node_id === "string" ? defaultCtx.chain_node_id : undefined,
    });
    if (!ctxRes.ok) {
      add("RR-CONTEXT-UNRESOLVED", null, undefined, [], `${ctxRes.code}: ${ctxRes.issues.join(", ")}`);
    }

    const required: RequiredProperty[] = [];
    for (const property of requiredIds) {
      const access = decide(pack, route, property);
      const processingOk = isProcessingPermitted(pack, route, property);
      const rawDeniedDirect = route === "customer" && directCustomerProps.has(property) && isRawDisclosureForbidden(pack, route, property);
      // Extra required properties (negative route variant FC-PROHIBITED-DISCLOSURE) are inaccessible if matrix denies them
      const extraDenied = extraReqs.has(property) && access === "deny";

      const own = valuesOf(property);
      if (!processingOk || rawDeniedDirect || extraDenied) {
        const deniedSources = own.flatMap(effective).map(sourceOf);
        required.push({ property, state: "inaccessible", assured: false, flags: [] });
        add("RR-INACCESSIBLE", property, undefined, deniedSources, !processingOk ? "processing_not_permitted" : "required_raw_output_disclosure_denied");
        if (own.length === 0) add("RR-MISSING", property, undefined, []);
        continue;
      }

      if (own.length === 0) {
        required.push({ property, state: "missing", assured: false, flags: [] });
        add("RR-MISSING", property, undefined, []);
        continue;
      }

      const assertions = own.flatMap(effective);
      const flags = unique(assertions.flatMap((a) => a.flags));
      const sources = assertions.map(sourceOf);

      if (own.some((v) => v.status === "challenged")) {
        required.push({ property, state: "challenged", assured: false, flags });
        add("RR-CHALLENGED", property, undefined, sources);
        continue;
      }

      let assured = true;
      if (flags.includes("unknown-code")) {
        assured = false;
        add("RR-UNKNOWN-CODE", property, undefined, sources);
      }
      if (flags.includes("source-assurance-unaccepted") || flags.includes("evidence-digest-missing")) {
        assured = false;
        add("RR-EVIDENCE-DIGEST", property, undefined, sources, "source_state_not_accepted");
      }
      if (flags.includes("wrong-unit")) {
        assured = false;
        add("RR-SHAPE-ERROR", property, undefined, sources, "unit_incompatible");
      }

      // Footprint selection & compatibility (REF-11, REF-25)
      if (property === footprintProperty && route === "customer") {
        if (footprint.state === "several") {
          assured = false;
          add("RR-SEVERAL-RESULTS", property, undefined, footprint.candidates.map((c) => c.source));
        } else if (footprint.state === "selected") {
          const fpA = assertions[0]!;
          const d = fpA.details ?? {};
          const custPol = pack.contracts.profilePolicy.customer;
          if (
            d.method_ref !== custPol.expected_pcf_method ||
            d.reference_unit !== custPol.expected_reference_unit ||
            d.system_boundary !== custPol.expected_boundary ||
            (d.reference_product && d.reference_product !== subjectRef)
          ) {
            assured = false;
            add("RR-DERIVED-UNDETERMINABLE", property, undefined, sources, "footprint_semantics_or_subject_mismatch");
          }
        }
      }

      // Authorised text for requested language & subject (REF-17, REF-25)
      if (property === narrativeProperty && route === "customer") {
        const matching = assertions.filter(
          (a) =>
            a.details?.language === lang &&
            a.details?.sector === "cross_sector_material_description" &&
            a.details?.market === "EU" &&
            a.details?.approval_state === "authorised_in_synthetic_fixture" &&
            (!a.details?.subject_ref || a.details.subject_ref === subjectRef),
        );
        if (matching.length !== 1) {
          assured = false;
          const langSources = assertions.filter((a) => a.details?.language === lang).map(sourceOf);
          add("RR-DRAFT-TEXT", property, undefined, langSources.length ? langSources : sources, "authorised_text_missing_or_ambiguous");
        }
      }

      // Derived representations (DR-RECYCLED-TOTAL, DR-LEAD-SCREENING)
      if (access === "derived") {
        const dRes = derive(pack, record, property);
        if (!dRes.ok) {
          assured = false;
          add("RR-DERIVED-UNDETERMINABLE", property, undefined, sources, dRes.reason);
        }
      }

      required.push({ property, state: "present", assured, flags });
    }

    // Cross-check against referencePipeline when dppPayload is present so zero REF-01..REF-28 holds can slip through
    if (record.dppPayload && route !== "registry" && holds.length === 0) {
      const refCheck = exportReferenceRoute(record.dppPayload, pack.contracts, route, { language: lang });
      if (refCheck.output.status === "HOLD") {
        const detail = refCheck.diagnostics.map((d) => d.private_detail ?? d.kind).join("; ");
        add("RR-DERIVED-UNDETERMINABLE", null, undefined, [], detail || "route_validation_failure");
      }
    }

    return {
      route,
      recipient: info.recipient,
      status: holds.length === 0 ? "RELEASED" : "HOLD",
      required,
      holds,
      footprint,
    };
  });
}
