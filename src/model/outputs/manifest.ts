/**
 * The release manifest and its verification (Cycle 4: criterion C4-05; UC-33).
 *
 * One canonical JSON file that says exactly what a release is made of: the software (package version and commit),
 * the pinned contract pack (manifest digest and the pin of every file the outputs depend on), the input files by role
 * and sha256, the record version and digest, each output with its digest and status, and the lineage of every output
 * value. The only date and time is `generated` (when and by which role the release was made): declared generated
 * metadata, left out of every digest and of every comparison. `substantiveDigest` covers everything else, so the same
 * inputs give the same substantive content, and the same output files byte for byte, on any machine and at any time.
 * `verifyRelease` recomputes every digest of a set of downloaded files and reports each mismatch.
 */
import { z } from "zod";
import { canonical, canonicalPretty, sha256Bytes, utf8 } from "../canonical";
import type { LineageEntry } from "../lineage";
import type { ProductRecord } from "../ingress";
import type { PinnedFile, ProfilePack, Route } from "../profile";
import { ROUTES } from "../profile";
import type { HoldReason } from "../readiness";
import { parseStrictJson, toPlain } from "../strictJson";
import { RouteRefusedError } from "./items";
import type { SoftwareInfo } from "./software";
import type { OutputFile } from "./types";

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const Pin = z.object({ ref: z.string(), path: z.string(), digest: Sha });
const Hold = z.object({ rule: z.string(), property: z.string().nullable(), member: z.string().optional(), detail: z.string().optional(), field: z.string().optional(), locations: z.array(z.string()).optional() });

export const ManifestSchema = z.object({
  format: z.literal("dpp-release-manifest"),
  version: z.literal(1),
  software: z.object({ name: z.string(), version: z.string(), commit: z.string() }),
  pack: z.object({
    manifestDigest: Sha,
    pins: z.object({
      profile: z.array(Pin),
      terms: z.array(Pin),
      legal: z.array(Pin),
      units: z.array(Pin),
      codeLists: z.array(Pin),
      inputs: z.array(Pin),
      routes: z.array(Pin),
      policy: z.array(Pin),
    }),
  }),
  inputs: z.array(z.object({ role: z.enum(["erp", "lab", "correction"]), name: z.string(), sha256: Sha })),
  record: z.object({ model: z.string(), batch: z.string(), version: z.number().int().min(1), digest: Sha, snapshotDigest: Sha }),
  outputs: z.array(
    z.object({
      route: z.enum(ROUTES),
      fileName: z.string().nullable(),
      mediaType: z.string(),
      sha256: Sha.nullable(),
      status: z.enum(["ready", "hold"]),
      holds: z.array(Hold),
    }),
  ),
  lineage: z.array(
    z.object({
      outputRef: z.string(),
      stepId: z.string(),
      ruleId: z.string().optional(),
      property: z.string(),
      member: z.string().optional(),
      qualifier: z.string().optional(),
      detail: z.string().optional(),
      assertion: z.object({ role: z.enum(["erp", "lab", "correction"]), file: z.string(), sha256: Sha, location: z.string() }),
      /** For a value an operator corrected: the record version of the correction, who made it and why. */
      correction: z.object({ version: z.number().int().min(2), actor: z.string(), reason: z.string() }).optional(),
    }),
  ),
  formulaPrefixedCells: z.number().int().min(0),
  /** Declared generated metadata: when (ISO time) and by which role the release was made. Excluded from every digest. */
  generated: z.object({ at: z.iso.datetime(), by: z.string().min(1) }),
  /** sha256 of the canonical manifest without `generated` and without this field. */
  substantiveDigest: Sha,
});
export type ReleaseManifest = z.infer<typeof ManifestSchema>;

/** Everything the substantive digest covers: the manifest without the generated metadata and without the digest itself. */
export const substantiveContent = (m: ReleaseManifest | Omit<ReleaseManifest, "substantiveDigest">) => {
  const { generated: _generated, ...rest } = m as ReleaseManifest;
  const { substantiveDigest: _digest, ...content } = rest;
  return content;
};
export const substantiveDigestOf = (m: ReleaseManifest | Omit<ReleaseManifest, "substantiveDigest">) => sha256Bytes(utf8(canonical(substantiveContent(m))));

/** The manifest as compared across runs: canonical, with the generated metadata left out (the substantive digest stays in). */
export const substantiveText = (m: ReleaseManifest) => {
  const { generated: _generated, ...rest } = m;
  return canonicalPretty(rest);
};

/** What happened for one route: a file, or the refusal that says why there is none. */
export type RouteOutcome = { route: Route; file: OutputFile } | { route: Route; refused: RouteRefusedError };

const holdOf = (h: HoldReason) => ({
  rule: h.ruleId,
  property: h.property,
  ...(h.member ? { member: h.member } : {}),
  ...(h.detail ? { detail: h.detail } : {}),
  ...(h.field ? { field: h.field } : {}),
  ...(h.sources.length ? { locations: h.sources.map((x) => x.location) } : {}),
});

const pinsOf = (pack: ProfilePack, prefix: string): PinnedFile[] => pack.pins.filter((p) => p.path.startsWith(prefix)).map(({ ref, path, digest }) => ({ ref, path, digest }));

export interface ReleaseInput {
  pack: ProfilePack;
  record: ProductRecord;
  /** The snapshot the release is made from. */
  snapshot: { version: number; digest: string };
  outcomes: RouteOutcome[];
  software: SoftwareInfo;
  /** When and by which role the release is made; the manifest declares it as generated metadata. */
  generated: { at: string; by: string };
  formulaPrefixedCells?: number;
}

/** The manifest of a release, as an object, in the order of the routes. */
export async function buildManifest(input: ReleaseInput): Promise<ReleaseManifest> {
  const { pack, record, snapshot, software } = input;
  const outcomes = [...input.outcomes].sort((a, b) => ROUTES.indexOf(a.route) - ROUTES.indexOf(b.route));
  const outputs: ReleaseManifest["outputs"] = [];
  const lineage: LineageEntry[] = [];
  for (const o of outcomes) {
    const info = pack.routes[o.route];
    if ("file" in o) {
      outputs.push({ route: o.route, fileName: o.file.fileName, mediaType: o.file.mediaType, sha256: await sha256Bytes(o.file.bytes), status: o.file.status, holds: o.file.holds.map(holdOf) });
      lineage.push(...o.file.lineage);
    } else outputs.push({ route: o.route, fileName: null, mediaType: info.format, sha256: null, status: "hold", holds: o.refused.holds.map(holdOf) });
  }
  const body: Omit<ReleaseManifest, "substantiveDigest"> = {
    format: "dpp-release-manifest",
    version: 1,
    software,
    pack: {
      manifestDigest: pack.manifestDigest,
      pins: {
        profile: pinsOf(pack, "profile/"),
        terms: pinsOf(pack, "terms/"),
        legal: pinsOf(pack, "legal/"),
        units: pinsOf(pack, "units/"),
        codeLists: pinsOf(pack, "code-lists/"),
        inputs: pinsOf(pack, "inputs/"),
        routes: pinsOf(pack, "routes/"),
        policy: pinsOf(pack, "policy/"),
      },
    },
    inputs: record.sources.map((s) => ({ role: s.role, name: s.name, sha256: s.sha256 })),
    record: { model: record.model, batch: record.batch, version: snapshot.version, digest: record.digest, snapshotDigest: snapshot.digest },
    outputs,
    lineage: lineage.map((e) => ({ ...e })),
    formulaPrefixedCells: input.formulaPrefixedCells ?? outcomes.reduce((n, o) => n + ("file" in o ? (o.file.formulaPrefixedCells ?? 0) : 0), 0),
    generated: input.generated,
  };
  return ManifestSchema.parse({ ...body, substantiveDigest: await substantiveDigestOf(body) });
}

/** The manifest file: canonical JSON, with its own digest. */
export async function manifestFile(
  manifest: ReleaseManifest,
): Promise<{ fileName: string; mediaType: string; text: string; bytes: Uint8Array; sha256: string; substantiveDigest: string; substantiveText: string }> {
  const text = canonicalPretty(manifest);
  const bytes = utf8(text);
  return {
    fileName: "release-manifest.json",
    mediaType: "application/json",
    text,
    bytes,
    // the file's own sha256 includes the time it was made; the substantive digest does not
    sha256: await sha256Bytes(bytes),
    substantiveDigest: manifest.substantiveDigest,
    substantiveText: substantiveText(manifest),
  };
}

export type CheckStatus = "match" | "mismatch" | "missing" | "unlisted" | "not-supplied";

export interface VerifyCheck {
  kind: "manifest" | "output" | "input" | "pack" | "lineage";
  name: string;
  status: CheckStatus;
  expected?: string;
  actual?: string;
}

export interface VerifyResult {
  /** True only when nothing mismatched, is missing or is unlisted. An input that was not supplied is not an error. */
  ok: boolean;
  checks: VerifyCheck[];
}

export interface SuppliedFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Recomputes the digest of every supplied file against the manifest. Outputs must all be present and equal; inputs are
 * checked when supplied; extra files are reported as unlisted. With `pack`, its manifest digest and every pin must match.
 * A manifest that cannot be read, or breaks the schema, gives one failed check and nothing else.
 */
export async function verifyRelease(manifestBytes: Uint8Array, files: SuppliedFile[], pack?: ProfilePack): Promise<VerifyResult> {
  const checks: VerifyCheck[] = [];
  let manifest: ReleaseManifest;
  try {
    manifest = ManifestSchema.parse(toPlain(parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes))));
  } catch (e) {
    return { ok: false, checks: [{ kind: "manifest", name: "release-manifest.json", status: "mismatch", actual: `not a valid release manifest: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` }] };
  }
  // the substantive digest covers everything but the generated metadata, so a changed manifest cannot pass as the original
  const recomputed = await substantiveDigestOf(manifest);
  checks.push({ kind: "manifest", name: "substantive content", status: recomputed === manifest.substantiveDigest ? "match" : "mismatch", expected: manifest.substantiveDigest, actual: recomputed });
  const byName = new Map(files.map((f) => [f.name, f]));
  const listed = new Set<string>();
  for (const o of manifest.outputs) {
    if (o.fileName === null || o.sha256 === null) continue;
    listed.add(o.fileName);
    const f = byName.get(o.fileName);
    if (!f) {
      checks.push({ kind: "output", name: o.fileName, status: "missing", expected: o.sha256 });
      continue;
    }
    const actual = await sha256Bytes(f.bytes);
    checks.push({ kind: "output", name: o.fileName, status: actual === o.sha256 ? "match" : "mismatch", expected: o.sha256, actual });
  }
  for (const i of manifest.inputs) {
    listed.add(i.name);
    const f = byName.get(i.name);
    if (!f) {
      checks.push({ kind: "input", name: i.name, status: "not-supplied", expected: i.sha256 });
      continue;
    }
    const actual = await sha256Bytes(f.bytes);
    checks.push({ kind: "input", name: i.name, status: actual === i.sha256 ? "match" : "mismatch", expected: i.sha256, actual });
  }
  for (const f of files) if (!listed.has(f.name) && f.name !== "release-manifest.json") checks.push({ kind: "output", name: f.name, status: "unlisted" });
  // every lineage assertion rests on an input the manifest lists
  const inputDigests = new Set(manifest.inputs.map((i) => i.sha256));
  const stray = manifest.lineage.filter((e) => !inputDigests.has(e.assertion.sha256));
  checks.push({ kind: "lineage", name: `${manifest.lineage.length} lineage entries`, status: stray.length ? "mismatch" : "match", ...(stray.length ? { actual: `${stray.length} cite a file the manifest does not list` } : {}) });
  if (pack) {
    checks.push({ kind: "pack", name: "contract pack manifest", status: pack.manifestDigest === manifest.pack.manifestDigest ? "match" : "mismatch", expected: manifest.pack.manifestDigest, actual: pack.manifestDigest });
    const wanted = Object.values(manifest.pack.pins).flat();
    for (const p of wanted) {
      const have = pack.pins.find((x) => x.path === p.path);
      checks.push({ kind: "pack", name: p.path, status: have?.digest === p.digest ? "match" : have ? "mismatch" : "missing", expected: p.digest, ...(have ? { actual: have.digest } : {}) });
    }
  }
  return { ok: checks.every((c) => c.status === "match" || c.status === "not-supplied"), checks };
}
