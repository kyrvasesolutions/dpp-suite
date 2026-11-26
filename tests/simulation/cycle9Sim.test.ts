/**
 * Layer 2 deterministic contract simulation for Cycle 9 (ADR-0002 pre-coding gate).
 *
 * Calibrates the Cycle 9 specification alignment BEFORE editing src/ or server/:
 *   1. Full S5-SEM-CONTEXT-rev2 (17 required fields, 3 alias crosswalk pairs, reasoned
 *      inapplicability, recipient/purpose binding, negative acceptance cases).
 *   2. S5-EXCHANGE-rev2 dispatch (DPPPayload vs RegistryRequest; no shape-guessing).
 *   3. D9-05 server actor role matrix (ACT-01, ACT-06, ACT-17 external auditor, ACT-19, ACT-20).
 *   4. Local-only (describe.runIf) calibration against all 28 pinned reference cases
 *      REF-01..REF-28 and drop-one-input contract tightness over SRC-ERP-CSV-01 & SRC-LAB-JSON-01.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── 1. S5-SEM-CONTEXT-rev2 Typed Context Contract Simulation (C9-05, A-20) ──

type Inapplicable = { readonly inapplicable: true; readonly reason: string };
type ContextValue = string | Inapplicable;

const REQUIRED_CONTEXT_FIELDS = [
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

type ContextField = (typeof REQUIRED_CONTEXT_FIELDS)[number];
type OperationContext = Record<ContextField, ContextValue>;

const ALIAS_PAIRS: ReadonlyArray<readonly [ContextField, ContextField]> = [
  ["subject_id", "product_subject_id"],
  ["subject_revision", "product_revision"],
  ["chain_node_id", "supplier_or_chain_node_id"],
];

interface ContextValidationResult {
  ok: boolean;
  code?: "CONTEXT_TYPING_UNRESOLVED" | "CONTEXT_MISMATCH";
  issues: string[];
}

const ROUTE_RECIPIENT_PURPOSE = {
  customer: { recipient: "RECIPIENT-A", purpose: "customer_data_request" },
  internal: { recipient: "RECIPIENT-INTERNAL", purpose: "internal_staging" },
  registry: { recipient: "REGISTRY_PREPARATION_ONLY", purpose: null },
} as const;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && /\S/.test(v);
}

function isInapplicable(v: unknown): v is Inapplicable {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as Record<string, unknown>).inapplicable === true &&
    isNonEmptyString((v as Record<string, unknown>).reason) &&
    Object.keys(v).length === 2
  );
}

function contextValuesEqual(a: ContextValue, b: ContextValue): boolean {
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (isInapplicable(a) && isInapplicable(b)) return a.reason === b.reason;
  return false;
}

function validateOperationContext(
  ctx: Record<string, unknown>,
  opts: {
    route: "customer" | "internal" | "registry";
    expectedProfileReleaseId: string;
    expectedRecipient: string;
    expectedPurpose: string | null;
    allowInapplicable?: ReadonlySet<ContextField>;
  },
): ContextValidationResult {
  const issues: string[] = [];
  const allowInapp = opts.allowInapplicable ?? new Set<ContextField>(["upstream_or_downstream_relation_id"]);
  const keys = Object.keys(ctx);
  for (const k of keys) {
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
    if (isInapplicable(val)) {
      if (!allowInapp.has(field)) {
        issues.push(`inapplicable_disallowed:${field}`);
      }
      continue;
    }
    issues.push(`invalid_shape:${field}`);
  }
  if (issues.length > 0) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues };
  }
  const typed = ctx as OperationContext;
  for (const [globalKey, bindingKey] of ALIAS_PAIRS) {
    if (!contextValuesEqual(typed[globalKey], typed[bindingKey])) {
      return { ok: false, code: "CONTEXT_MISMATCH", issues: [`alias_mismatch:${globalKey}!=${bindingKey}`] };
    }
  }
  if (typed.profile_release_id !== opts.expectedProfileReleaseId) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["profile_release_mismatch"] };
  }
  if (typed.recipient_id !== opts.expectedRecipient) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["recipient_mismatch"] };
  }
  if (opts.expectedPurpose !== null) {
    if (typed.purpose !== opts.expectedPurpose) {
      return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["purpose_mismatch"] };
    }
  } else if (!isInapplicable(typed.purpose)) {
    return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["registry_purpose_must_be_inapplicable"] };
  }
  if (typeof typed.relevant_time_basis === "string") {
    // Reject zone-free ISO datetime instants (YYYY-MM-DDTHH:MM:SS without Z or +/-HH:MM)
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(typed.relevant_time_basis)) {
      return { ok: false, code: "CONTEXT_TYPING_UNRESOLVED", issues: ["zone_free_instant"] };
    }
  }
  return { ok: true, issues: [] };
}

function baseSimContext(): OperationContext {
  return {
    tenant_or_security_domain_id: "tenant:local-synth-01",
    organization_id: "party:ST-MFR-01",
    actor_id: "actor:op-01",
    role_id: "ACT-01",
    subject_id: "batch:ST-LOT-01@model:ST-MOD-01",
    subject_revision: "rev:P01",
    product_group_id: "group:alu-sheet-5754",
    profile_release_id: "PROFILE-STANDIN@1.0.0#sha256:abc",
    chain_node_id: "node:producer-01",
    upstream_or_downstream_relation_id: {
      inapplicable: true,
      reason: "Fixed local customer PDF uses producer node and explicit recipient/purpose policy; no supply-chain edge.",
    },
    product_subject_id: "batch:ST-LOT-01@model:ST-MOD-01",
    product_revision: "rev:P01",
    supplier_or_chain_node_id: "node:producer-01",
    recipient_id: ROUTE_RECIPIENT_PURPOSE.customer.recipient,
    purpose: ROUTE_RECIPIENT_PURPOSE.customer.purpose,
    jurisdiction_context: "site=DE;party=DE;target_market=EU;recipient_country=unknown",
    relevant_time_basis: "recorded=2026-10-16T00:00:00Z;production_date=2026-10-15",
  };
}

// ── 2. S5-EXCHANGE-rev2 Exchange Type Dispatch Simulation (C9-04, A-21) ──

function dispatchExchange(declaredType: "DPPPayload" | "RegistryRequest" | string, payload: Record<string, unknown>): {
  status: "ACCEPTED" | "HOLD";
  code: string;
} {
  if (declaredType === "DPPPayload") {
    if (payload.not_a_registration_request === true || payload.code === "TARGET_PROFILE_UNCONFIRMED") {
      return { status: "HOLD", code: "EXCHANGE_TYPE_MISMATCH" };
    }
    if (typeof payload["@context"] !== "object" || payload["@context"] === null || typeof payload["@context"] === "string") {
      return { status: "HOLD", code: "INLINE_CONTEXT_REQUIRED" };
    }
    return { status: "ACCEPTED", code: "OK" };
  }
  if (declaredType === "RegistryRequest") {
    if ("properties" in payload && "@context" in payload) {
      return { status: "HOLD", code: "EXCHANGE_TYPE_MISMATCH" };
    }
    return { status: "HOLD", code: "HOLD_TARGET_PROFILE_UNCONFIRMED" };
  }
  return { status: "HOLD", code: "UNKNOWN_EXCHANGE_TYPE" };
}

// ── 3. D9-05 Server Role Matrix Simulation (ACT-01, ACT-06, ACT-17, ACT-19, ACT-20) ──

type C9Role = "ACT-01" | "ACT-06" | "ACT-17" | "ACT-19" | "ACT-20";
type C9Action = "import" | "release" | "read_audit" | "read_raw_restricted" | "grant_manage" | "legal_hold_release" | "config_propose" | "config_approve";

const ROLE_PERMISSIONS: Record<C9Role, ReadonlySet<C9Action>> = {
  "ACT-01": new Set(["import", "release", "read_raw_restricted"]),
  "ACT-06": new Set(["release"]),
  "ACT-17": new Set(["read_audit"]), // External auditor: read-only, raw restricted only with explicit policy grant
  "ACT-19": new Set(["read_audit", "grant_manage", "legal_hold_release", "config_approve"]),
  "ACT-20": new Set(["read_audit", "config_propose", "config_approve"]),
};

function canPerform(role: C9Role, action: C9Action, explicitRawGrant = false): boolean {
  if (role === "ACT-17" && action === "read_raw_restricted") {
    return explicitRawGrant;
  }
  return ROLE_PERMISSIONS[role].has(action);
}

describe("Cycle 9 Layer 2 simulation: S5-SEM-CONTEXT-rev2, S5-EXCHANGE-rev2, and D9-05 roles", () => {
  it("accepts a complete 17-field context with reasoned inapplicability on relation", () => {
    const res = validateOperationContext(baseSimContext(), {
      route: "customer",
      expectedProfileReleaseId: "PROFILE-STANDIN@1.0.0#sha256:abc",
      expectedRecipient: ROUTE_RECIPIENT_PURPOSE.customer.recipient,
      expectedPurpose: ROUTE_RECIPIENT_PURPOSE.customer.purpose,
    });
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
  });

  it("returns CONTEXT_TYPING_UNRESOLVED if any of the 17 required fields is missing or null", () => {
    for (const field of REQUIRED_CONTEXT_FIELDS) {
      const broken: Record<string, unknown> = { ...baseSimContext() };
      delete broken[field];
      const res = validateOperationContext(broken, {
        route: "customer",
        expectedProfileReleaseId: "PROFILE-STANDIN@1.0.0#sha256:abc",
        expectedRecipient: ROUTE_RECIPIENT_PURPOSE.customer.recipient,
        expectedPurpose: ROUTE_RECIPIENT_PURPOSE.customer.purpose,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe("CONTEXT_TYPING_UNRESOLVED");
      expect(res.issues).toContain(`missing:${field}`);
    }
  });

  it("returns CONTEXT_MISMATCH on any of the 3 alias crosswalk pairs", () => {
    for (const [g, b] of ALIAS_PAIRS) {
      const broken: Record<string, unknown> = { ...baseSimContext(), [b]: "different-value" };
      const res = validateOperationContext(broken, {
        route: "customer",
        expectedProfileReleaseId: "PROFILE-STANDIN@1.0.0#sha256:abc",
        expectedRecipient: ROUTE_RECIPIENT_PURPOSE.customer.recipient,
        expectedPurpose: ROUTE_RECIPIENT_PURPOSE.customer.purpose,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe("CONTEXT_MISMATCH");
      expect(res.issues).toContain(`alias_mismatch:${g}!=${b}`);
    }
  });

  it("rejects blank inapplicability reason, disallowed inapplicable field, stale profile digest, wrong purpose, and zone-free instant", () => {
    const opts = {
      route: "customer" as const,
      expectedProfileReleaseId: "PROFILE-STANDIN@1.0.0#sha256:abc",
      expectedRecipient: ROUTE_RECIPIENT_PURPOSE.customer.recipient,
      expectedPurpose: ROUTE_RECIPIENT_PURPOSE.customer.purpose,
    };
    expect(validateOperationContext({ ...baseSimContext(), upstream_or_downstream_relation_id: { inapplicable: true, reason: "   " } }, opts).code).toBe("CONTEXT_TYPING_UNRESOLVED");
    expect(validateOperationContext({ ...baseSimContext(), recipient_id: { inapplicable: true, reason: "unknown" } }, opts).code).toBe("CONTEXT_TYPING_UNRESOLVED");
    expect(validateOperationContext({ ...baseSimContext(), profile_release_id: "PROFILE-STANDIN@1.0.0#sha256:stale" }, opts).code).toBe("CONTEXT_TYPING_UNRESOLVED");
    expect(validateOperationContext({ ...baseSimContext(), purpose: "internal_staging" }, opts).code).toBe("CONTEXT_TYPING_UNRESOLVED");
    expect(validateOperationContext({ ...baseSimContext(), relevant_time_basis: "2026-10-16T12:00:00" }, opts).code).toBe("CONTEXT_TYPING_UNRESOLVED");
  });

  it("keeps DPPPayload and RegistryRequest strictly distinct (no shape guessing)", () => {
    expect(dispatchExchange("DPPPayload", { "@context": { "ALU-D101": "urn:ex:1" }, properties: {} })).toEqual({ status: "ACCEPTED", code: "OK" });
    expect(dispatchExchange("DPPPayload", { "@context": "https://remote.example/ctx.jsonld", properties: {} })).toEqual({ status: "HOLD", code: "INLINE_CONTEXT_REQUIRED" });
    expect(dispatchExchange("RegistryRequest", { "@context": {}, properties: {} })).toEqual({ status: "HOLD", code: "EXCHANGE_TYPE_MISMATCH" });
    expect(dispatchExchange("RegistryRequest", { status: "HOLD", code: "TARGET_PROFILE_UNCONFIRMED", not_a_registration_request: true })).toEqual({ status: "HOLD", code: "HOLD_TARGET_PROFILE_UNCONFIRMED" });
    expect(dispatchExchange("DPPPayload", { status: "HOLD", code: "TARGET_PROFILE_UNCONFIRMED", not_a_registration_request: true })).toEqual({ status: "HOLD", code: "EXCHANGE_TYPE_MISMATCH" });
    expect(dispatchExchange("UnknownType", {})).toEqual({ status: "HOLD", code: "UNKNOWN_EXCHANGE_TYPE" });
  });

  it("enforces D9-05 external auditor ACT-17 restrictions and ACT-19/ACT-20 split", () => {
    expect(canPerform("ACT-17", "read_audit")).toBe(true);
    expect(canPerform("ACT-17", "import")).toBe(false);
    expect(canPerform("ACT-17", "release")).toBe(false);
    expect(canPerform("ACT-17", "grant_manage")).toBe(false);
    expect(canPerform("ACT-17", "legal_hold_release")).toBe(false);
    expect(canPerform("ACT-17", "read_raw_restricted", false)).toBe(false);
    expect(canPerform("ACT-17", "read_raw_restricted", true)).toBe(true);
    expect(canPerform("ACT-19", "grant_manage")).toBe(true);
    expect(canPerform("ACT-19", "legal_hold_release")).toBe(true);
    expect(canPerform("ACT-20", "config_propose")).toBe(true);
    expect(canPerform("ACT-20", "grant_manage")).toBe(false);
  });
});

// ── 4. Local Reference Package Calibration (REF-01..REF-28 + Drop-One-Input) ──

const REF_ROOT = resolve("spec/trustainability/reference_package");
const HAS_REF = existsSync(resolve(REF_ROOT, "fixtures/cases.json"));

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",") + "}";
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function parseSimpleCsv(text: string): Array<Record<string, string>> {
  const lines = text.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const vals = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = vals[i] ?? "";
    });
    return row;
  });
}

function atPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(seg in (cur as Record<string, unknown>))) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

describe.runIf(HAS_REF)("Cycle 9 Layer 2 calibration against pinned reference_package (REF-01..REF-28)", () => {
  const cases = HAS_REF ? (JSON.parse(readFileSync(resolve(REF_ROOT, "fixtures/cases.json"), "utf8")) as Array<{
    case_id: string;
    scenario: string;
    changes: Array<{ target: string; path: string[]; op?: string; value?: unknown }>;
    expected_import: string;
    expected_routes: string;
    checks: string[];
  }>) : [];
  const policy = HAS_REF ? JSON.parse(readFileSync(resolve(REF_ROOT, "contracts/profile_policy.json"), "utf8")) : {};
  const impErp = HAS_REF ? JSON.parse(readFileSync(resolve(REF_ROOT, "contracts/import_erp.json"), "utf8")) : { rules: [] };
  const impLab = HAS_REF ? JSON.parse(readFileSync(resolve(REF_ROOT, "contracts/import_lab.json"), "utf8")) : { rules: [] };
  const baseErp = HAS_REF ? readFileSync(resolve(REF_ROOT, "inputs/erp.csv"), "utf8") : "";
  const baseLab = HAS_REF ? JSON.parse(readFileSync(resolve(REF_ROOT, "inputs/lab_assessment.json"), "utf8")) : {};
  const expectedCust = HAS_REF ? JSON.parse(readFileSync(resolve(REF_ROOT, "expected/baseline/customer.json"), "utf8")) : {};
  const expectedReg = HAS_REF ? JSON.parse(readFileSync(resolve(REF_ROOT, "expected/baseline/registry.json"), "utf8")) : {};
  const expectedIntCsv = HAS_REF ? readFileSync(resolve(REF_ROOT, "expected/baseline/internal.csv"), "utf8") : "";

  it("loads all 28 REF cases and verifies baseline oracle invariants", () => {
    expect(cases).toHaveLength(28);
    expect(cases.map((c) => c.case_id)).toEqual(Array.from({ length: 28 }, (_, i) => `REF-${String(i + 1).padStart(2, "0")}`));
    expect(expectedCust.status).toBe("RELEASED_REFERENCE_VIEW");
    expect(expectedReg.status).toBe("HOLD");
    expect(expectedReg.code).toBe("TARGET_PROFILE_UNCONFIRMED");
    expect(expectedReg.not_a_registration_request).toBe(true);
    // Oracle values stay in the git-ignored files: check their bytes against the pinned digests instead of quoting them here.
    const pins = readFileSync(resolve("spec/trustainability/PINS.md"), "utf8");
    for (const name of ["customer.json", "internal.csv", "registry.json"]) {
      const pinned = new RegExp("`reference_package/expected/baseline/" + name.replace(".", "\\.") + "` \\| `([0-9a-f]{64})`").exec(pins)?.[1];
      expect(pinned, name).toBeDefined();
      expect(createHash("sha256").update(readFileSync(resolve(REF_ROOT, "expected/baseline", name))).digest("hex"), name).toBe(pinned);
    }
    expect(expectedIntCsv.split("\n")[0]).toContain("customer_material_code");
    expect(sha256Json(expectedCust)).toHaveLength(64);
  });

  it("drop-one-input simulation: every ERP and Lab required property breaks its dependent route(s)", () => {
    const erpRow = parseSimpleCsv(baseErp)[0];
    const erpPropToCols = new Map<string, string[]>(impErp.rules.map((r: { target: string; selector: string[] }) => [r.target, r.selector]));
    const labPropToPaths = new Map<string, string[]>(impLab.rules.map((r: { target: string; selector: string[] }) => [r.target, r.selector]));
    const custReq = new Set<string>(policy.customer.route_required_source_properties);
    const intReq = new Set<string>(policy.internal.route_required_source_properties);
    const regReq = new Set<string>(policy.registry.route_required_source_properties);

    for (const [prop, cols] of erpPropToCols.entries()) {
      expect(cols.every((c) => c in erpRow)).toBe(true);
      const present = new Set<string>([...erpPropToCols.keys(), ...labPropToPaths.keys()]);
      present.delete(prop);
      const custReady = [...custReq].every((p) => present.has(p));
      const intReady = [...intReq].every((p) => present.has(p));
      const regReady = [...regReq].every((p) => present.has(p)) && policy.registry.aluminium_registration_profile_confirmed === true;
      expect(custReady).toBe(!custReq.has(prop));
      expect(intReady).toBe(!intReq.has(prop));
      expect(regReady).toBe(false);
    }

    for (const [prop, paths] of labPropToPaths.entries()) {
      expect(paths.every((p) => atPath(baseLab, p) !== undefined)).toBe(true);
      const present = new Set<string>([...erpPropToCols.keys(), ...labPropToPaths.keys()]);
      present.delete(prop);
      const custReady = [...custReq].every((p) => present.has(p));
      const intReady = [...intReq].every((p) => present.has(p));
      expect(custReady).toBe(!custReq.has(prop));
      expect(intReady).toBe(!intReq.has(prop));
    }
  });
});
