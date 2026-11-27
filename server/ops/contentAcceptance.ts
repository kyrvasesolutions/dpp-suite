/**
 * Production Content & Output Acceptance Verifier (`FUNC-042`, `FUNC-043`, `FUNC-085`, `FUNC-126`).
 *
 * Deterministically verifies the active pinned contract pack — reading every threshold, operator,
 * ownership pin, label, unit, and registry hold directly from `pack` and executing the live
 * `derive()` engine against the pack's own unrounded uncertainty-aware screening rule.
 */
import type { ContentAcceptanceCheck, ContentAcceptanceReport } from "../../src/model/c10Contracts";
import { derive } from "../../src/model/derived";
import type { ProductRecord } from "../../src/model/ingress";
import type { ProfilePack } from "../../src/model/profile";

/** Unrounded uncertainty-aware upper-bound screening check (never rounds before comparing). */
export function evaluateLeadScreeningBound(
  measuredMgPerKg: number,
  uncertaintyMgPerKg: number,
  thresholdMgPerKg: number,
): { upperBound: number; passes: boolean } {
  const upperBound = measuredMgPerKg + uncertaintyMgPerKg;
  return { upperBound, passes: upperBound < thresholdMgPerKg };
}

function buildLeadProbeRecord(
  leadPropId: string,
  measured: number,
  uncertainty: number,
  coverageFactor: number,
  uncertaintyKind: string,
  method: string,
  qualifier: string,
): ProductRecord {
  const source = {
    role: "lab" as const,
    file: "probe-lab.json",
    sha256: "0".repeat(64),
    location: "probe-lab.json, /observations/0",
  };
  return {
    model: "PROBE-MODEL",
    batch: "PROBE-BATCH",
    digest: "0".repeat(64),
    sources: [{ role: "lab", name: "probe-lab.json", mediaType: "application/json", sha256: "0".repeat(64), size: 0 }],
    values: [
      {
        property: leadPropId,
        status: "single",
        assertions: [
          {
            property: leadPropId,
            raw: String(measured),
            value: measured,
            unit: "mg/kg",
            source,
            flags: [],
            details: {
              method_ref: method,
              qualifier,
              uncertainty_value: String(uncertainty),
              uncertainty_unit: "mg/kg",
              uncertainty_kind: uncertaintyKind,
              coverage_factor: String(coverageFactor),
              mass_basis: "uncoated_alloy_specimen_mass",
            },
          },
        ],
      },
    ],
  };
}

/** Evaluates all content acceptance checks directly against the active pinned contract pack. */
export function evaluateContentAcceptance(pack: ProfilePack): ContentAcceptanceReport {
  const checks: ContentAcceptanceCheck[] = [];
  const policy = pack.contracts.profilePolicy;
  const expCust = pack.contracts.exportCustomer;
  const expInt = pack.contracts.exportInternal;
  const expReg = pack.contracts.exportRegistry;
  const impErp = pack.contracts.importErp;
  const impLab = pack.contracts.importLab;

  // 1. Catalogue completeness, semantic URI parity, and route requiredness alignment
  const catById = new Map(pack.contracts.catalogue.map((c) => [c.id, c]));
  const custReq = new Set(policy.customer.route_required_source_properties);
  const catalogueAligned =
    pack.properties.length === 24 &&
    pack.contracts.catalogue.length === 24 &&
    pack.properties.every((p) => {
      const cat = catById.get(p.id);
      return (
        Boolean(cat) &&
        cat!.semantic_uri === p.definitionRef &&
        cat!.datatype === p.datatype &&
        p.requiredBy.customer === custReq.has(p.id) &&
        Boolean(p.labels.en.trim()) &&
        Boolean(p.labels.de.trim())
      );
    });
  checks.push({
    id: "P08-01-catalogue-completeness",
    category: "catalogue",
    description: "All 24 profile properties match catalogue semantic URIs, datatypes, route requiredness, and bilingual labels",
    passed: catalogueAligned,
    detail: `properties=${pack.properties.length}, catalogue=${pack.contracts.catalogue.length}`,
  });

  // 2. Rule ownership, release metadata, retention floor, and exact-semver pins
  const hasReleaseGovernance =
    /^\d+\.\d+\.\d+$/.test(pack.version) &&
    /^[0-9a-f]{64}$/.test(pack.manifestDigest) &&
    Boolean(pack.release.released.trim()) &&
    Boolean(pack.release.releasedBy.trim()) &&
    Boolean(pack.release.basis.trim()) &&
    pack.policy.derived.rules.length >= 2 &&
    pack.policy.readiness.rules.length >= 5 &&
    pack.policy.retention.datasets.length >= 1 &&
    pack.policy.retention.default_retention_days >= 3650;
  checks.push({
    id: "P08-02-rule-ownership-and-pins",
    category: "governance",
    description: "Profile release ownership, exact-semver pins, manifest digest, and retention horizons are valid",
    passed: hasReleaseGovernance,
    detail: `profile=${pack.id}@${pack.version}, releasedBy=${pack.release.releasedBy}, retentionDays=${pack.policy.retention.default_retention_days}`,
  });

  // 3. Release-pinned import/export mappings, customer operators, and mm -> m nominal conversion
  const custOps = new Set(expCust.rules.map((r) => r.operator));
  const requiredOps = [
    "customer_identity_nominal",
    "recycled_check",
    "compatible_assessment_projection",
    "authorised_language",
    "synthetic_guard_band_screen",
  ];
  const semver = /^\d+\.\d+\.\d+$/;
  const nominalDimProps = pack.properties.filter((p) =>
    ["nominalSheetThickness", "nominalSheetWidth", "nominalSheetLength"].some((s) => p.definitionRef.endsWith(`/${s}`)),
  );
  const custItemsByProp = new Map(pack.routes.customer.output.map((i) => [i.property, i]));
  const mmToMConfigured =
    nominalDimProps.length === 3 &&
    nominalDimProps.every((p) => p.unit === "mm" && custItemsByProp.get(p.id)?.unit === "m");
  const opsPinned =
    semver.test(impErp.version) &&
    semver.test(impLab.version) &&
    semver.test(expCust.version) &&
    semver.test(expInt.version) &&
    semver.test(expReg.version) &&
    requiredOps.every((op) => custOps.has(op)) &&
    mmToMConfigured;
  checks.push({
    id: "P08-03-release-pinned-operators",
    category: "operators",
    description: "All 5 import/export mappings are exact-semver pinned with required operators and nominal mm-to-m conversion",
    passed: opsPinned,
    detail: `operators=${[...custOps].sort().join(",")}, mmToM=${mmToMConfigured}`,
  });

  // 4. Unrounded uncertainty-aware lead screening verified via live derive() against active pack threshold
  const policyScreen = policy.screening_rule;
  const derivedLeadRule = pack.policy.derived.rules.find((r) => r.representation === "lead_screening");
  const ruleScreen = derivedLeadRule?.screening_rule;
  const screenParity =
    Boolean(policyScreen) &&
    Boolean(ruleScreen) &&
    policyScreen!.threshold_mg_per_kg === ruleScreen!.threshold_mg_per_kg &&
    policyScreen!.accepted_coverage_factor === ruleScreen!.accepted_coverage_factor &&
    policyScreen!.accepted_uncertainty_kind === ruleScreen!.accepted_uncertainty_kind;

  let liveDeriveOk = false;
  let thresholdDetail = "screening-rule-missing";
  if (screenParity && derivedLeadRule && ruleScreen) {
    const T = ruleScreen.threshold_mg_per_kg;
    const u = 2.5;
    const k = ruleScreen.accepted_coverage_factor;
    const kind = ruleScreen.accepted_uncertainty_kind;
    const method = ruleScreen.accepted_method;
    const qual = ruleScreen.accepted_qualifier;

    const belowBound = evaluateLeadScreeningBound(T - 10, u, T);
    const exactBoundary = evaluateLeadScreeningBound(T - u, u, T);
    const roundingTrap = evaluateLeadScreeningBound(T - u - 0.01, u + 0.02, T);

    const probeBelow = derive(
      pack,
      buildLeadProbeRecord(derivedLeadRule.property, T - 10, u, k, kind, method, qual),
      derivedLeadRule.property,
    );
    const probeAtBoundary = derive(
      pack,
      buildLeadProbeRecord(derivedLeadRule.property, T - u, u, k, kind, method, qual),
      derivedLeadRule.property,
    );
    const probeRoundingTrap = derive(
      pack,
      buildLeadProbeRecord(derivedLeadRule.property, T - u - 0.01, u + 0.02, k, kind, method, qual),
      derivedLeadRule.property,
    );

    liveDeriveOk =
      belowBound.passes === true &&
      exactBoundary.passes === false &&
      roundingTrap.passes === false &&
      probeBelow.ok === true &&
      probeAtBoundary.ok === false &&
      probeRoundingTrap.ok === false;
    thresholdDetail = `threshold=${T}mg/kg, below=${probeBelow.ok}, boundary=${probeAtBoundary.ok}, roundingTrap=${probeRoundingTrap.ok}`;
  }
  checks.push({
    id: "P08-04-unrounded-uncertainty-threshold",
    category: "operators",
    description: "Live derive() enforces unrounded uncertainty-aware screening matching active policy and derived rules",
    passed: screenParity && liveDeriveOk,
    detail: thresholdDetail,
  });

  // 5. Customer raw disclosure denials & actor-field matrix alignment
  const rawDenied = policy.customer.forbid_raw_disclosure;
  const derivedAllowed = new Set(policy.customer.allowed_derived_representations);
  const matrixDeniesRaw = rawDenied.every((pid) => {
    const access = pack.matrix[pid]?.customer;
    return access === "deny" || access === "derived";
  });
  const disclosureOk =
    rawDenied.length === 4 &&
    derivedAllowed.size === 2 &&
    derivedAllowed.has("recycled_total_with_basis") &&
    derivedAllowed.has("lead_screening") &&
    matrixDeniesRaw;
  checks.push({
    id: "P08-05-derived-disclosure-bounds",
    category: "operators",
    description: "Customer policy and actor-field matrix withhold raw restricted properties and emit permitted derived statements only",
    passed: disclosureOk,
    detail: `denied=${rawDenied.length}, matrixAligned=${matrixDeniesRaw}`,
  });

  // 6. Terminology, distinct EN/DE labels, approved narrative context labels, language-independent numbers, string material code
  const distinctBilingualCount = pack.properties.filter(
    (p) => p.labels.en.trim().length > 0 && p.labels.de.trim().length > 0 && p.labels.en.trim() !== p.labels.de.trim(),
  ).length;
  const narrativeProp = pack.properties.find((p) => p.definitionRef.endsWith("/authorisedProductDescriptions"));
  const hasEnDeContext =
    Boolean(narrativeProp) &&
    narrativeProp!.contextLabels.some((l) => l.lang === "en") &&
    narrativeProp!.contextLabels.some((l) => l.lang === "de");
  const custCodeProp = pack.properties.find((p) => p.definitionRef.endsWith("/customerMaterialCode"));
  const stringCodePreserved = Boolean(custCodeProp) && custCodeProp!.unit === null && pack.contracts.codeList.entries.length > 0;
  const numericLangIndependent = pack.inputs.erp.decimal_separator === ".";
  const g12Ok = distinctBilingualCount >= 20 && hasEnDeContext && stringCodePreserved && numericLangIndependent;
  checks.push({
    id: "P08-06-terminology-and-company-encodings",
    category: "terminology",
    description: "EN/DE terminology is distinct and release-governed, numeric storage is language-independent, and material codes preserve string encoding",
    passed: g12Ok,
    detail: `bilingualDistinct=${distinctBilingualCount}/24, enDeNarrative=${hasEnDeContext}, stringCode=${stringCodePreserved}, decimalSep=${pack.inputs.erp.decimal_separator}`,
  });

  // 7. Standing EU registry hold (derived directly from pack, never hardcoded)
  const registryProfileConfirmed = policy.registry.aluminium_registration_profile_confirmed;
  const registrySubmission = pack.routes.registry.submission ?? null;
  const registryHoldReason = pack.routes.registry.holdReason ?? expReg.failure ?? null;
  const regHoldOk =
    registryProfileConfirmed === false &&
    pack.routes.registry.status === "HOLD" &&
    registrySubmission === "never" &&
    /TARGET_PROFILE_UNCONFIRMED/.test(expReg.failure ?? "");
  checks.push({
    id: "P08-07-standing-registry-hold",
    category: "registry-hold",
    description: "Registry route remains on standing hold (TARGET_PROFILE_UNCONFIRMED, submission=never) until an external contract exists",
    passed: regHoldOk,
    detail: `profileConfirmed=${String(registryProfileConfirmed)}, routeStatus=${pack.routes.registry.status}, submission=${String(registrySubmission)}`,
  });

  return {
    profileId: pack.id,
    profileVersion: pack.version,
    manifestDigest: pack.manifestDigest,
    propertyCount: pack.properties.length,
    registryProfileConfirmed,
    registrySubmission,
    registryHoldReason,
    checks,
    passed: checks.every((c) => c.passed),
  };
}
