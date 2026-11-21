/**
 * Derived disclosure (Cycle 3: FUNC-046 slice, criterion C3-05).
 *
 * Where the actor/field matrix says `derived`, a recipient never receives the value. The only output is a
 * statement from a pinned derived rule: *within* or *outside* the limits for the alloy (and temper), with the
 * basis that names the standard. The limits table in the pack is illustrative. When the limits cannot decide
 * (a challenged or missing input, an alloy or temper the table does not cover), there is no statement at all
 * and the reason says why; nothing else is derived and nothing is guessed.
 */
import { byRole, type ProductRecord, type RecordValue } from "./ingress";
import type { ProfilePack } from "./profile";

export interface DerivedStatement {
  within: boolean;
  /** The standard, the alloy and (for strength) the temper the limits were taken for, for example "EN 485-2, EN AW-5754 H111". */
  basis: string;
}

export type DerivedResult =
  | { ok: true; rule: string; statement: DerivedStatement }
  | { ok: false; rule: string; reason: string };

const within = (v: number, b: { min: number | null; max: number | null }) => (b.min === null || v >= b.min) && (b.max === null || v <= b.max);

/** The one text a record states for a property, or why there is none: a challenged or repeated value cannot be relied on. */
function onlyText(pack: ProfilePack, record: ProductRecord, role: "alloy" | "temper"): { text: string } | { problem: string } {
  const property = byRole(pack, role);
  const values = record.values.filter((v) => v.property === property && !v.member);
  if (values.length !== 1) return { problem: `${role} is ${values.length ? "stated more than once" : "missing"}` };
  if (values[0].status === "challenged") return { problem: `${role} is challenged` };
  return { text: values[0].assertions[0].raw };
}

/** The numeric readings of one property, one per element for a composition and one in all for a strength. */
const readings = (record: ProductRecord, property: string): RecordValue[] => record.values.filter((v) => v.property === property && !v.member);

/**
 * Applies the derived rule of `property` to the record. A property with no derived rule is an error:
 * the matrix only says `derived` for properties the pack gives one.
 */
export function derive(pack: ProfilePack, record: ProductRecord, property: string): DerivedResult {
  const rules = pack.policy.derived.rules.filter((r) => r.property === property);
  if (rules.length !== 1) throw new Error(`Property "${property}" has ${rules.length} derived rules, expected exactly one`);
  const rule = rules[0];
  const fail = (reason: string): DerivedResult => ({ ok: false, rule: rule.id, reason });
  const values = readings(record, property);
  if (!values.length) return fail("no value to derive from");
  if (values.some((v) => v.status === "challenged")) return fail("the value is challenged");
  const numbers = values.map((v) => ({ qualifier: v.qualifier, n: v.assertions[0].value }));
  if (numbers.some((x) => typeof x.n !== "number")) return fail("the value is not a number");

  const alloy = onlyText(pack, record, "alloy");
  if ("problem" in alloy) return fail(alloy.problem);

  if (rule.method === "limits-by-alloy-and-temper") {
    if (values.length !== 1) return fail("more than one value");
    const temper = onlyText(pack, record, "temper");
    if ("problem" in temper) return fail(temper.problem);
    const limit = pack.policy.derived.limits.tensile.entries.find((e) => e.alloy === alloy.text && e.temper === temper.text);
    if (!limit) return fail(`no limits for ${alloy.text} ${temper.text}`);
    return { ok: true, rule: rule.id, statement: { within: within(numbers[0].n as number, limit), basis: `${rule.standard}, ${alloy.text} ${temper.text}` } };
  }

  // limits-by-alloy-and-element: every element reported must have limits for this alloy
  let all = true;
  for (const x of numbers) {
    const limit = pack.policy.derived.limits.composition.entries.find((e) => e.alloy === alloy.text && e.element === x.qualifier);
    if (!limit) return fail(`no limits for ${x.qualifier ?? "an unnamed element"} in ${alloy.text}`);
    if (!within(x.n as number, limit)) all = false;
  }
  return { ok: true, rule: rule.id, statement: { within: all, basis: `${rule.standard}, ${alloy.text}` } };
}
