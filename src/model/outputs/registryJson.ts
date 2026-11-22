/**
 * The registry preparation JSON (Cycle 4: FUNC-042 slice, criterion C4-03).
 *
 * Always a draft. It carries `"status": "HOLD"` and `"submission": "never"`, the standing hold reason of the route and
 * every other hold the record has, and it names only the fields the matrix permits for the registry. It is generated on
 * this device, offered for download and never sent anywhere: no external registry contract exists for aluminium.
 * Canonical JSON: sorted keys, two-space indentation.
 */
import { canonicalPretty, utf8 } from "../canonical";
import { buildLineage } from "../lineage";
import type { ProductRecord } from "../ingress";
import { decide } from "../policy";
import type { ProfilePack, Route } from "../profile";
import { prepare, type OutputValue } from "./items";
import { safeName, type OutputFile } from "./types";

const ROUTE: Route = "registry-prep-json";

export interface RegistryJson extends OutputFile {
  text: string;
}

const valueOf = (it: OutputValue): unknown => {
  if (!it.present) return null;
  if (it.kind === "members" || it.lines.some((l) => l.key)) return Object.fromEntries(it.lines.map((l, i) => [l.key ?? String(i), l.text]));
  return it.text;
};

/** Sets `value` at a JSON pointer such as /properties/commodity_code, creating the objects on the way. */
function setPointer(root: Record<string, unknown>, pointer: string, value: unknown) {
  const keys = pointer.split("/").slice(1);
  let node = root;
  for (const k of keys.slice(0, -1)) node = (node[k] ??= {}) as Record<string, unknown>;
  node[keys[keys.length - 1]] = value;
}

export function buildRegistryJson(pack: ProfilePack, record: ProductRecord): RegistryJson {
  const { items, holds } = prepare(pack, record, ROUTE, { allowHold: true });
  const mapping = pack.routes[ROUTE].output;
  const text_of = new Map(pack.policy.readiness.rules.map((r) => [r.id, r.text]));
  const doc: Record<string, unknown> = {
    document: "registry-preparation-draft",
    status: "HOLD",
    submission: "never",
    hold_reason: pack.routes[ROUTE].holdReason ?? text_of.get("RR-STANDING-HOLD") ?? "",
    holds: holds.map((h) => ({
      rule: h.ruleId,
      text: text_of.get(h.ruleId) ?? "",
      // only a property the registry may see is named
      ...(h.property && decide(pack, ROUTE, h.property) === "permit" ? { property: h.property, ...(h.member ? { member: h.member } : {}) } : {}),
    })),
    properties: {},
  };
  items.forEach((it, i) => setPointer(doc, mapping[i].json!.path, valueOf(it)));
  const text = canonicalPretty(doc);
  return {
    route: ROUTE,
    fileName: `${safeName("registry-draft-HOLD", record.model, record.batch)}.json`,
    mediaType: "application/json",
    bytes: utf8(text),
    text,
    status: "hold",
    holds,
    items,
    lineage: buildLineage(pack, record, ROUTE, items),
  };
}
