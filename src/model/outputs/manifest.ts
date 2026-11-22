/**
 * The release manifest and its verification (Cycle 4: criterion C4-05; UC-33).
 *
 * One canonical JSON file that says exactly what a release is made of: the software (package version and commit),
 * the pinned contract pack (manifest digest and the pin of every file the outputs depend on), the input files by role
 * and sha256, the record version and digest, each output with its digest and status, and the lineage of every output
 * value. There is no date or time in it: digests and numbered versions identify the content, so the same inputs give
 * the same manifest on any machine. `verifyRelease` recomputes every digest of a set of downloaded files and reports
 * each mismatch.
 */
import { z } from "zod";
import { canonicalPretty, sha256Bytes, utf8 } from "../canonical";
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
const Hold = z.object({ rule: z.string(), property: z.string().nullable(), member: z.string().optional() });

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
  inputs: z.array(z.object({ role: z.enum(["erp", "lab"]), name: z.string(), sha256: Sha })),
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
      assertion: z.object({ role: z.enum(["erp", "lab"]), file: z.string(), sha256: Sha, location: z.string() }),
    }),
  ),
  formulaPrefixedCells: z.number().int().min(0),
});
export type ReleaseManifest = z.infer<typeof ManifestSchema>;

/** What happened for one route: a file, or the refusal that says why there is none. */
export type RouteOutcome = { route: Route; file: OutputFile } | { route: Route; refused: RouteRefusedError };

const holdOf = (h: HoldReason) => ({ rule: h.ruleId, property: h.property, ...(h.member ? { member: h.member } : {}) });

const pinsOf = (pack: ProfilePack, prefix: string): PinnedFile[] => pack.pins.filter((p) => p.path.startsWith(prefix)).map(({ ref, path, digest }) => ({ ref, path, digest }));

export interface ReleaseInput {
  pack: ProfilePack;
  record: ProductRecord;
  /** The snapshot the release is made from. */
  snapshot: { version: number; digest: string };
  outcomes: RouteOutcome[];
  software: SoftwareInfo;
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
  const manifest: ReleaseManifest = {
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
  };
  return ManifestSchema.parse(manifest);
}

/** The manifest file: canonical JSON, with its own digest. */
export async function manifestFile(manifest: ReleaseManifest): Promise<{ fileName: string; mediaType: string; text: string; bytes: Uint8Array; sha256: string }> {
  const text = canonicalPretty(manifest);
  const bytes = utf8(text);
  return { fileName: "release-manifest.json", mediaType: "application/json", text, bytes, sha256: await sha256Bytes(bytes) };
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
