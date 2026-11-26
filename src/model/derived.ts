/**
 * Derived disclosure (Cycle 3: FUNC-046 slice; aligned in Cycle 9 to PROFILE-ALU-24-01 1.0.0, C9-06, A-19).
 *
 * The ONLY permitted derived representations for the customer route are:
 *   1. `recycled_total_with_basis` (`DR-RECYCLED-TOTAL`): declared total recycled percentage with mass basis
 *      (verifies total === pre + post, matching basis_id, method, and eligibility; withholds raw evidence).
 *   2. `lead_screening` (`DR-LEAD-SCREENING`): synthetic customer screening rule (the pack's `screening_rule`)
 *      testing unrounded `estimate + expanded_uncertainty < threshold_mg_per_kg` with k=2, expanded uncertainty,
 *      accepted method & qualifier, and uncoated_alloy_specimen_mass basis. Never discloses raw estimate or uncertainty.
 */
import { byRole, type Assertion, type ProductRecord, type RecordValue } from "./ingress";
import { isDerivedAllowed } from "./policy";
import type { ProfilePack } from "./profile";

export interface DerivedStatement {
  /** Human-readable derived statement shown on the customer sheet and recipient view. */
  text: string;
  /** True when the derived check passed (within screening rule / arithmetic balance verified). */
  within: boolean;
  /** Basis / rule identifier (the mass-basis ID or the screening rule ID and version from the pack). */
  basis: string;
  /** Mandatory qualification statement (synthetic / arithmetic check / screening outcome). */
  qualification: string;
  /** Representation key (`recycled_total_with_basis` or `lead_screening`). */
  representation: "recycled_total_with_basis" | "lead_screening";
}

export type DerivedResult =
  | {
      ok: true;
      rule: string;
      statement: DerivedStatement;
      sources: PublicSource[];
      inputs: Assertion[];
    }
  | { ok: false; rule: string; reason: string };

export interface PublicSource {
  role: "ERP extract" | "Laboratory file" | "Operator correction";
  position: string;
}

export function publicSource(source: Assertion["source"]): PublicSource {
  const prefix = `${source.file}, `;
  return {
    role: source.role === "erp" ? "ERP extract" : source.role === "correction" ? "Operator correction" : "Laboratory file",
    position: source.location.startsWith(prefix) ? source.location.slice(prefix.length) : "",
  };
}

const standing = (x: RecordValue) => (x.status === "corrected" ? x.assertions.slice(0, 1) : x.assertions);
const locations = (v: RecordValue[]) => v.flatMap((x) => standing(x).map((a) => publicSource(a.source)));
const assertionsOf = (v: RecordValue[]) => v.flatMap(standing);

function readings(record: ProductRecord, property: string): RecordValue[] {
  return record.values.filter((v) => v.property === property && !v.member);
}

/**
 * Applies the pinned derived rule of `property` to `record`.
 * Throws if `property` has no derived rule in the pack.
 */
export function derive(pack: ProfilePack, record: ProductRecord, property: string): DerivedResult {
  const rules = pack.policy.derived.rules.filter((r) => r.property === property);
  if (rules.length !== 1) throw new Error(`Property "${property}" has ${rules.length} derived rules, expected exactly one`);
  const rule = rules[0]!;
  const fail = (reason: string): DerivedResult => ({ ok: false, rule: rule.id, reason });

  if (!isDerivedAllowed(pack, "customer", rule.representation)) {
    return fail(`derived representation ${rule.representation} is not permitted by policy`);
  }

  if (rule.method === "recycled-total-with-basis") {
    const totalVals = readings(record, byRole(pack, "recycledTotal"));
    const preVals = readings(record, byRole(pack, "recycledPre"));
    const postVals = readings(record, byRole(pack, "recycledPost"));
    const basisVals = readings(record, byRole(pack, "recycledBasis"));
    if (!totalVals.length || !preVals.length || !postVals.length || !basisVals.length) {
      return fail("missing recycled-content total, split, or mass basis");
    }
    if ([...totalVals, ...preVals, ...postVals, ...basisVals].some((v) => v.status === "challenged")) {
      return fail("recycled-content assertion is challenged or conflicting");
    }
    const total = standing(totalVals[0]!)[0]!.value;
    const pre = standing(preVals[0]!)[0]!.value;
    const post = standing(postVals[0]!)[0]!.value;
    if (typeof total !== "number" || typeof pre !== "number" || typeof post !== "number") {
      return fail("recycled-content values must be numeric");
    }
    if (Math.abs(total - pre - post) > 1e-9) {
      return fail("recycled_balance_mismatch");
    }
    const basisA = standing(basisVals[0]!)[0]!;
    const methodId = basisA.details?.method_id ?? "";
    const eligibility = basisA.details?.eligibility ?? "";
    if (rule.expected_method_id && methodId !== rule.expected_method_id) {
      return fail("recycled_method_or_eligibility");
    }
    if (rule.expected_eligibility && eligibility !== rule.expected_eligibility) {
      return fail("recycled_method_or_eligibility");
    }
    const basisId = basisA.details?.basis_id ?? String(basisA.value ?? "");
    const denominator = basisA.details?.denominator ?? "total_uncoated_final_alloy_sheet_mass";
    const qualification = rule.qualification ?? "Synthetic supplier declaration; arithmetic check only, no independent verification.";
    const used = [...totalVals, ...preVals, ...postVals, ...basisVals];
    return {
      ok: true,
      rule: rule.id,
      statement: {
        representation: "recycled_total_with_basis",
        within: true,
        text: `${total} % (basis ${basisId}: ${denominator})`,
        basis: `${basisId} (${methodId})`,
        qualification,
      },
      sources: locations(used),
      inputs: assertionsOf(used),
    };
  }

  // uncertainty-guard-band-screen (lead_screening)
  const sr = rule.screening_rule;
  if (!sr) return fail("missing screening_rule in DERIVED-RULES");
  const leadVals = readings(record, property);
  if (leadVals.length !== 1) return fail(leadVals.length === 0 ? "missing lead measurement" : "lead_measurement_selection_ambiguous");
  const leadVal = leadVals[0]!;
  if (leadVal.status === "challenged") return fail("the value is challenged");
  const a = standing(leadVal)[0]!;
  if (a.flags.includes("source-assurance-unaccepted")) return fail("source_state_not_accepted");
  if (a.flags.includes("shape-issue") || typeof a.value !== "number") return fail("lead_measurement_shape_invalid");
  const d = a.details ?? {};
  if (d.method_ref !== sr.accepted_method || d.qualifier !== sr.accepted_qualifier) {
    return fail("lead_method_or_qualifier_incompatible");
  }
  const uncVal = Number(d.uncertainty_value);
  const k = Number(d.coverage_factor);
  if (
    a.unit !== "mg/kg" ||
    d.uncertainty_unit !== "mg/kg" ||
    d.uncertainty_kind !== sr.accepted_uncertainty_kind ||
    !Number.isFinite(uncVal) ||
    k !== sr.accepted_coverage_factor
  ) {
    return fail("lead_uncertainty_interpretation");
  }
  if (d.mass_basis !== "uncoated_alloy_specimen_mass") {
    return fail("lead_basis_incompatible");
  }
  // Unrounded uncertainty-aware guard-band predicate: estimate + expanded_uncertainty < threshold
  if (a.value + uncVal >= sr.threshold_mg_per_kg) {
    return fail("synthetic_screen_not_passed");
  }
  return {
    ok: true,
    rule: rule.id,
    statement: {
      representation: "lead_screening",
      within: true,
      text: sr.statement,
      basis: `${sr.id} v${sr.version}`,
      qualification: sr.qualification,
    },
    sources: locations(leadVals),
    inputs: assertionsOf(leadVals),
  };
}
