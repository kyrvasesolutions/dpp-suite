/**
 * Registry preparation file (JSON) — distinct `RegistryRequest` exchange type (Cycle 4: FUNC-042;
 * aligned in Cycle 9 to S5-EXCHANGE-rev2 / TARGET-EU-REGISTRY-PREPARATION-01, C9-04).
 *
 * Always HOLD with code `TARGET_PROFILE_UNCONFIRMED`, `submission: "never"`, and
 * `not_a_registration_request: true`. Never accepted as a DPPPayload by shape guessing.
 */
import { canonicalPretty, utf8 } from "../canonical";
import { buildLineage } from "../lineage";
import type { OperationContext } from "../context";
import type { ProductRecord } from "../ingress";
import { decide } from "../policy";
import type { ProfilePack, Route } from "../profile";
import { prepare, type OutputValue } from "./items";
import { safeName, type OutputFile } from "./types";

const ROUTE: Route = "registry";

export interface RegistryJson extends OutputFile {
  text: string;
  exchangeType: "RegistryRequest";
}

const valueOf = (it: OutputValue): unknown => {
  if (!it.present) return null;
  if (it.kind === "members" || it.lines.some((l) => l.key)) return Object.fromEntries(it.lines.map((l, i) => [l.key ?? String(i), l.text]));
  return it.text;
};

function setPointer(root: Record<string, unknown>, pointer: string, value: unknown) {
  const keys = pointer.split("/").slice(1);
  let node = root;
  for (const k of keys.slice(0, -1)) node = (node[k] ??= {}) as Record<string, unknown>;
  node[keys[keys.length - 1]!] = value;
}

export function buildRegistryJson(pack: ProfilePack, record: ProductRecord, context?: OperationContext): RegistryJson {
  const { projection, items, holds } = prepare(pack, record, ROUTE, { allowHold: true, ...(context ? { context } : {}) });
  const mapping = pack.routes[ROUTE].output;
  const textOf = new Map(pack.policy.readiness.rules.map((r) => [r.id, r.text]));
  const reqEnv = projection.registryRequest;
  const baseHost = String(pack.contracts.contextLd["@context"]["@base"] ?? "https://standin.example/demo/").replace(/\/demo\/?$/, "");

  const doc: Record<string, unknown> = {
    exchange_type: "RegistryRequest",
    document: "registry-preparation-draft",
    status: "HOLD",
    code: "TARGET_PROFILE_UNCONFIRMED",
    synthetic: true,
    submission: "never",
    not_a_registration_request: true,
    message: reqEnv?.message ?? "Aluminium registration profile is absent or unconfirmed for the pinned interface. No request was sent.",
    hold_reason: pack.routes[ROUTE].holdReason ?? textOf.get("RR-STANDING-HOLD") ?? "",
    semantic_core_metadata_preview: reqEnv?.semantic_core_metadata_preview ?? {
      digitalProductPassportId: `${baseHost}/demo/dpp/${record.model}`,
      uniqueProductIdentifier: `${baseHost}/demo/${record.model}`,
      granularity: "https://repository.product-passport.ec.europa.eu/core/vocabs/granularity-level#model",
      dppStatus: null,
      lastUpdate: "2026-10-31T00:00:00Z",
      contentSpecificationIds: [`${baseHost}/profile/aluminium-demo/1.0.0`],
    },
    limitations: reqEnv?.limitations ?? [
      "Illustrative semantic-core metadata only; not asserted to conform to the complete official semantic core.",
      "No confirmed aluminium registration contract; a semantic-core validation cannot establish registration-request support.",
      "Status remains unset; no official verification, registration or publication is asserted.",
    ],
    holds: holds.map((h) => ({
      rule: h.ruleId,
      text: textOf.get(h.ruleId) ?? "",
      ...(h.property && decide(pack, ROUTE, h.property) === "permit" ? { property: h.property, ...(h.member ? { member: h.member } : {}) } : {}),
    })),
    properties: {},
  };
  items.forEach((it, i) => setPointer(doc, mapping[i]!.json!.path, valueOf(it)));
  const text = canonicalPretty(doc);
  return {
    route: ROUTE,
    exchangeType: "RegistryRequest",
    fileName: `${safeName("registry-draft-HOLD", record.model, record.batch)}.json`,
    mediaType: "application/json",
    bytes: utf8(text),
    text,
    status: "HOLD",
    holds,
    items,
    lineage: buildLineage(pack, record, ROUTE, items),
  };
}
