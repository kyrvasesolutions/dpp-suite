/**
 * Typed operation context (S5-SEM-CONTEXT-rev2) and exchange contract dispatch (S5-EXCHANGE-rev2)
 * for Cycle 9 (criteria C9-04, C9-05; conflict resolutions A-20, A-21, D9-04).
 *
 * Pure TypeScript (zero DOM, zero Node built-ins) so browser and server enforce the exact same
 * 17-field context contract and DPPPayload / RegistryRequest separation.
 */
import type { ProfilePack, Route } from "./profile";
import type { ProductRecord } from "./ingress";

export interface InapplicableContextValue {
  readonly inapplicable: true;
  readonly reason: string;
}

export type ContextFieldValue = string | InapplicableContextValue;

export const REQUIRED_CONTEXT_FIELDS = [
  "tenant_or_security_domain_id",
  "organization_id",
  "actor_id",
  "role_id",
  "subject_id",
  "subject_revision",
  "product_group_id",
  "profile_release_id",
  "chain_node_id",
  "upstream_or_downstream_relation_id",
  "product_subject_id",
  "product_revision",
  "supplier_or_chain_node_id",
  "recipient_id",
  "purpose",
  "jurisdiction_context",
  "relevant_time_basis",
] as const;

export type ContextField = (typeof REQUIRED_CONTEXT_FIELDS)[number];
export type OperationContext = Record<ContextField, ContextFieldValue>;

export const CONTEXT_ALIAS_PAIRS: ReadonlyArray<readonly [ContextField, ContextField]> = [
  ["subject_id", "product_subject_id"],
  ["subject_revision", "product_revision"],
  ["chain_node_id", "supplier_or_chain_node_id"],
];

export type ContextFailureCode = "CONTEXT_TYPING_UNRESOLVED" | "CONTEXT_MISMATCH";

export interface ContextValidationResult {
  ok: boolean;
  code?: ContextFailureCode;
  issues: string[];
}

export interface ContextValidationOptions {
  route: Route;
  expectedProfileReleaseId: string;
  expectedRecipient: string;
  /** Expected purpose token, or null for the held registry route where purpose is inapplicable. */
  expectedPurpose: string | null;
  /** Expected tenant / security domain ID (W-2 row 7: rejects cross-tenant requests). */
  expectedTenantId?: string;
  /** Expected organization ID (W-2 row 8: rejects site/alias substitution). */
  expectedOrganizationId?: string;
  /** Optional allow-list of registered actor IDs (W-2 row 9). */
  allowedActors?: ReadonlySet<string>;
  /** Optional forbidden actor/recipient collision check (W-2 row 9; default true). */
  forbidRecipientAsActor?: boolean;
  /** Allow-list of governed role IDs (W-2 row 10: rejects mismatched/revoked roles). */
  allowedRoles?: ReadonlySet<string>;
  /** Expected governed batch subject ID `${model}#batch:${batch}` (W-2 row 11). */
  expectedSubjectId?: string;
  /** Expected immutable product subject revision e.g. `P01` (W-2 row 12). */
  expectedSubjectRevision?: string;
  /** Expected pinned product group classification (W-2 row 13). */
  expectedProductGroupId?: string;
  /** Expected chain node ID `node:...` (W-2 row 15: rejects Party or site substituted for node). */
  expectedChainNodeId?: string;
  allowInapplicable?: ReadonlySet<ContextField>;
}

const KNOWN_GOVERNED_ROLES = new Set<string>(["ACT-01", "ACT-06", "ACT-17", "ACT-19", "ACT-20"]);
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const INVENTED_MIDNIGHT = /^\d{4}-\d{2}-\d{2}T00:00:00(?:Z|[+-]\d{2}:\d{2})?$/;

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && /\S/.test(v);

export function isInapplicableValue(v: unknown): v is InapplicableContextValue {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return obj.inapplicable === true && isNonEmptyString(obj.reason) && Object.keys(obj).length === 2;
}

function valuesEqual(a: ContextFieldValue, b: ContextFieldValue): boolean {
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (isInapplicableValue(a) && isInapplicableValue(b)) return a.reason === b.reason;
  return false;
}

const ZONE_FREE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const DEFAULT_INAPPLICABLE = new Set<ContextField>(["upstream_or_downstream_relation_id"]);
const REGISTRY_INAPPLICABLE = new Set<ContextField>(["upstream_or_downstream_relation_id", "purpose"]);

/**
 * Validates an operation context against S5-SEM-CONTEXT-rev2 and the 17-field W-2 bindings (C9-05).
 * Missing, null, unknown, stale, or mismatched bindings never default — they return a typed failure
 * (`CONTEXT_TYPING_UNRESOLVED` or `CONTEXT_MISMATCH`) that holds the dependent operation.
 */
export function validateOperationContext(
  input: unknown,
  opts: ContextValidationOptions,
): ContextValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["context_missing_or_not_object"] };
  }
  const ctx = input as Record<string, unknown>;
  const allowInapp = opts.allowInapplicable ?? (opts.route === "registry" ? REGISTRY_INAPPLICABLE : DEFAULT_INAPPLICABLE);
  const issues: string[] = [];

  for (const k of Object.keys(ctx)) {
    if (!(REQUIRED_CONTEXT_FIELDS as readonly string[]).includes(k)) {
      issues.push(`unexpected_field:${k}`);
    }
  }
  for (const field of REQUIRED_CONTEXT_FIELDS) {
    const val = ctx[field];
    if (val === undefined || val === null) {
      issues.push(`missing:${field}`);
      continue;
    }
    if (isNonEmptyString(val)) continue;
    if (isInapplicableValue(val)) {
      if (!allowInapp.has(field)) {
        issues.push(`inapplicable_disallowed:${field}`);
      }
      continue;
    }
    issues.push(`invalid_value:${field}`);
  }
  if (issues.length > 0) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues };
  }

  const typed = ctx as OperationContext;

  // Crosswalk alias equality (CONTEXT_MISMATCH)
  for (const [globalField, bindingField] of CONTEXT_ALIAS_PAIRS) {
    if (!valuesEqual(typed[globalField], typed[bindingField])) {
      return { ok: false, code: "CONTEXT_MISMATCH", issues: [`alias_mismatch:${globalField}!=${bindingField}`] };
    }
  }

  // Exact profile release + digest pin
  if (typed.profile_release_id !== opts.expectedProfileReleaseId) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["profile_release_mismatch"] };
  }

  // Recipient and purpose binding (never infer rights from ID or purpose)
  if (typed.recipient_id !== opts.expectedRecipient) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["recipient_mismatch"] };
  }
  if (opts.expectedPurpose !== null) {
    if (typed.purpose !== opts.expectedPurpose) {
      return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["purpose_mismatch"] };
    }
  } else if (!isInapplicableValue(typed.purpose)) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["registry_purpose_must_be_inapplicable"] };
  }

  // Independent actor vs recipient, tenant, organization, role, subject, group, chain node, relation, jurisdiction, time checks (W-2 rows 7–23)
  if (opts.expectedTenantId && typed.tenant_or_security_domain_id !== opts.expectedTenantId) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["cross_tenant_mismatch"] };
  }
  if (typeof typed.tenant_or_security_domain_id === "string" && typeof typed.organization_id === "string" && typed.tenant_or_security_domain_id === typed.organization_id) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["manufacturer_used_as_tenant"] };
  }
  if (opts.expectedOrganizationId && typed.organization_id !== opts.expectedOrganizationId) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["organization_mismatch"] };
  }
  if (opts.forbidRecipientAsActor !== false && typeof typed.actor_id === "string" && typed.actor_id === opts.expectedRecipient) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["recipient_used_as_actor"] };
  }
  if (opts.allowedActors && (typeof typed.actor_id !== "string" || !opts.allowedActors.has(typed.actor_id))) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["unregistered_actor"] };
  }
  const allowedRoles = opts.allowedRoles ?? KNOWN_GOVERNED_ROLES;
  if (typeof typed.role_id !== "string" || !allowedRoles.has(typed.role_id)) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["role_mismatched_or_revoked"] };
  }
  if (typeof typed.subject_id === "string") {
    if (!typed.subject_id.includes("#batch:") || /^https?:\/\//i.test(typed.subject_id)) {
      return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["subject_id_not_batch_subject"] };
    }
    if (opts.expectedSubjectId && typed.subject_id !== opts.expectedSubjectId) {
      return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["subject_id_mismatch"] };
    }
  }
  if (typeof typed.subject_revision === "string") {
    if (SHA256_HEX.test(typed.subject_revision) || SEMVER.test(typed.subject_revision)) {
      return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["subject_revision_unbounded_version_or_digest"] };
    }
    if (opts.expectedSubjectRevision && typed.subject_revision !== opts.expectedSubjectRevision) {
      return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["subject_revision_mismatch"] };
    }
  }
  if (opts.expectedProductGroupId && typed.product_group_id !== opts.expectedProductGroupId) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["unknown_product_group_code"] };
  }
  if (typeof typed.chain_node_id === "string") {
    if (!typed.chain_node_id.startsWith("node:") || (typeof typed.organization_id === "string" && typed.chain_node_id === typed.organization_id)) {
      return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["party_or_site_substituted_for_chain_node"] };
    }
    if (opts.expectedChainNodeId && typed.chain_node_id !== opts.expectedChainNodeId) {
      return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["chain_node_mismatch"] };
    }
  }
  const rel = typed.upstream_or_downstream_relation_id;
  if (isInapplicableValue(rel)) {
    if (/\bunknown\b/i.test(rel.reason)) {
      return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["unknown_encoded_as_inapplicable"] };
    }
  } else if (typeof rel === "string") {
    if (rel.includes("downstream->upstream") || !rel.includes("->")) {
      return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["invalid_relation_direction_or_endpoints"] };
    }
  }

  // Jurisdiction context (W-2 row 22): keep site, party, target_market, recipient_country distinct; never infer recipient_country from EU/EEA market
  if (typeof typed.jurisdiction_context === "string") {
    const kv = new Map<string, string>();
    for (const part of typed.jurisdiction_context.split(";")) {
      const idx = part.indexOf("=");
      if (idx > 0) kv.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
    if (!kv.get("site") || !kv.get("party") || !kv.get("target_market") || !kv.get("recipient_country")) {
      return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["jurisdiction_context_incomplete"] };
    }
    const rc = kv.get("recipient_country")!;
    if (rc === "EU" || rc === "EEA") {
      return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["recipient_country_inferred_from_market"] };
    }
  }

  // Time basis (W-2 row 23): reject zone-free instants and invented midnight on date-only production_date
  if (typeof typed.relevant_time_basis === "string") {
    const parts = typed.relevant_time_basis.split(";").map((s) => s.trim()).filter(Boolean);
    let hasProdDate = false;
    let hasRecorded = false;
    for (const part of parts) {
      const idx = part.indexOf("=");
      const key = idx > 0 ? part.slice(0, idx).trim() : "";
      const value = idx > 0 ? part.slice(idx + 1).trim() : part;
      if (ZONE_FREE_INSTANT.test(value)) {
        return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["zone_free_instant"] };
      }
      if (key === "production_date") {
        hasProdDate = true;
        if (INVENTED_MIDNIGHT.test(value) || !DATE_ONLY.test(value)) {
          return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["production_date_not_date_only"] };
        }
      }
      if (key === "recorded") {
        hasRecorded = true;
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
          return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["recorded_time_not_offset_qualified"] };
        }
      }
    }
    if (!hasProdDate || !hasRecorded) {
      return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["time_basis_incomplete"] };
    }
  }

  return { ok: true, issues: [] };
}

/** Extracts the pinned record bindings and constructs the deterministic 17-field operation context for any route. */
export function buildOperationContextForRecord(
  pack: ProfilePack,
  route: Route,
  record: ProductRecord,
  overrides: {
    tenantId?: string;
    actorId?: string;
    roleId?: string;
    recordedAt?: string;
  } = {},
): OperationContext {
  const findVal = (suffix: string, member?: string): string | undefined => {
    const prop = pack.properties.find((p) => p.definitionRef.endsWith(`/${suffix}`));
    if (!prop) return undefined;
    const rv = record.values.find((v) => v.property === prop.id && (member ? v.member === member : !v.member));
    const a = rv?.assertions[0];
    return a ? a.raw : undefined;
  };
  const manufacturerId = findVal("manufacturerParty", "FLD-PartyRef-party_id") ?? pack.contracts.codeList.entries[0]?.source_company ?? "ST-MFR-01";
  const siteCountry = findVal("manufacturingSite", "FLD-SiteRef-country") ?? "DE";
  const productionDate = findVal("batchProductionDate") ?? "2026-10-15";
  const revision = record.revision ?? findVal("productDefinitionRevision") ?? "P01";
  return buildOperationContext(pack, route, {
    model: record.model,
    revision,
    batch: record.batch,
    manufacturerId,
    siteCountry,
    productionDate,
    ...overrides,
  });
}

/** Builds the deterministic 17-field operation context for a route from a loaded pack and record identifiers. */
export function buildOperationContext(
  pack: ProfilePack,
  route: Route,
  ids: {
    model: string;
    revision: string;
    batch: string;
    manufacturerId: string;
    siteCountry?: string;
    productionDate?: string;
    tenantId?: string;
    actorId?: string;
    roleId?: string;
    recordedAt?: string;
  },
): OperationContext {
  const policy = pack.contracts.profilePolicy;
  const profileDigest = pack.contracts.digests.profilePolicy;
  const profileReleaseId = `${policy.id}@${policy.version}#sha256:${profileDigest}`;
  const subjectId = `${ids.model}#batch:${ids.batch}`;
  const chainNodeId = `node:producer:${ids.manufacturerId}`;
  const siteCountry = ids.siteCountry ?? "DE";
  const prodDate = ids.productionDate ?? "2026-10-15";
  const recorded = ids.recordedAt ?? "2026-10-16T00:00:00Z";

  const recipient = policy[route].recipient;
  const purpose: ContextFieldValue =
    route === "registry"
      ? { inapplicable: true, reason: "The approved registry preparation policy has no purpose token; target profile is unconfirmed (TARGET_PROFILE_UNCONFIRMED)." }
      : policy[route].purpose;

  return {
    tenant_or_security_domain_id: ids.tenantId ?? "tenant:local-synthetic-n",
    organization_id: ids.manufacturerId,
    actor_id: ids.actorId ?? "actor:local-operator-01",
    role_id: ids.roleId ?? "ACT-01",
    subject_id: subjectId,
    subject_revision: ids.revision,
    product_group_id: "aluminium-sheet:5754:O",
    profile_release_id: profileReleaseId,
    chain_node_id: chainNodeId,
    upstream_or_downstream_relation_id: {
      inapplicable: true,
      reason: "Fixed local route uses the producer node and an explicit recipient/purpose policy; the operation neither follows nor authorises a supply-chain edge.",
    },
    product_subject_id: subjectId,
    product_revision: ids.revision,
    supplier_or_chain_node_id: chainNodeId,
    recipient_id: recipient,
    purpose,
    jurisdiction_context: `site=${siteCountry};party=${siteCountry};target_market=EU;recipient_country=unknown`,
    relevant_time_basis: `production_date=${prodDate};recorded=${recorded}`,
  };
}

// ── S5-EXCHANGE-rev2 Exchange Contract Dispatch (C9-04, A-21) ──

export const EXCHANGE_TYPES = ["DPPPayload", "RegistryRequest"] as const;
export type ExchangeType = (typeof EXCHANGE_TYPES)[number];

export interface ExchangeDispatchResult {
  ok: boolean;
  exchangeType: ExchangeType | null;
  status: "ACCEPTED" | "HOLD";
  code:
    | "OK"
    | "HOLD_TARGET_PROFILE_UNCONFIRMED"
    | "EXCHANGE_TYPE_MISMATCH"
    | "INLINE_CONTEXT_REQUIRED"
    | "UNKNOWN_EXCHANGE_TYPE";
  message: string;
}

/**
 * Enforces S5-EXCHANGE-rev2 dispatch rule: the operation declares the exact exchange type.
 * A DPPPayload is never accepted as a RegistryRequest by shape guessing, and a RegistryRequest
 * is never accepted as a DPPPayload. Remote `@context` strings are refused (inline `@context` only).
 */
export function dispatchExchangeEnvelope(
  declaredType: string,
  payload: unknown,
): ExchangeDispatchResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {
      ok: false,
      exchangeType: null,
      status: "HOLD",
      code: "EXCHANGE_TYPE_MISMATCH",
      message: "Exchange payload must be a JSON object.",
    };
  }
  const obj = payload as Record<string, unknown>;
  if (declaredType === "DPPPayload") {
    if (obj.not_a_registration_request === true || obj.code === "TARGET_PROFILE_UNCONFIRMED" || obj.exchange_type === "RegistryRequest") {
      return {
        ok: false,
        exchangeType: "DPPPayload",
        status: "HOLD",
        code: "EXCHANGE_TYPE_MISMATCH",
        message: "A RegistryRequest envelope cannot be dispatched as a DPPPayload.",
      };
    }
    const ctx = obj["@context"];
    if (typeof ctx !== "object" || ctx === null || Array.isArray(ctx)) {
      return {
        ok: false,
        exchangeType: "DPPPayload",
        status: "HOLD",
        code: "INLINE_CONTEXT_REQUIRED",
        message: "DPPPayload requires an inline @context object; remote context loading is prohibited.",
      };
    }
    return { ok: true, exchangeType: "DPPPayload", status: "ACCEPTED", code: "OK", message: "DPPPayload accepted." };
  }
  if (declaredType === "RegistryRequest") {
    if (Object.hasOwn(obj, "properties") && Object.hasOwn(obj, "@context") && obj.not_a_registration_request !== true) {
      return {
        ok: false,
        exchangeType: "RegistryRequest",
        status: "HOLD",
        code: "EXCHANGE_TYPE_MISMATCH",
        message: "A DPPPayload is never accepted as a RegistryRequest by shape guessing.",
      };
    }
    return {
      ok: false,
      exchangeType: "RegistryRequest",
      status: "HOLD",
      code: "HOLD_TARGET_PROFILE_UNCONFIRMED",
      message: "Aluminium registration profile is absent or unconfirmed; no request is submitted.",
    };
  }
  return {
    ok: false,
    exchangeType: null,
    status: "HOLD",
    code: "UNKNOWN_EXCHANGE_TYPE",
    message: `Unknown exchange type "${declaredType}".`,
  };
}
