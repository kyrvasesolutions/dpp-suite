/**
 * Disclosure and projection (Cycle 3: FUNC-046 slice, criterion C3-05).
 *
 * `project` is the only way a record value can reach a route output or a recipient view. For every property it
 * first asks `decide` (policy.ts) what the recipient of the route may see, and only then copies anything:
 *   permit   the value as the sources state it, with where it came from;
 *   deny     nothing; the property is listed as withheld, with the reason and never with a value;
 *   derived  only the statement of its derived rule (within or outside the limits), never the value, its
 *            uncertainty or its method.
 * A route that is on hold still gets a projection, for the readiness view, but marked `onHold`: outputs of a
 * later cycle must refuse it. A value whose property the profile does not know is withheld, never copied.
 */
import { derive, publicSource, type DerivedStatement, type PublicSource } from "./derived";
import { byRole, type Assertion, type Flag, type ProductRecord, type ValueStatus } from "./ingress";
import { decide } from "./policy";
import type { ProfilePack, Route } from "./profile";
import { assess } from "./readiness";

export interface ProjectedAssertion {
  raw: string;
  value: string | number | null;
  unit: string | null;
  details?: Record<string, string>;
  /** Where the value is stated: the kind of file and the position in it, never the uploaded file's name. */
  source: PublicSource;
  flags: Flag[];
}

export interface ProjectedValue {
  property: string;
  member?: string;
  qualifier?: string;
  status: ValueStatus;
  assertions: ProjectedAssertion[];
}

export interface DerivedDisclosure extends DerivedStatement {
  property: string;
  rule: string;
  /** Where the inputs of the statement are (kind of file and position only, never their values or the file name). */
  sources: PublicSource[];
}

export interface Withheld {
  property: string;
  decision: "deny" | "derived";
  /** The derived rule that could not decide, for a `derived` property. */
  rule?: string;
  reason: string;
}

export interface Projection {
  route: Route;
  recipient: string;
  onHold: boolean;
  values: ProjectedValue[];
  derived: DerivedDisclosure[];
  withheld: Withheld[];
}

/**
 * Copies what an assertion states. The evidence record a value rests on is itself a value of the evidence property, so
 * its identifier is copied only where that property is permitted: otherwise a permitted value would carry a denied one.
 */
const copy = (a: Assertion, evidenceVisible: boolean): ProjectedAssertion => ({
  raw: a.raw,
  value: a.value,
  unit: a.unit,
  ...(a.details
    ? { details: Object.fromEntries(Object.entries(a.details).filter(([k]) => evidenceVisible || k !== "evidence_id")) }
    : {}),
  source: publicSource(a.source),
  flags: [...a.flags],
});

/** What a recipient of `route` receives from `record`: the single path from record to route output or view. */
export function project(pack: ProfilePack, record: ProductRecord, route: Route): Projection {
  const info = pack.routes[route];
  const values: ProjectedValue[] = [];
  const derived: DerivedDisclosure[] = [];
  const withheld: Withheld[] = [];
  const known = new Set(pack.properties.map((p) => p.id));
  const evidenceVisible = decide(pack, route, byRole(pack, "evidence")) === "permit";

  for (const p of pack.properties) {
    const own = record.values.filter((v) => v.property === p.id);
    const access = decide(pack, route, p.id);
    if (access === "deny") {
      withheld.push({ property: p.id, decision: "deny", reason: "The matrix does not permit this property for this recipient." });
    } else if (access === "derived") {
      if (!own.length) continue;
      const result = derive(pack, record, p.id);
      if (result.ok) derived.push({ property: p.id, rule: result.rule, ...result.statement, sources: result.sources });
      else withheld.push({ property: p.id, decision: "derived", rule: result.rule, reason: `Only a derived statement is permitted, and it cannot be made: ${result.reason}.` });
    } else {
      for (const v of own) {
        // Members follow their property
        decide(pack, route, v.member ? `${p.id}/${v.member}` : p.id);
        values.push({
          property: v.property,
          ...(v.member ? { member: v.member } : {}),
          ...(v.qualifier ? { qualifier: v.qualifier } : {}),
          status: v.status,
          // after an operator correction the recipient's view rests on the correction alone; the earlier values stay in the record
          assertions: (v.status === "corrected" ? v.assertions.slice(0, 1) : v.assertions).map((a) => copy(a, evidenceVisible)),
        });
      }
    }
  }
  for (const unknown of new Set(record.values.filter((v) => !known.has(v.property)).map((v) => v.property))) {
    withheld.push({ property: unknown, decision: "deny", reason: "The property is not in the profile, so nothing about it can be disclosed." });
  }

  const onHold = assess(pack, record).find((r) => r.route === route)!.status === "on-hold";
  return { route, recipient: info.recipient, onHold, values, derived, withheld };
}
