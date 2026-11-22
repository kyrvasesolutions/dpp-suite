/**
 * Generates a release: every route's output, or the refusal that says why a route has none, and the manifest that
 * describes them (Cycle 4). Nothing here has its own rules: each builder projects through `project()`.
 */
import type { ProductRecord } from "../ingress";
import type { ProfilePack, Route } from "../profile";
import { ROUTES } from "../profile";
import type { Snapshot } from "../recordRepository";
import { buildCustomerPdf } from "./customerPdf";
import { buildErpCsv } from "./erpCsv";
import { RouteRefusedError } from "./items";
import { buildManifest, manifestFile, type ReleaseManifest, type RouteOutcome } from "./manifest";
import { buildRegistryJson } from "./registryJson";
import { softwareInfo, type SoftwareInfo } from "./software";
import type { OutputFile } from "./types";

/** `context.version` is the record version the release is made from, for outputs that state it (the PDF footer). */
export type Builder = (pack: ProfilePack, record: ProductRecord, context: { version: number }) => OutputFile | Promise<OutputFile>;

/** The builder of each route. A route without one is not part of the release. */
export const BUILDERS: Partial<Record<Route, Builder>> = {
  "customer-pdf": buildCustomerPdf,
  "erp-staging-csv": buildErpCsv,
  "registry-prep-json": buildRegistryJson,
};

export interface Release {
  outcomes: RouteOutcome[];
  files: OutputFile[];
  manifest: ReleaseManifest;
  manifestFile: Awaited<ReturnType<typeof manifestFile>>;
}

export async function generateRelease(
  pack: ProfilePack,
  snapshot: Snapshot,
  options: { software?: SoftwareInfo; builders?: Partial<Record<Route, Builder>> } = {},
): Promise<Release> {
  const builders = options.builders ?? BUILDERS;
  const record = snapshot.record;
  const outcomes: RouteOutcome[] = [];
  for (const route of ROUTES) {
    const build = builders[route];
    if (!build) continue;
    try {
      outcomes.push({ route, file: await build(pack, record, { version: snapshot.version }) });
    } catch (e) {
      if (e instanceof RouteRefusedError) outcomes.push({ route, refused: e });
      else throw e;
    }
  }
  const manifest = await buildManifest({ pack, record, snapshot, outcomes, software: options.software ?? softwareInfo() });
  return {
    outcomes,
    files: outcomes.flatMap((o) => ("file" in o ? [o.file] : [])),
    manifest,
    manifestFile: await manifestFile(manifest),
  };
}
