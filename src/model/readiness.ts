/**
 * Route readiness (Cycle 3: FUNC-002, 012 and 126 slices; criteria C3-02, C3-03, C3-04, C3-06).
 *
 * For one product record, every route gets a verdict: `ready` or `on-hold`. Each property the route requires is in
 * exactly one of four states (present, missing, inaccessible to this recipient, challenged), and every hold names a
 * rule of the pinned READINESS-RULES file, the property, and the source assertions behind it. Missing data and the
 * standing hold of the registry route are the only holds that have no source assertion to point to.
 *
 * `assess` is pure: the same record and pack always give the same result. It reports selected structural, completeness
 * and route checks. It never says that a record or a product is conformant or compliant.
 */
import { byRole, type Assertion, type Flag, type ProductRecord, type RecordValue } from "./ingress";
import { derive } from "./derived";
import { decide } from "./policy";
import { ROUTES, type ProfilePack, type Route } from "./profile";

export type PropertyState = "present" | "missing" | "inaccessible" | "challenged";

export interface RequiredProperty {
  property: string;
  state: PropertyState;
  /** False when the value is missing, inaccessible, challenged, or carries a flag that makes it insufficiently assured. */
  assured: boolean;
  /** The flags behind the state, from the source assertions. Empty for an inaccessible property: nothing about it is shown. */
  flags: Flag[];
}

export interface HoldReason {
  ruleId: string;
  /** The property that causes the hold; null only for the standing hold of the route itself. */
  property: string | null;
  member?: string;
  /** Further fact the rule names, for a hold made at output time (the code point for RR-PDF-CHARACTER). */
  detail?: string;
  /** Where the assertions behind the hold are. Empty only for RR-MISSING and RR-STANDING-HOLD. */
  sources: Assertion["source"][];
}

export interface FootprintSelection {
  /** `selected`: exactly one footprint result. `several`: more than one and no rule to select one, so none is selected. */
  state: "none" | "selected" | "several";
  candidates: Array<{ qualifier?: string; source: Assertion["source"] }>;
  selected?: { qualifier?: string; source: Assertion["source"] };
}

export interface RouteReadiness {
  route: Route;
  recipient: string;
  status: "ready" | "on-hold";
  required: RequiredProperty[];
  holds: HoldReason[];
  footprint: FootprintSelection;
}

export interface StructuralCheck {
  id: string;
  text: string;
  passed: boolean;
  detail?: string;
}

export interface AssessOptions {
  /**
   * Extra properties a route requires, for a route variant such as the prohibited-disclosure failure fixture. They
   * add to what the profile requires; they never remove anything.
   */
  requires?: Partial<Record<Route, string[]>>;
}

const sourceOf = (a: Assertion) => a.source;
const unique = <T>(xs: T[]) => [...new Set(xs)];
const keyOf = (s: Assertion["source"]) => `${s.file}|${s.location}`;

/** Exactly one footprint result is selected; several results with no selection rule select none (FUNC-126 slice). */
export function selectFootprint(pack: ProfilePack, record: ProductRecord): FootprintSelection {
  const property = byRole(pack, "footprint");
  const candidates = record.values
    .filter((v) => v.property === property && !v.member)
    .flatMap((v) => v.assertions.map((a) => ({ ...(v.qualifier ? { qualifier: v.qualifier } : {}), source: sourceOf(a) })));
  if (candidates.length === 0) return { state: "none", candidates };
  if (candidates.length === 1) return { state: "selected", candidates, selected: candidates[0] };
  return { state: "several", candidates };
}

/** The text of a rule or check in the pack; an ID the pack does not have is an error, never a blank. */
export function ruleText(pack: ProfilePack, id: string): string {
  const found = [...pack.policy.readiness.rules, ...pack.policy.readiness.checks].find((r) => r.id === id);
  if (!found) throw new Error(`The readiness rules have no ${id}`);
  return found.text;
}

/** Structural checks on the record (FUNC-002 slice). Each is listed with its outcome; none is a conformity claim. */
export function structuralChecks(pack: ProfilePack, record: ProductRecord): StructuralCheck[] {
  const identifier = (id: string, role: "model" | "batch"): StructuralCheck => {
    const property = byRole(pack, role);
    const mapped = unique(pack.inputs.erp.columns.filter((c) => c.maps_to.startsWith(`${property}/`)).map((c) => c.maps_to.split("/")[1]));
    const have = new Set(record.values.filter((v) => v.property === property && v.member).map((v) => v.member));
    const missing = mapped.filter((m) => !have.has(m));
    const none = !record.values.some((v) => v.property === property);
    return {
      id,
      text: ruleText(pack, id),
      passed: !none && missing.length === 0,
      ...(none ? { detail: "no value" } : missing.length ? { detail: `missing: ${missing.join(", ")}` } : {}),
    };
  };
  const known = new Map(pack.properties.map((p) => [p.id, new Set(p.members.map((m) => m.id))]));
  const unknown = record.values.filter((v) => !known.has(v.property) || (v.member !== undefined && !known.get(v.property)!.has(v.member)));
  return [
    identifier("CK-MODEL-IDENTIFIER", "model"),
    identifier("CK-BATCH-IDENTIFIER", "batch"),
    {
      id: "CK-KNOWN-PROPERTIES",
      text: ruleText(pack, "CK-KNOWN-PROPERTIES"),
      passed: unknown.length === 0,
      ...(unknown.length ? { detail: `not in the profile: ${unique(unknown.map((v) => (v.member ? `${v.property}/${v.member}` : v.property))).join(", ")}` } : {}),
    },
  ];
}

/** One verdict per route for one product record (FUNC-012 slice). Pure and deterministic. */
export function assess(pack: ProfilePack, record: ProductRecord, options: AssessOptions = {}): RouteReadiness[] {
  const footprintProperty = byRole(pack, "footprint");
  const evidenceProperty = byRole(pack, "evidence");
  const footprint = selectFootprint(pack, record);
  const valuesOf = (property: string): RecordValue[] => record.values.filter((v) => v.property === property);
  const evidenceById = new Map(
    valuesOf(evidenceProperty)
      .filter((v) => v.qualifier !== undefined && !v.member)
      .map((v) => [v.qualifier!, v] as const),
  );

  return ROUTES.map((route) => {
    const info = pack.routes[route];
    const requiredIds = pack.properties
      .filter((p) => p.requiredBy[route] || (options.requires?.[route] ?? []).includes(p.id))
      .map((p) => p.id);
    const holds: HoldReason[] = [];
    const add = (ruleId: string, property: string | null, member: string | undefined, sources: Assertion["source"][]) => {
      const merged = holds.find((h) => h.ruleId === ruleId && h.property === property && h.member === member);
      if (!merged) {
        holds.push({ ruleId, property, ...(member ? { member } : {}), sources: [...sources] });
        return;
      }
      for (const s of sources) if (!merged.sources.some((x) => keyOf(x) === keyOf(s))) merged.sources.push(s);
    };
    if (info.status === "HOLD") add("RR-STANDING-HOLD", null, undefined, []);

    const required: RequiredProperty[] = requiredIds.map((property) => {
      const values = valuesOf(property);
      const access = decide(pack, route, property);
      if (access === "deny") {
        // The recipient may not see it: the route holds, and only locations of the assertions are named, never a value.
        // With no assertion there is no source to name; the hold is then both inaccessible and missing, so that the
        // operator learns that supplying the value is not enough.
        add("RR-INACCESSIBLE", property, undefined, values.flatMap((v) => v.assertions.map(sourceOf)));
        if (!values.length) add("RR-MISSING", property, undefined, []);
        return { property, state: "inaccessible", assured: false, flags: [] };
      }
      if (!values.length) {
        add("RR-MISSING", property, undefined, []);
        return { property, state: "missing", assured: false, flags: [] };
      }
      let assured = true;
      for (const v of values) {
        const sources = v.assertions.map(sourceOf);
        if (v.status === "challenged") {
          add("RR-CHALLENGED", property, v.member, sources);
          assured = false;
        }
        const flagged = (flag: Flag) => v.assertions.filter((a) => a.flags.includes(flag)).map(sourceOf);
        for (const [flag, rule] of [["unknown-code", "RR-UNKNOWN-CODE"], ["draft-text", "RR-DRAFT-TEXT"]] as const) {
          const at = flagged(flag);
          if (at.length) {
            add(rule, property, v.member, at);
            assured = false;
          }
        }
        // A value that rests on an evidence record without its digest is insufficiently assured, and so is the record itself.
        const missingDigest = flagged("evidence-digest-missing");
        if (missingDigest.length) {
          add("RR-EVIDENCE-DIGEST", property, v.member, missingDigest);
          assured = false;
        }
        for (const a of v.assertions) {
          const evidence = a.details?.evidence_id ? evidenceById.get(a.details.evidence_id) : undefined;
          const bare = evidence?.assertions.filter((e) => e.flags.includes("evidence-digest-missing")) ?? [];
          if (bare.length) {
            add("RR-EVIDENCE-DIGEST", property, v.member, [sourceOf(a), ...bare.map(sourceOf)]);
            assured = false;
          }
        }
      }
      if (property === footprintProperty && footprint.state === "several") {
        add("RR-SEVERAL-RESULTS", property, undefined, footprint.candidates.map((c) => c.source));
        assured = false;
      }
      const challenged = values.some((v) => v.status === "challenged");
      if (access === "derived" && !challenged) {
        const result = derive(pack, record, property);
        if (!result.ok) {
          add("RR-DERIVED-UNDETERMINABLE", property, undefined, values.flatMap((v) => v.assertions.map(sourceOf)));
          assured = false;
        }
      }
      return {
        property,
        state: challenged ? "challenged" : "present",
        assured,
        flags: unique(values.flatMap((v) => v.assertions.flatMap((a) => a.flags))).sort(),
      };
    });

    return { route, recipient: info.recipient, status: holds.length ? "on-hold" : "ready", required, holds, footprint };
  });
}
