/**
 * Layer 3 reference conformance suite (Cycle 9: C9-02, C9-03, C9-04, C9-05, C9-06).
 *
 * 1. Always runs (including CI) against the regenerated synthetic public stand-in (`contracts/n` + `fixtures/n`).
 * 2. Locally (when `spec/contracts/n` and `spec/trustainability/reference_package` exist, guarded by
 *    `describe.runIf`), executes ALL 28 pinned reference cases `REF-01`..`REF-28` directly against the
 *    TypeScript `referencePipeline` and asserts exact oracle parity with `expected/baseline/customer.json`,
 *    `expected/baseline/internal.csv`, and `expected/baseline/registry.json`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOperationContext, dispatchExchangeEnvelope, validateOperationContext } from "../../src/model/context";
import { loadProfilePack, type PackSource, type PinnedReferenceContracts } from "../../src/model/profile";
import { checkBoundedSchema } from "../../src/model/recordSchemaCheck";
import {
  canonicalDigest,
  executeReferencePipeline,
  exportReferenceRoute,
  parseCommaCsvRows,
  verifyReferenceManifest,
} from "../../src/model/referencePipeline";

function loadPackFromDisk(dir: string) {
  const abs = resolve(dir);
  const manifestRaw = readFileSync(join(abs, "MANIFEST.json"), "utf8");
  const manifest = JSON.parse(manifestRaw);
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const rel = relative(abs, p);
        if (rel !== "MANIFEST.json" && !rel.endsWith("README.md") && !rel.endsWith(".DS_Store")) {
          files[rel] = readFileSync(p, "utf8");
        }
      }
    }
  };
  walk(abs);
  const src: PackSource = {
    dir,
    manifest,
    files,
    manifestDigest: createHash("sha256").update(manifestRaw).digest("hex"),
  };
  return loadProfilePack(src);
}

describe("Cycle 9 conformance: regenerated synthetic public stand-in (CI-safe)", () => {
  it("loads contracts/n, executes all 3 routes, validates 17-field typed context, and blocks restricted raw leakage", async () => {
    const pack = await loadPackFromDisk("contracts/n");
    const erp = readFileSync(resolve("fixtures/n/erp-extract.csv"), "utf8");
    const labRaw = readFileSync(resolve("fixtures/n/lab-assessment.json"), "utf8");
    const lab = JSON.parse(labRaw);

    const res = await executeReferencePipeline(erp, lab, pack.contracts, { standIn: true, labRawText: labRaw });
    expect(res.status).toBe("EXECUTED_REFERENCE");
    expect(res.import?.status).toBe("IMPORTED");
    expect(res.outputs?.customer.status).toBe("RELEASED_REFERENCE_VIEW");
    expect(res.outputs?.internal.status).toBe("RELEASED_REFERENCE_VIEW");
    expect(res.outputs?.registry.status).toBe("HOLD");
    expect(res.outputs?.registry.code).toBe("TARGET_PROFILE_UNCONFIRMED");
    expect(res.outputs?.registry.not_a_registration_request).toBe(true);

    // Witness assertions on stand-in customer projection
    const cust = res.outputs!.customer;
    expect(cust.status).toBe("RELEASED_REFERENCE_VIEW");
    if (cust.status === "RELEASED_REFERENCE_VIEW") {
      expect(cust.payload.customer_material_code).toBe("004215");
      expect(cust.payload.nominal_dimensions_m).toEqual({ thickness: 0.0015, width: 1.25, length: 2.5 });
      expect(cust.payload.recycled_content.declared_percent).toBe(65);
      expect(cust.payload.lead_screening.statement).toContain("<80 mg/kg");
    }

    // Zero raw restricted leakage into customer + registry
    const external = JSON.stringify([res.outputs!.customer, res.outputs!.registry]);
    for (const forbidden of ["31.4", "1.95", "ST-EV-PB-01", "EV-RC-DECL-001", "private_route_diagnostics", "source_files"]) {
      expect(external).not.toContain(forbidden);
    }

    // German variant
    const deRes = await executeReferencePipeline(erp, lab, pack.contracts, { standIn: true, labRawText: labRaw, language: "de" });
    expect(deRes.outputs?.customer.status).toBe("RELEASED_REFERENCE_VIEW");
    if (deRes.outputs?.customer.status === "RELEASED_REFERENCE_VIEW") {
      expect(deRes.outputs.customer.payload.description.language).toBe("de");
      expect(deRes.outputs.customer.payload.description.text).toContain("Platzhalter");
    }

    // Typed context S5-SEM-CONTEXT-rev2
    const ctx = buildOperationContext(pack, "customer", {
      model: "ST-5754-M01",
      revision: "P01",
      batch: "ST-LOT-2026-001",
      manufacturerId: "ST-MFR-01",
    });
    const ctxRes = validateOperationContext(ctx, {
      route: "customer",
      expectedProfileReleaseId: ctx.profile_release_id as string,
      expectedRecipient: pack.contracts.profilePolicy.customer.recipient,
      expectedPurpose: pack.contracts.profilePolicy.customer.purpose,
    });
    expect(ctxRes.ok).toBe(true);

    // Exchange separation S5-EXCHANGE-rev2
    expect(dispatchExchangeEnvelope("DPPPayload", res.import!.record).ok).toBe(true);
    expect(dispatchExchangeEnvelope("RegistryRequest", res.import!.record).code).toBe("EXCHANGE_TYPE_MISMATCH");
    expect(dispatchExchangeEnvelope("RegistryRequest", res.outputs!.registry).code).toBe("HOLD_TARGET_PROFILE_UNCONFIRMED");
    expect(dispatchExchangeEnvelope("DPPPayload", res.outputs!.registry).code).toBe("EXCHANGE_TYPE_MISMATCH");

    // Manifest integrity & tamper detection
    expect(await verifyReferenceManifest(res.manifest!)).toBe(true);
    const tampered = structuredClone(res.manifest!) as Record<string, any>;
    tampered.output_digests.customer = "0".repeat(64);
    expect(await verifyReferenceManifest(tampered)).toBe(false);
  });
});

// ── Private REF-01..REF-28 Oracle Suite (local only, git-ignored spec/) ──

const REF_ROOT = resolve("spec/trustainability/reference_package");
const PRIVATE_PACK = resolve("spec/contracts/n");
const HAS_PRIVATE = existsSync(join(REF_ROOT, "fixtures/cases.json")) && existsSync(join(PRIVATE_PACK, "MANIFEST.json"));

interface RefCase {
  case_id: string;
  scenario: string;
  changes: Array<{ target: "erp" | "lab" | "resources"; path: string[]; op?: "set" | "delete" | "duplicate_first"; value?: unknown }>;
  expected_import: "IMPORTED" | "IMPORTED_WITH_SHAPE_ISSUES" | "REJECT";
  expected_routes: string;
  checks: string[];
  expected: string;
}

const RESOURCE_KEY_MAP: Record<string, keyof PinnedReferenceContracts> = {
  code_list: "codeList",
  import_erp: "importErp",
  import_lab: "importLab",
  export_customer: "exportCustomer",
  export_internal: "exportInternal",
  export_registry: "exportRegistry",
  profile_policy: "profilePolicy",
  catalogue: "catalogue",
  context: "contextLd",
  record_schema: "recordSchema",
};

function applyCaseChanges(
  c: RefCase,
  origErp: string,
  origLab: Record<string, unknown>,
  origContracts: PinnedReferenceContracts,
) {
  const row = parseCommaCsvRows(origErp)[0]!;
  const headers = Object.keys(row);
  const lab = structuredClone(origLab);
  const contracts = structuredClone(origContracts);
  let erpTouched = false;

  for (const ch of c.changes) {
    let parent: any;
    let path = [...ch.path];
    if (ch.target === "erp") {
      parent = row;
      erpTouched = true;
    } else if (ch.target === "lab") {
      parent = lab;
    } else {
      const mappedKey = RESOURCE_KEY_MAP[path[0]!];
      if (!mappedKey) throw new Error(`Unknown resource key ${path[0]}`);
      parent = contracts[mappedKey];
      path = path.slice(1);
    }
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i]!;
      if (parent[seg] === undefined) parent[seg] = {};
      parent = parent[seg];
    }
    const last = path[path.length - 1]!;
    const op = ch.op ?? "set";
    if (op === "delete") delete parent[last];
    else if (op === "duplicate_first") parent[last].push(structuredClone(parent[last][0]));
    else parent[last] = structuredClone(ch.value);
  }

  const erp = erpTouched
    ? `${headers.join(",")}\n${headers.map((h) => row[h] ?? "").join(",")}\n`
    : origErp;
  return { erp, lab, contracts };
}

describe.runIf(HAS_PRIVATE)("Cycle 9 private conformance: all 28 reference cases REF-01..REF-28 (C9-03)", () => {
  const cases: RefCase[] = HAS_PRIVATE ? JSON.parse(readFileSync(join(REF_ROOT, "fixtures/cases.json"), "utf8")) : [];
  const origErp = HAS_PRIVATE ? readFileSync(join(REF_ROOT, "inputs/erp.csv"), "utf8") : "";
  const origLabRaw = HAS_PRIVATE ? readFileSync(join(REF_ROOT, "inputs/lab_assessment.json"), "utf8") : "{}";
  const origLab = JSON.parse(origLabRaw);
  const expectedBaselineCustomer = HAS_PRIVATE ? JSON.parse(readFileSync(join(REF_ROOT, "expected/baseline/customer.json"), "utf8")) : {};
  const expectedBaselineInternalCsv = HAS_PRIVATE ? readFileSync(join(REF_ROOT, "expected/baseline/internal.csv"), "utf8") : "";
  const expectedBaselineRegistry = HAS_PRIVATE ? JSON.parse(readFileSync(join(REF_ROOT, "expected/baseline/registry.json"), "utf8")) : {};
  // Expected values are read from the git-ignored reference inputs, never written into this tracked file.
  const screeningRule = HAS_PRIVATE ? JSON.parse(readFileSync(join(REF_ROOT, "contracts/profile_policy.json"), "utf8")).screening_rule : {};
  const baseRow: Record<string, string> = HAS_PRIVATE ? parseCommaCsvRows(origErp)[0]! : {};
  const leadText = HAS_PRIVATE ? String(origLab.lab_tests.lead.value) : "";
  const costText = baseRow.internal_conversion_cost_eur_per_kg ?? "";
  const leadEvidence: string = HAS_PRIVATE ? origLab.lab_tests.lead.evidence_refs[0] : "";
  const recycledEvidence: string = HAS_PRIVATE ? origLab.recycled_content.evidence[0].evidence_id : "";

  it("matches expected/baseline/customer.json payload, internal.csv, and registry.json exactly on REF-01", async () => {
    const pack = await loadPackFromDisk("spec/contracts/n");
    const res = await executeReferencePipeline(origErp, origLab, pack.contracts, { standIn: false, labRawText: origLabRaw });
    expect(res.status).toBe("EXECUTED_REFERENCE");
    expect(res.import?.status).toBe("IMPORTED");
    const cust = res.outputs!.customer;
    expect(cust.status).toBe("RELEASED_REFERENCE_VIEW");
    if (cust.status === "RELEASED_REFERENCE_VIEW") {
      expect(cust.payload).toEqual(expectedBaselineCustomer.payload);
    }
    const intl = res.outputs!.internal;
    expect(intl.status).toBe("RELEASED_REFERENCE_VIEW");
    if (intl.status === "RELEASED_REFERENCE_VIEW") {
      expect(intl.csv).toBe(expectedBaselineInternalCsv);
    }
    expect(res.outputs!.registry).toEqual(expectedBaselineRegistry);
  });

  for (const c of cases) {
    it(`${c.case_id}: ${c.scenario}`, async () => {
      const pack = await loadPackFromDisk("spec/contracts/n");
      const baseline = await executeReferencePipeline(origErp, origLab, pack.contracts, { standIn: false, labRawText: origLabRaw });
      const { erp, lab, contracts } = applyCaseChanges(c, origErp, origLab, pack.contracts);
      const labRaw = JSON.stringify(lab) === JSON.stringify(origLab) ? origLabRaw : `${JSON.stringify(lab, null, 2)}\n`;
      const result = await executeReferencePipeline(erp, lab, contracts, { standIn: false, labRawText: labRaw });

      expect(result.status).toBe("EXECUTED_REFERENCE");
      expect(result.import!.status).toBe(c.expected_import);

      const routeTriple = (["customer", "internal", "registry"] as const)
        .map((r) => (result.outputs![r].status === "RELEASED_REFERENCE_VIEW" ? "R" : "H"))
        .join(",");
      expect(routeTriple).toBe(c.expected_routes);

      const out = result.outputs!;
      const record = result.import!.record;
      const priv = result.private_diagnostics!;
      const idOf = (suffix: string) => {
        const found = contracts.catalogue.find((p) => p.semantic_uri.endsWith(`/${suffix}`));
        if (!found) throw new Error(`Missing semantic suffix ${suffix}`);
        return found.id;
      };

      for (const name of c.checks) {
        if (name === "baseline_values") {
          expect(Object.keys(record!.properties)).toHaveLength(24);
          expect((record!.properties[idOf("declaredTotalRecycledContent")] as any).value).toBe(Number(baseRow.recycled_total_percent));
          expect((record!.properties[idOf("postConsumerRecycledContent")] as any).value).toBe(Number(baseRow.post_consumer_percent));
          expect(out.internal.status).toBe("RELEASED_REFERENCE_VIEW");
          if (out.internal.status === "RELEASED_REFERENCE_VIEW") {
            expect(out.internal.csv).toContain(leadText);
            expect(out.internal.csv).toContain(costText);
          }
          expect(out.registry.code).toBe("TARGET_PROFILE_UNCONFIRMED");
          expect(out.registry.not_a_registration_request).toBe(true);
        } else if (name === "source_bytes") {
          const byId = Object.fromEntries(result.import!.source_files.map((s) => [s.source_id, s]));
          expect(byId["SRC-ERP-CSV-01"]!.raw_content).toBe(erp);
          expect(byId["SRC-LAB-JSON-01"]!.raw_content).toBe(labRaw);
          for (const s of Object.values(byId)) {
            expect(createHash("sha256").update(s.raw_content, "utf8").digest("hex")).toBe(s.sha256);
          }
        } else if (name === "no_private_disclosure") {
          const external = JSON.stringify([out.customer, out.registry]);
          for (const forbidden of [leadText, costText, leadEvidence, recycledEvidence, "private_route_diagnostics", "source_files", "source_values"]) {
            expect(forbidden.length).toBeGreaterThan(0);
            expect(external).not.toContain(forbidden);
          }
          if (out.customer.status === "RELEASED_REFERENCE_VIEW") {
            expect(out.customer.payload.lead_screening.statement).toBe(screeningRule.statement);
            expect(out.customer.payload.lead_screening.qualification).toBe(screeningRule.qualification);
          }
        } else if (name === "manifest_valid") {
          expect(await verifyReferenceManifest(result.manifest!)).toBe(true);
        } else if (name === "raw_preserved") {
          expect(result.import!.source_files).toHaveLength(2);
          expect(result.import!.source_files[0]!.raw_content).toBe(erp);
          expect(JSON.parse(result.import!.source_files[1]!.raw_content)).toEqual(lab);
          expect(result.import!.raw_assertions.length).toBeGreaterThan(0);
        } else if (name === "identity_and_dimensions") {
          expect((record!.properties[idOf("customerMaterialCode")] as any)[0].value).toBe(baseRow.customer_material_code);
          expect((record!.properties[idOf("nominalSheetThickness")] as any).value).toBe(Number(baseRow.nominal_thickness_mm));
          expect((record!.properties[idOf("measuredSheetThickness")] as any)[0].value).toBe(origLab.lab_tests.thickness.value);
          if (out.customer.status === "RELEASED_REFERENCE_VIEW") {
            expect(out.customer.payload.nominal_dimensions_m.thickness).toBe(Number(baseRow.nominal_thickness_mm) / 1000);
          }
        } else if (name === "missing_private_reason") {
          expect(priv.customer.some((i) => i.kind === "required_source_missing")).toBe(true);
        } else if (name === "denied_private_reason") {
          expect(priv.customer.some((i) => i.kind === "processing_not_permitted")).toBe(true);
        } else if (name === "safe_hold") {
          expect(out.customer).toEqual({
            status: "HOLD",
            synthetic: true,
            code: "REQUIREMENTS_NOT_SATISFIED",
            message: "This route is not releasable. An authorised internal operator can inspect the detailed reason.",
          });
        } else if (name === "customer_same_as_baseline") {
          expect(out.customer).toEqual(baseline.outputs!.customer);
        } else if (name === "conflict_preserved") {
          const preId = idOf("preConsumerRecycledContent");
          const v = record!.properties[preId] as any;
          expect(v.preferred_assertion.value).toBe(Number(parseCommaCsvRows(erp)[0]!.pre_consumer_percent));
          expect(v.conflicting_assertion.value).toBe((lab as any).recycled_content.conflicting_pre_percent);
          expect(record!.assertions.filter((a) => a.property_id === preId)).toHaveLength(2);
        } else if (name === "reproducible") {
          const again = await executeReferencePipeline(erp, lab, contracts, { standIn: false, labRawText: labRaw });
          expect(result.outputs).toEqual(again.outputs);
          expect(result.manifest).toEqual(again.manifest);
        } else if (name === "mapping_version_trace") {
          expect(result.outputs).toEqual(baseline.outputs);
          expect((result.manifest!.resource_digests as any).export_customer).not.toBe((baseline.manifest!.resource_digests as any).export_customer);
          expect(result.manifest!.manifest_digest).not.toBe(baseline.manifest!.manifest_digest);
        } else if (name === "tamper_detected") {
          const altered = structuredClone(result.manifest!) as Record<string, any>;
          altered.output_digests.customer = "tampered";
          expect(await verifyReferenceManifest(altered)).toBe(false);
        } else if (name === "german_text") {
          expect(out.customer.status).toBe("RELEASED_REFERENCE_VIEW");
          if (out.customer.status === "RELEASED_REFERENCE_VIEW") {
            expect(out.customer.payload.description.language).toBe("de");
            expect(out.customer.payload.description.text).toBe(origLab.authorised_texts.find((t: { language: string }) => t.language === "de").text);
          }
        } else if (name === "wrong_recipient") {
          const { output: denied } = exportReferenceRoute(record, contracts, "customer", { recipient: "UNAPPROVED" });
          expect(denied.status).toBe("HOLD");
          expect(JSON.stringify(denied)).not.toContain("UNAPPROVED");
        } else if (name === "shape_issue") {
          expect(record!.issues.some((i) => i.kind === "selected_record_shape_error")).toBe(true);
        } else if (name === "private_canary") {
          expect(JSON.stringify(record)).toContain("PRIVATE-CANARY-");
          expect(JSON.stringify(out)).not.toContain("PRIVATE-CANARY-");
        } else if (name === "unsupported_keyword") {
          expect(checkBoundedSchema({}, { type: "object", unevaluatedProperties: false }).length).toBeGreaterThan(0);
        } else if (name === "context_revision_changes") {
          expect(record!.revision).not.toBe(baseline.import!.record!.revision);
          const { revision: _r, ...rest } = record!;
          expect(record!.revision).toBe(await canonicalDigest(rest));
          expect(result.outputs).toEqual(baseline.outputs);
        } else {
          throw new Error(`Unknown check: ${name}`);
        }
      }
    });
  }
});
