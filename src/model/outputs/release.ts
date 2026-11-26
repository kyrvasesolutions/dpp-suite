/**
 * Generates a release: every route's output, or the refusal that says why a route has none, and the manifest that
 * describes them (Cycle 4). Nothing here has its own rules: each builder projects through `project()`.
 */
import { buildOperationContextForRecord, type OperationContext } from "../context";
import type { ProductRecord } from "../ingress";
import type { ProfilePack, Route } from "../profile";
import { ROUTES } from "../profile";
import { OPERATOR, type Snapshot } from "../recordRepository";
import { buildCustomerPdf } from "./customerPdf";
import { buildErpCsv } from "./erpCsv";
import { RouteRefusedError } from "./items";
import { buildManifest, manifestFile, type ReleaseManifest, type RouteOutcome } from "./manifest";
import { buildRegistryJson } from "./registryJson";
import { softwareInfo, type SoftwareInfo } from "./software";
import type { OutputFile } from "./types";

/** `context.version` is the record version the release is made from, for outputs that state it (the PDF footer). */
export type Builder = (
  pack: ProfilePack,
  record: ProductRecord,
  context: { version: number; operationContext?: OperationContext },
) => OutputFile | Promise<OutputFile>;

/** The builder of each route. A route without one is not part of the release. */
export const BUILDERS: Partial<Record<Route, Builder>> = {
  customer: buildCustomerPdf,
  internal: (pack, record, ctx) => buildErpCsv(pack, record, ctx.operationContext),
  registry: (pack, record, ctx) => buildRegistryJson(pack, record, ctx.operationContext),
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
  options: {
    software?: SoftwareInfo;
    builders?: Partial<Record<Route, Builder>>;
    now?: () => Date;
    by?: string;
    operationContexts?: Partial<Record<Route, OperationContext>>;
  } = {},
): Promise<Release> {
  const builders = options.builders ?? BUILDERS;
  const record = snapshot.record;
  const outcomes: RouteOutcome[] = [];
  for (const route of ROUTES) {
    const build = builders[route];
    if (!build) continue;
    const opCtx = options.operationContexts?.[route] ?? buildOperationContextForRecord(pack, route, record, { roleId: options.by ?? OPERATOR });
    try {
      outcomes.push({ route, file: await build(pack, record, { version: snapshot.version, operationContext: opCtx }) });
    } catch (e) {
      if (e instanceof RouteRefusedError) outcomes.push({ route, refused: e });
      else throw e;
    }
  }
  const manifest = await buildManifest({
    pack,
    record,
    snapshot,
    outcomes,
    software: options.software ?? softwareInfo(),
    // declared generated metadata: the time and the role, left out of every digest and comparison
    generated: { at: (options.now ?? (() => new Date()))().toISOString(), by: options.by ?? OPERATOR },
  });
  return {
    outcomes,
    files: outcomes.flatMap((o) => ("file" in o ? [o.file] : [])),
    manifest,
    manifestFile: await manifestFile(manifest),
  };
}
