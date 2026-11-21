/**
 * Loads the frozen N profile from the contract pack, through its manifest digests only (Cycle 1:
 * FUNC-001, 027, 028, 029, 030, 031, 081, 091 and 025 slices; criteria C1-01 to C1-06).
 *
 * The pack is pinned: every file must match the sha256 in MANIFEST.json, every reference names an exact
 * id@version, and every definition and nested member resolves to a governed term. Any break throws a
 * ProfileError, so the app never shows a profile it could not verify. Nothing here edits the profile.
 */
import { parse } from "yaml";
import { z } from "zod";

export const ROUTES = ["customer-pdf", "erp-staging-csv", "registry-prep-json"] as const;
export type Route = (typeof ROUTES)[number];

export const ROUTE_NAMES: Record<Route, string> = {
  "customer-pdf": "Customer PDF",
  "erp-staging-csv": "ERP staging CSV",
  "registry-prep-json": "Registry preparation JSON",
};

/** The files of one contract pack, as the build embeds them (see vite.config.ts). */
export interface PackSource {
  dir: string;
  manifest: { pack: string; profile: string; files: Record<string, string> };
  /** Every file in the pack directory apart from MANIFEST.json, by path, as text. */
  files: Record<string, string>;
  /** sha256 of MANIFEST.json, the digest the owner signs. */
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
  version: z.literal("1.0.0"),
  status: z.literal("FROZEN"),
  stand_in: z.boolean(),
  source: z.string(),
  release: z.object({ released: z.string(), released_by: z.string(), basis: z.string() }),
  product_family: z.string(),
  languages: z.array(z.string()),
  sectors: pin,
  routes: z.tuple([z.literal(ROUTES[0]), z.literal(ROUTES[1]), z.literal(ROUTES[2])]),
  pins: z.object({ terms: pin, legal: pin, units: pin, code_lists: z.array(pin), inputs: z.array(pin), route_contracts: z.array(pin) }),
  properties: z.array(
    z.object({
      id: z.string().regex(/^ALU-D\d{3}$/),
      definition_ref: z.string().min(1),
      unit: z.string().nullable(),
      labels: z.object({ en: z.string().min(1), de: z.string().min(1) }),
      required_by: z.object({ "customer-pdf": z.boolean(), "erp-staging-csv": z.boolean(), "registry-prep-json": z.boolean() }),
      members: z.array(z.string()),
      context_labels: z.array(ContextLabel).optional(),
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
  labels: { en: string; de: string };
  /** Sector-specific labels: the language tag and the sector are separate fields (C1-05). */
  contextLabels: Array<{ lang: string; context: string; text: string }>;
  unit: string | null;
  unitName: string | null;
  requiredBy: Record<Route, boolean>;
  members: Array<{ id: string; definition: string }>;
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
}

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

/** Reads a code-list CSV: comment lines start with "#", then a header row, then one code per row. */
function parseCodeList(text: string) {
  const lines = text.split(/\r?\n/);
  const description = lines.find((l) => l.startsWith("#"))?.replace(/^#\s*/, "") ?? "";
  const rows = lines.filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split(",").map((c) => c.trim()));
  const [header = [], ...body] = rows;
  const mapped = header[1] === "maps_to";
  return { description, codes: body.map((r) => (mapped ? { code: r[0], mapsTo: r[1] } : { code: r[0] })) };
}

/**
 * Verifies every file of the pack against its manifest digest, then resolves the profile.
 * Throws ProfileError on a changed, missing or unlisted file, a reference that is not an exact
 * version, or a definition or member that does not resolve to a governed term.
 */
export async function loadProfilePack(source: PackSource): Promise<ProfilePack> {
  const { manifest, files } = source;
  const digests = new Map<string, string>();
  for (const path of Object.keys(files)) {
    if (!(path in manifest.files)) throw new ProfileError(`${path} is not in MANIFEST.json`);
  }
  for (const [path, expected] of Object.entries(manifest.files)) {
    const text = files[path];
    if (text === undefined) throw new ProfileError(`${path} is in MANIFEST.json but missing`);
    const actual = await sha256Hex(text);
    if (actual !== expected) throw new ProfileError(`${path} does not match its pinned digest`);
    digests.set(path, actual);
  }

  const profilePath = "profile/PROFILE-ALU-24-01@1.0.0.yaml";
  const profile = parseWith(ProfileDoc, profilePath, files[profilePath] ?? "");
  if (`${profile.id}@${profile.version}` !== manifest.profile) throw new ProfileError(`manifest pins ${manifest.profile}, profile is ${profile.id}@${profile.version}`);
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

  // Mapping contracts and routes: each file states an exact version, and the profile pins exactly these (C1-02)
  const contracts = (kind: string, prefix: string, refs: string[]): PinnedFile[] => {
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
    ...contracts("inputs", "inputs/", profile.pins.inputs),
    ...contracts("routes", "routes/", profile.pins.route_contracts),
  ];

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
      labels: p.labels,
      contextLabels: p.context_labels ?? [],
      unit: p.unit,
      unitName: p.unit === null ? null : (unitName.get(p.unit) ?? null),
      requiredBy: p.required_by,
      members: p.members.map((m) => ({ id: m, definition: term(`${p.id} member`, m) })),
      legal: { status: entry.status, statusText, requirement: entry.requirement, legislation: entry.legislation },
    };
  });

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
      ...codeLists.map(({ ref, path, digest }) => ({ ref, path, digest })),
    ],
    termCount: terms.doc.terms.length,
    legalNote: legal.doc.note,
    legalStatuses: legal.doc.statuses,
    manifestDigest: source.manifestDigest,
    fileCount: Object.keys(files).length,
  };
}

/** Distinct nested members across the profile. */
export const memberCount = (pack: ProfilePack) => new Set(pack.properties.flatMap((p) => p.members.map((m) => m.id))).size;

/**
 * Local reference lookup by stable ID or label (FUNC-081 slice): an exact ID first, then any
 * property whose ID, English, German or sector label contains the query. No semantic search.
 */
export function lookup(pack: ProfilePack, query: string): ResolvedProperty[] {
  const q = query.trim().toLowerCase();
  if (!q) return pack.properties;
  const exact = pack.properties.filter((p) => p.id.toLowerCase() === q);
  if (exact.length) return exact;
  return pack.properties.filter((p) =>
    [p.id, p.labels.en, p.labels.de, ...p.contextLabels.map((l) => l.text)].some((t) => t.toLowerCase().includes(q)),
  );
}

/** The label for a language, preferring the sector-specific one when a sector is chosen (C1-05). */
export function labelFor(property: ResolvedProperty, lang: "en" | "de", sector?: string): string {
  const specific = sector && property.contextLabels.find((l) => l.lang === lang && l.context === sector);
  return specific ? specific.text : property.labels[lang];
}
