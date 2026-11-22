/**
 * Lineage (Cycle 4: FUNC-023 slice, criterion C4-07).
 *
 * For every value in an output: the mapping step that produced it, the derived rule if it is a statement, and the
 * source assertion behind it (the kind of file, its name and sha256, and the place in it). A derived statement
 * lists every assertion it was made from. Lineage is for the operator and for the release manifest. The recipient's
 * output keeps the public source form of Cycle 3 and never carries a file name.
 */
import { derive } from "./derived";
import type { Assertion, ProductRecord } from "./ingress";
import type { ProfilePack, Route } from "./profile";
import { detailPosition, type OutputValue } from "./outputs/items";

export interface LineageEntry {
  /** `<route>/<step ID>`: names one value of one output. */
  outputRef: string;
  stepId: string;
  ruleId?: string;
  property: string;
  member?: string;
  qualifier?: string;
  /** The part of the source object that was read, when it is not the value (a footprint's method, for example). */
  detail?: string;
  assertion: { role: Assertion["source"]["role"]; file: string; sha256: string; location: string };
  /** For a value an operator corrected: the version of the record the correction made, who made it, and the reason. */
  correction?: { version: number; actor: string; reason: string };
}

export const outputRef = (route: Route, stepId: string) => `${route}/${stepId}`;

const entryOf = (ref: string, item: OutputValue, a: Assertion, detail?: string): LineageEntry => ({
  outputRef: ref,
  stepId: item.step,
  ...(item.ruleId ? { ruleId: item.ruleId } : {}),
  property: a.property,
  ...(a.member ? { member: a.member } : {}),
  ...(a.qualifier ? { qualifier: a.qualifier } : {}),
  ...(detail ? { detail } : {}),
  ...(a.correction ? { correction: { ...a.correction } } : {}),
  // the exact place: for a detail, the key of the source object that holds it
  assertion: { role: a.source.role, file: a.source.file, sha256: a.source.sha256, location: detail ? `${a.source.file}, ${detailPosition(a.source.location.slice(a.source.file.length + 2), detail)}` : a.source.location },
});

/**
 * The lineage of every value that an output states, in output order. Throws if a stated value cannot be traced:
 * an output value without a source assertion is a defect, never a gap to be filled in quietly.
 */
export function buildLineage(pack: ProfilePack, record: ProductRecord, route: Route, items: OutputValue[]): LineageEntry[] {
  const entries: LineageEntry[] = [];
  for (const item of items) {
    if (!item.present) continue;
    const ref = outputRef(route, item.step);
    if (item.kind === "derived") {
      const result = derive(pack, record, item.property);
      if (!result.ok) throw new Error(`${ref}: the derived statement cannot be traced because the rule no longer decides: ${result.reason}`);
      for (const a of result.inputs) entries.push(entryOf(ref, item, a));
      continue;
    }
    if (!item.refs.length) throw new Error(`${ref}: a stated value has no source assertion`);
    for (const r of item.refs) {
      const value = record.values.find((v) => v.property === r.property && v.member === r.member && v.qualifier === r.qualifier);
      const a = value?.assertions[r.index];
      if (!a) throw new Error(`${ref}: ${r.property} is not in the record`);
      entries.push(entryOf(ref, item, a, r.detail));
    }
  }
  return entries;
}

/** The chain behind one output value: every source assertion, in order. */
export const trace = (lineage: LineageEntry[], ref: string): LineageEntry[] => lineage.filter((e) => e.outputRef === ref);
