/**
 * Loads the frozen N profile from the contract pack, through its manifest digests only (Cycle 1:
 * FUNC-001, 027, 028, 029, 030, 031, 081, 091 and 025 slices; aligned in Cycle 9 to the pinned
 * 24-property catalogue, PROFILE-ALU-24-01 1.0.0, SRC-ERP-CSV-01, SRC-LAB-JSON-01, and MAP-* contracts).
 *
 * Every file must match its sha256 in MANIFEST.json, every reference names an exact id@version,
 * and every definition and nested member resolves to a governed term. Any break throws ProfileError.
 */
import { parse } from "yaml";
import { z } from "zod";
import { canonical } from "./canonical";
import { OperationalLimitsSchema, type OperationalLimits } from "./c8Contracts";
import { ExceptionCatalogueSchema, RetentionPolicySchema, type ExceptionCatalogue, type RetentionPolicy } from "./pContracts";

export const ROUTES = ["customer", "internal", "registry"] as const;
export type Route = (typeof ROUTES)[number];

/** Workbook route names (A-15). */
export const ROUTE_NAMES: Record<Route, string> = {
  customer: "Customer data sheet (PDF)",
  internal: "Internal ERP staging file (CSV)",
  registry: "Registry preparation file (JSON)",
};

/** The files of one contract pack, as the build embeds them (see vite.config.ts). */
export interface PackSource {
  dir: string;
  manifest: { pack: string; profile: string; files: Record<string, string> };
  /** Every file in the pack directory apart from MANIFEST.json, by path, as text. */
  files: Record<string, string>;
  /** sha256 of MANIFEST.json, the digest approved by the owner in SIGNATURES.json. */
  manifestDigest: string;
}

export class ProfileError extends Error {
  override name = "ProfileError";
}

const PIN = /^[A-Za-z][A-Za-z0-9-]*@\d+\.\d+\.\d+$/;
const pin = z.string().regex(PIN, "must be an exact id@version, never a moving version such as latest");

const ContextLabel = z.object({ lang: z.string().regex(/^[a-z]{2,3}$/), context: z.string().min(1), text: z.string().min(1) });

const ProfileDoc = z.object({
  id: z.literal("PROFILE-ALU-24-01"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "must be an exact semver version"),
  status: z.literal("FROZEN"),
  stand_in: z.boolean(),
  source: z.string(),
  release: z.object({ released: z.string(), released_by: z.string(), basis: z.string() }),
  product_family: z.string(),
  languages: z.array(z.string()),
  sectors: pin,
  routes: z.tuple([z.literal(ROUTES[0]), z.literal(ROUTES[1]), z.literal(ROUTES[2])]),
  pins: z.object({
    terms: pin,
    legal: pin,
    units: pin,
    code_lists: z.array(pin),
    inputs: z.array(pin),
    route_contracts: z.array(pin),
    policy: z.array(pin),
  }),
  properties: z.array(
    z.object({
      id: z.string().regex(/^ALU-D\d{3}$/),
      definition_ref: z.string().min(1),
      datatype: z.string().min(1).optional(),
      unit: z.string().nullable(),
      labels: z.object({ en: z.string().min(1), de: z.string().min(1) }),
      required_by: z.object({ customer: z.boolean(), internal: z.boolean(), registry: z.boolean() }),
      members: z.array(z.string()),
      context_labels: z.array(ContextLabel).optional(),
      basis: z.string().min(1).optional(),
      quantity_kind: z.string().optional(),
    }),
  ),
});

const TermsDoc = z.object({
  id: z.string(),
  version: z.string(),
  terms: z.array(z.object({ id: z.string(), label: z.string(), definition: z.string().min(1) })),
});

const LegalDoc = z.object({
  id: z.string(),
  version: z.string(),
  note: z.string(),
  statuses: z.record(z.string(), z.string()),
  entries: z.array(
    z.object({ property: z.string(), status: z.string(), requirement: z.string().optional(), legislation: z.string().optional() }),
  ),
});

const UnitsDoc = z.object({
  id: z.string(),
  version: z.string(),
  units: z.array(z.object({ code: z.string(), name: z.string() })),
  conversions: z.array(z.object({ from: z.string(), to: z.string(), factor: z.number() })),
});

const ErpContractDoc = z.object({
  id: z.literal("SRC-ERP-CSV-01"),
  version: z.string(),
  media_type: z.literal("text/csv"),
  encoding: z.literal("UTF-8"),
  byte_order_mark: z.literal("rejected"),
  delimiter: z.string().length(1),
  decimal_separator: z.string().length(1),
  columns: z.array(
    z.object({
      name: z.string(),
      maps_to: z.string(),
      language: z.string().optional(),
      unit: z.string().nullable(),
      code_list: z.string().optional(),
      format: z.string().optional(),
      required: z.boolean(),
    }),
  ),
});

const LabContractDoc = z.object({
  id: z.literal("SRC-LAB-JSON-01"),
  version: z.string(),
  media_type: z.literal("application/json"),
  encoding: z.literal("UTF-8"),
  structure: z.record(z.string(), z.unknown()),
  allowed_units: z.record(z.string(), z.array(z.string())),
});

const OutputReads = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("value"), details: z.array(z.string()).optional() }),
  z.object({ kind: z.literal("members"), members: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("member"), member: z.string() }),
  z.object({ kind: z.literal("derived"), rule: z.string() }),
]);

const OutputItemDoc = z.object({
  step: z.string().regex(/^MAP-(PDF|ERP|REG)-\d{3}$/),
  role: z.enum(["field", "context"]),
  property: z.string(),
  reads: OutputReads,
  unit: z.string().optional(),
  csv: z.object({ name: z.string().min(1), header: z.string().min(1), format: z.enum(["number", "text"]) }).optional(),
  json: z.object({ path: z.string().startsWith("/") }).optional(),
  pdf: z.object({ section: z.string(), order: z.number().int(), label: z.object({ en: z.string().min(1), de: z.string().min(1) }) }).optional(),
});

const RouteDoc = z.object({
  id: z.enum(ROUTES),
  version: z.string(),
  recipient: z.string().min(1),
  purpose: z.string().optional(),
  format: z.string().min(1),
  target_contract: z.string().optional(),
  mapping_contract: z.string().optional(),
  status: z.enum(["FROZEN", "HOLD"]),
  submission: z.string().optional(),
  hold_reason: z.string().optional(),
  fields: z.array(z.string()),
  output: z.object({ sections: z.array(z.object({ id: z.string(), en: z.string(), de: z.string() })).optional(), items: z.array(OutputItemDoc).min(1) }),
});

const RuleText = z.object({ id: z.string().regex(/^[A-Z]{2}-[A-Z-]+$/), text: z.string().min(1) });
const ReadinessDoc = z.object({
  id: z.literal("READINESS-RULES"),
  version: z.string(),
  rules: z.array(RuleText),
  checks: z.array(RuleText),
});

const ScreeningRuleDoc = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  threshold_mg_per_kg: z.number().positive(),
  accepted_method: z.string().min(1),
  accepted_qualifier: z.string().min(1),
  accepted_uncertainty_kind: z.string().min(1),
  accepted_coverage_factor: z.number().positive(),
  predicate: z.string().min(1),
  statement: z.string().min(1),
  qualification: z.string().min(1),
});

const DerivedDoc = z.object({
  id: z.literal("DERIVED-RULES"),
  version: z.string(),
  rules: z.array(
    z.object({
      id: z.string().regex(/^DR-[A-Z-]+$/),
      property: z.string(),
      representation: z.enum(["recycled_total_with_basis", "lead_screening"]),
      method: z.enum(["recycled-total-with-basis", "uncertainty-guard-band-screen"]),
      output: z.string().min(1),
      expected_method_id: z.string().optional(),
      expected_eligibility: z.string().optional(),
      qualification: z.string().optional(),
      screening_rule: ScreeningRuleDoc.optional(),
    }),
  ),
});

const LimitsDoc = z.object({
  id: z.literal("LIMITS"),
  version: z.string(),
  limits: z.object({
    max_file_bytes: z.number().int().positive(),
    max_json_depth: z.number().int().positive(),
    job_deadline_ms: z.number().int().positive(),
    max_erp_data_rows: z.number().int().positive(),
    note: z.string(),
  }),
});

export interface MappingRule {
  id: string;
  target: string;
  selector: string[];
  operator: string;
  loss: string;
}

export interface MappingContract {
  id: string;
  version: string;
  direction: "import" | "export";
  source_contract: string;
  target_contract: string;
  rules: MappingRule[];
  preconditions?: string[];
  failure?: string;
}

export interface ReferenceCodeList {
  id: string;
  version: string;
  synthetic: boolean;
  entries: Array<{
    source_company: string;
    code_list_version: string;
    material_code: string;
    model_id: string;
    alloy: string;
  }>;
}

export interface ReferenceProfilePolicy {
  id: string;
  version: string;
  synthetic: boolean;
  source_assurance_required: string;
  independent_verification_required: boolean;
  customer: {
    recipient: string;
    purpose: string;
    forbid_raw_disclosure: string[];
    allowed_derived_representations: string[];
    language: string;
    expected_pcf_method: string;
    expected_reference_unit: string;
    expected_boundary: string;
    route_required_source_properties: string[];
    permitted_processing_properties: string[];
    deny_processing_properties: string[];
    required_output_fields: string[];
    permission_boundary?: string;
  };
  internal: {
    recipient: string;
    purpose: string;
    route_required_source_properties: string[];
    permitted_processing_properties: string[];
    deny_processing_properties: string[];
  };
  registry: {
    recipient: string;
    aluminium_registration_profile_confirmed: boolean;
    route_required_source_properties: string[];
    permitted_processing_properties: string[];
    deny_processing_properties: string[];
  };
  screening_rule: z.infer<typeof ScreeningRuleDoc>;
  deployment_boundary?: string;
}

export interface PinnedReferenceContracts {
  catalogue: Array<{
    id: string;
    label_en: string;
    label_de: string;
    definition: string;
    datatype: string;
    unit: string | null;
    semantic_uri: string;
  }>;
  codeList: ReferenceCodeList;
  contextLd: { "@context": Record<string, unknown> };
  recordSchema: Record<string, unknown>;
  profilePolicy: ReferenceProfilePolicy;
  importErp: MappingContract;
  importLab: MappingContract;
  exportCustomer: MappingContract;
  exportInternal: MappingContract;
  exportRegistry: MappingContract;
  digests: {
    catalogue: string;
    codeList: string;
    contextLd: string;
    recordSchema: string;
    profilePolicy: string;
    importErp: string;
    importLab: string;
    exportCustomer: string;
    exportInternal: string;
    exportRegistry: string;
  };
}

export type ErpContract = z.infer<typeof ErpContractDoc>;
export type LabContract = z.infer<typeof LabContractDoc>;
export type ReadinessRules = z.infer<typeof ReadinessDoc>;
export type DerivedRules = z.infer<typeof DerivedDoc>;
export type InputLimits = z.infer<typeof LimitsDoc>["limits"];
export type Access = "permit" | "deny" | "derived";
export type OutputItem = z.infer<typeof OutputItemDoc>;

export interface RouteInfo {
  id: Route;
  output: OutputItem[];
  sections: Array<{ id: string; en: string; de: string }>;
  recipient: string;
  purpose?: string;
  format: string;
  targetContract?: string;
  mappingContract?: string;
  status: "FROZEN" | "HOLD";
  holdReason?: string;
}

export interface PinnedFile {
  ref: string;
  path: string;
  digest: string;
}

export interface CodeList extends PinnedFile {
  description: string;
  codes: Array<{ code: string; mapsTo?: string }>;
}

export interface ResolvedProperty {
  id: string;
  definitionRef: string;
  definition: string;
  datatype: string;
  labels: { en: string; de: string };
  contextLabels: Array<{ lang: string; context: string; text: string }>;
  unit: string | null;
  unitName: string | null;
  requiredBy: Record<Route, boolean>;
  members: Array<{ id: string; definition: string }>;
  basis?: string;
  legal: { status: string; statusText: string; requirement?: string; legislation?: string };
}

export interface ProfilePack {
  dir: string;
  id: string;
  version: string;
  standIn: boolean;
  source: string;
  release: { released: string; releasedBy: string; basis: string };
  productFamily: string;
  languages: string[];
  sectors: string[];
  properties: ResolvedProperty[];
  codeLists: CodeList[];
  pins: PinnedFile[];
  termCount: number;
  legalNote: string;
  legalStatuses: Record<string, string>;
  manifestDigest: string;
  fileCount: number;
  inputs: { erp: ErpContract; lab: LabContract };
  routes: Record<Route, RouteInfo>;
  matrix: Record<string, Record<Route, Access>>;
  policy: {
    readiness: ReadinessRules;
    derived: DerivedRules;
    limits: InputLimits;
    retention: RetentionPolicy;
    exceptions: ExceptionCatalogue;
  };
  operationalLimits: OperationalLimits;
  /** Pinned reference JSON contracts & canonical digests (Cycle 9: C9-01..C9-06). */
  contracts: PinnedReferenceContracts;
}

function parseMatrix(text: string, propertyIds: string[]): ProfilePack["matrix"] {
  const rows = text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => l.split(",").map((c) => c.trim()));
  const [header = [], ...body] = rows;
  if (header.join(",") !== ["property", ...ROUTES].join(",")) {
    throw new ProfileError(`actor/field matrix: header must be property,${ROUTES.join(",")}`);
  }
  const matrix: ProfilePack["matrix"] = {};
  for (const row of body) {
    const cells = Object.fromEntries(ROUTES.map((r, i) => [r, row[i + 1]]));
    for (const [route, value] of Object.entries(cells)) {
      if (value !== "permit" && value !== "deny" && value !== "derived") {
        throw new ProfileError(`actor/field matrix ${row[0]}, ${route}: "${value}" is not permit, deny or derived`);
      }
    }
    if (Object.hasOwn(matrix, row[0])) throw new ProfileError(`actor/field matrix: ${row[0]} appears twice`);
    matrix[row[0]] = cells as Record<Route, Access>;
  }
  for (const id of propertyIds) if (!Object.hasOwn(matrix, id)) throw new ProfileError(`actor/field matrix has no row for ${id}`);
  for (const id of Object.keys(matrix)) if (!propertyIds.includes(id)) throw new ProfileError(`actor/field matrix row ${id} is not a profile property`);
  return matrix;
}

const LOADED_RETENTION = new WeakMap<object, string>();
export const loadedRetentionDigest = (policy: object): string | undefined => LOADED_RETENTION.get(policy);

export async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseWith<T>(schema: z.ZodType<T>, path: string, text: string): T {
  const result = schema.safeParse(parse(text));
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ProfileError(`${path}: ${issue.path.join(".") || "document"} ${issue.message}`);
  }
  return result.data;
}

function parseCodeList(text: string) {
  const lines = text.split(/\r?\n/);
  const description = lines.find((l) => l.startsWith("#"))?.replace(/^#\s*/, "") ?? "";
  const rows = lines.filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split(",").map((c) => c.trim()));
  const [header = [], ...body] = rows;
  const mapped = header[1] === "maps_to";
  return { description, codes: body.map((r) => (mapped ? { code: r[0], mapsTo: r[1] } : { code: r[0] })) };
}

export async function loadProfilePack(source: PackSource): Promise<ProfilePack> {
  const { manifest, files } = source;
  const digests = new Map<string, string>();
  const assertSafePackPath = (path: string) => {
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes("\u0000") ||
      path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
    ) {
      throw new ProfileError(`invalid pack file path: ${JSON.stringify(path)}`);
    }
  };
  for (const path of Object.keys(files)) {
    assertSafePackPath(path);
    if (!Object.hasOwn(manifest.files, path)) throw new ProfileError(`${path} is not in MANIFEST.json`);
  }
  for (const [path, expected] of Object.entries(manifest.files)) {
    assertSafePackPath(path);
    const text = Object.hasOwn(files, path) ? files[path] : undefined;
    if (typeof text !== "string") throw new ProfileError(`${path} is in MANIFEST.json but missing`);
    const actual = await sha256Hex(text);
    if (actual !== expected) throw new ProfileError(`${path} does not match its pinned digest`);
    digests.set(path, actual);
  }

  if (!PIN.test(manifest.profile) || !manifest.profile.startsWith("PROFILE-ALU-24-01@")) {
    throw new ProfileError(`manifest profile ${manifest.profile} must be an exact PROFILE-ALU-24-01@x.y.z version`);
  }
  const profilePath = `profile/${manifest.profile}.yaml`;
  const profile = parseWith(ProfileDoc, profilePath, files[profilePath] ?? "");
  if (`${profile.id}@${profile.version}` !== manifest.profile) {
    throw new ProfileError(`manifest pins ${manifest.profile}, profile is ${profile.id}@${profile.version}`);
  }
  if (profile.properties.length !== 24) throw new ProfileError(`${profilePath}: ${profile.properties.length} properties, expected 24`);

  const pinned = (kind: string, ref: string, ext: string): PinnedFile => {
    const path = `${kind}/${ref}.${ext}`;
    const digest = digests.get(path);
    if (!digest) throw new ProfileError(`${ref} does not resolve to a pinned file (${path})`);
    return { ref, path, digest };
  };
  const pinnedDoc = <T extends { id: string; version: string }>(kind: string, ref: string, schema: z.ZodType<T>) => {
    const file = pinned(kind, ref, "yaml");
    const doc = parseWith(schema, file.path, files[file.path]);
    if (`${doc.id}@${doc.version}` !== ref) throw new ProfileError(`${file.path} is not ${ref}`);
    return { file, doc };
  };

  const terms = pinnedDoc("terms", profile.pins.terms, TermsDoc);
  const legal = pinnedDoc("legal", profile.pins.legal, LegalDoc);
  const units = pinnedDoc("units", profile.pins.units, UnitsDoc);
  const codeLists: CodeList[] = [...profile.pins.code_lists, profile.sectors].map((ref) => {
    const file = pinned("code-lists", ref, "csv");
    return { ...file, ...parseCodeList(files[file.path]) };
  });

  const contractPins = (kind: string, prefix: string, refs: string[]): PinnedFile[] => {
    const found = Object.keys(files)
      .filter((path) => path.startsWith(prefix))
      .map((path) => {
        const doc = parse(files[path]) as { id?: unknown; version?: unknown };
        const ref = `${String(doc.id)}@${String(doc.version)}`;
        if (!PIN.test(ref)) throw new ProfileError(`${path}: ${ref} is not an exact id@version`);
        return { ref, path, digest: digests.get(path)! };
      });
    const want = [...refs].sort().join(", ");
    if (found.map((f) => f.ref).sort().join(", ") !== want) throw new ProfileError(`${kind} must be exactly ${want}`);
    return found;
  };
  const mappingPins = [
    ...contractPins("inputs", "inputs/", profile.pins.inputs),
    ...contractPins("routes", "routes/", profile.pins.route_contracts),
  ];

  const policyFamilies = ["READINESS-RULES", "DERIVED-RULES", "LIMITS", "RETENTION", "EXCEPTIONS", "OPERATIONAL-LIMITS"] as const;
  for (const ref of profile.pins.policy) {
    const family = ref.split("@")[0];
    if (!(policyFamilies as readonly string[]).includes(family)) {
      throw new ProfileError(`${ref} is not a policy file this build reads`);
    }
  }
  const policyPinFor = (family: (typeof policyFamilies)[number]): string => {
    const matches = profile.pins.policy.filter((ref) => ref.startsWith(`${family}@`));
    if (matches.length !== 1) throw new ProfileError(`the profile must pin exactly one ${family}@x.y.z policy file`);
    return matches[0]!;
  };
  const readiness = pinnedDoc("policy", policyPinFor("READINESS-RULES"), ReadinessDoc);
  const derived = pinnedDoc("policy", policyPinFor("DERIVED-RULES"), DerivedDoc);
  const limits = pinnedDoc("policy", policyPinFor("LIMITS"), LimitsDoc);
  const retention = pinnedDoc("policy", policyPinFor("RETENTION"), RetentionPolicySchema);
  const exceptions = pinnedDoc("policy", policyPinFor("EXCEPTIONS"), ExceptionCatalogueSchema);
  const operationalLimits = pinnedDoc("policy", policyPinFor("OPERATIONAL-LIMITS"), OperationalLimitsSchema);
  LOADED_RETENTION.set(retention.doc, await sha256Hex(canonical(retention.doc)));

  const loadJson = <T>(path: string): T => {
    const text = files[path];
    if (typeof text !== "string") throw new ProfileError(`pinned contract ${path} is missing`);
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new ProfileError(`${path}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
  };
  const contracts: PinnedReferenceContracts = {
    catalogue: loadJson("contracts/catalogue.json"),
    codeList: loadJson("contracts/code_list.json"),
    contextLd: loadJson("contracts/context.jsonld"),
    recordSchema: loadJson("contracts/record.schema.json"),
    profilePolicy: loadJson("contracts/profile_policy.json"),
    importErp: loadJson("contracts/import_erp.json"),
    importLab: loadJson("contracts/import_lab.json"),
    exportCustomer: loadJson("contracts/export_customer.json"),
    exportInternal: loadJson("contracts/export_internal.json"),
    exportRegistry: loadJson("contracts/export_registry.json"),
    digests: {
      catalogue: digests.get("contracts/catalogue.json")!,
      codeList: digests.get("contracts/code_list.json")!,
      contextLd: digests.get("contracts/context.jsonld")!,
      recordSchema: digests.get("contracts/record.schema.json")!,
      profilePolicy: digests.get("contracts/profile_policy.json")!,
      importErp: digests.get("contracts/import_erp.json")!,
      importLab: digests.get("contracts/import_lab.json")!,
      exportCustomer: digests.get("contracts/export_customer.json")!,
      exportInternal: digests.get("contracts/export_internal.json")!,
      exportRegistry: digests.get("contracts/export_registry.json")!,
    },
  };

  const termById = new Map(terms.doc.terms.map((t) => [t.id, t]));
  const term = (owner: string, id: string) => {
    const found = termById.get(id);
    if (!found) throw new ProfileError(`${owner}: ${id} does not resolve to a governed term`);
    return found.definition;
  };
  const unitName = new Map(units.doc.units.map((u) => [u.code, u.name]));
  const sectors = codeLists.find((c) => c.ref === profile.sectors)!.codes.map((c) => c.code);

  const properties: ResolvedProperty[] = profile.properties.map((p) => {
    const entry = legal.doc.entries.find((e) => e.property === p.id);
    if (!entry) throw new ProfileError(`${p.id} has no source-status label`);
    const statusText = legal.doc.statuses[entry.status];
    if (!statusText) throw new ProfileError(`${p.id}: source status ${entry.status} is not defined`);
    for (const l of p.context_labels ?? []) {
      if (!sectors.includes(l.context)) throw new ProfileError(`${p.id}: context ${l.context} is not a sector`);
    }
    return {
      id: p.id,
      definitionRef: p.definition_ref,
      definition: term(p.id, p.definition_ref),
      datatype: p.datatype ?? "string",
      labels: p.labels,
      contextLabels: p.context_labels ?? [],
      unit: p.unit,
      unitName: p.unit === null ? null : (unitName.get(p.unit) ?? null),
      requiredBy: p.required_by,
      ...(p.basis ? { basis: p.basis } : {}),
      members: p.members.map((m) => ({ id: m, definition: term(`${p.id} member`, m) })),
      legal: { status: entry.status, statusText, requirement: entry.requirement, legislation: entry.legislation },
    };
  });

  const matrixPath = "policy/actor-field-matrix.csv";
  const propertyIds = profile.properties.map((p) => p.id);
  const matrix = parseMatrix(files[matrixPath] ?? "", propertyIds);
  for (const rule of derived.doc.rules) {
    if (!propertyIds.includes(rule.property)) {
      throw new ProfileError(`${derived.file.path}: ${rule.id} names ${rule.property}, which is not a profile property`);
    }
  }
  const routes = Object.fromEntries(
    ROUTES.map((r) => {
      const doc = parseWith(RouteDoc, `routes/${r}.yaml`, files[`routes/${r}.yaml`] ?? "");
      if (doc.id !== r) throw new ProfileError(`routes/${r}.yaml: id is ${doc.id}`);
      return [
        r,
        {
          id: r,
          recipient: doc.recipient,
          ...(doc.purpose ? { purpose: doc.purpose } : {}),
          format: doc.format,
          ...(doc.target_contract ? { targetContract: doc.target_contract } : {}),
          ...(doc.mapping_contract ? { mappingContract: doc.mapping_contract } : {}),
          status: doc.status,
          output: doc.output.items,
          sections: doc.output.sections ?? [],
          ...(doc.hold_reason ? { holdReason: doc.hold_reason } : {}),
        },
      ];
    }),
  ) as Record<Route, RouteInfo>;

  const refPins: PinnedFile[] = Object.keys(files)
    .filter((p) => p.startsWith("contracts/"))
    .sort()
    .map((path) => ({ ref: path.replace(/^contracts\//, ""), path, digest: digests.get(path)! }));

  return {
    dir: source.dir,
    id: profile.id,
    version: profile.version,
    standIn: profile.stand_in,
    source: profile.source,
    release: { released: profile.release.released, releasedBy: profile.release.released_by, basis: profile.release.basis },
    productFamily: profile.product_family,
    languages: profile.languages,
    sectors,
    properties,
    codeLists,
    pins: [
      { ref: `${profile.id}@${profile.version}`, path: profilePath, digest: digests.get(profilePath)! },
      terms.file,
      legal.file,
      units.file,
      ...mappingPins,
      readiness.file,
      derived.file,
      limits.file,
      retention.file,
      exceptions.file,
      operationalLimits.file,
      ...codeLists.map(({ ref, path, digest }) => ({ ref, path, digest })),
      ...refPins,
    ],
    termCount: terms.doc.terms.length,
    legalNote: legal.doc.note,
    legalStatuses: legal.doc.statuses,
    manifestDigest: source.manifestDigest,
    fileCount: Object.keys(files).length,
    inputs: {
      erp: parseWith(ErpContractDoc, "inputs/erp-extract.csv.contract.yaml", files["inputs/erp-extract.csv.contract.yaml"] ?? ""),
      lab: parseWith(LabContractDoc, "inputs/lab-assessment.contract.yaml", files["inputs/lab-assessment.contract.yaml"] ?? ""),
    },
    routes,
    matrix,
    policy: {
      readiness: readiness.doc,
      derived: derived.doc,
      limits: limits.doc.limits,
      retention: retention.doc,
      exceptions: exceptions.doc,
    },
    operationalLimits: operationalLimits.doc,
    contracts,
  };
}

export const memberCount = (pack: ProfilePack) => new Set(pack.properties.flatMap((p) => p.members.map((m) => m.id))).size;

export function lookup(pack: ProfilePack, query: string): ResolvedProperty[] {
  const q = query.trim().toLowerCase();
  if (!q) return pack.properties;
  const exact = pack.properties.filter((p) => p.id.toLowerCase() === q);
  if (exact.length) return exact;
  return pack.properties.filter((p) =>
    [p.id, p.labels.en, p.labels.de, ...p.contextLabels.map((l) => l.text)].some((t) => t.toLowerCase().includes(q)),
  );
}

export function labelFor(property: ResolvedProperty, lang: "en" | "de", sector?: string): string {
  const specific = sector && property.contextLabels.find((l) => l.lang === lang && l.context === sector);
  return specific ? specific.text : property.labels[lang];
}
