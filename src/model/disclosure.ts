/**
 * Disclosure and projection (Cycle 3: FUNC-046 slice; aligned in Cycle 9 to PROFILE-ALU-24-01,
 * TARGET-CUSTOMER-JSON-01 leaf-allowlisted projection, safe HOLD envelope, and RegistryRequest).
 *
 * `project` is the ONLY path from a ProductRecord to any route output or recipient view.
 */
import type { OperationContext } from "./context";
import { derive, publicSource, type DerivedStatement, type PublicSource } from "./derived";
import { byRole, type Assertion, type Flag, type ProductRecord, type ValueStatus } from "./ingress";
import { decide } from "./policy";
import type { ProfilePack, Route } from "./profile";
import { assess, type RouteReadiness, type RouteStatus } from "./readiness";
import {
  exportReferenceRoute,
  safeHoldEnvelope,
  type CustomerProjectionPayload,
  type RegistryRequestEnvelope,
  type SafeHoldEnvelope,
} from "./referencePipeline";

export interface ProjectedAssertion {
  raw: string;
  value: string | number | null;
  unit: string | null;
  details?: Record<string, string>;
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
  sources: PublicSource[];
}

export interface Withheld {
  property: string;
  decision: "deny" | "derived";
  rule?: string;
  reason: string;
}

export interface Projection {
  route: Route;
  recipient: string;
  status: RouteStatus;
  onHold: boolean;
  language: "en" | "de";
  values: ProjectedValue[];
  derived: DerivedDisclosure[];
  withheld: Withheld[];
  /** Leaf-allowlisted TARGET-CUSTOMER-JSON-01 payload when route === "customer" and RELEASED (C9-03, C9-06). */
  customerPayload?: CustomerProjectionPayload;
  /** Generic safe public HOLD envelope when onHold === true (REF-05..13, REF-18, REF-28). */
  safeHold?: SafeHoldEnvelope;
  /** Distinct RegistryRequest envelope when route === "registry" (always HOLD: TARGET_PROFILE_UNCONFIRMED). */
  registryRequest?: RegistryRequestEnvelope;
}

const NOMINAL_DIM_ROLES = ["nominalThickness", "nominalWidth", "nominalLength"] as const;

const copy = (a: Assertion, evidenceVisible: boolean, convertMmToM: boolean): ProjectedAssertion => {
  let value = a.value;
  let raw = a.raw;
  let unit = a.unit;
  if (convertMmToM && unit === "mm" && typeof value === "number") {
    value = value / 1000;
    raw = String(value);
    unit = "m";
  }
  return {
    raw,
    value,
    unit,
    ...(a.details
      ? {
          details: Object.fromEntries(
            Object.entries(a.details).filter(([k]) => evidenceVisible || (k !== "evidence_id" && k !== "evidence_refs")),
          ),
        }
      : {}),
    source: publicSource(a.source),
    flags: [...a.flags],
  };
};

export interface ProjectOptions {
  language?: "en" | "de";
  context?: OperationContext;
}

/** Single path from record to route output or recipient view. */
export function project(
  pack: ProfilePack,
  record: ProductRecord,
  route: Route,
  routeReadiness?: RouteReadiness,
  options: ProjectOptions = {},
): Projection {
  const info = pack.routes[route];
  const lang: "en" | "de" = options.language ?? (pack.contracts.profilePolicy.customer.language === "de" ? "de" : "en");
  const values: ProjectedValue[] = [];
  const derived: DerivedDisclosure[] = [];
  const withheld: Withheld[] = [];
  const known = new Set(pack.properties.map((p) => p.id));
  const evidenceVisible = decide(pack, route, byRole(pack, "evidence")) === "permit";
  const nominalDimProps = new Set(NOMINAL_DIM_ROLES.map((r) => byRole(pack, r)));
  const narrativeProp = byRole(pack, "narrative");

  const byProp = new Map<string, ProductRecord["values"]>();
  const unknownProps = new Set<string>();
  for (const v of record.values) {
    if (!known.has(v.property)) {
      unknownProps.add(v.property);
      continue;
    }
    let bucket = byProp.get(v.property);
    if (!bucket) {
      bucket = [];
      byProp.set(v.property, bucket);
    }
    bucket.push(v);
  }

  for (const p of pack.properties) {
    const own = byProp.get(p.id) ?? [];
    const access = decide(pack, route, p.id);
    if (access === "deny") {
      withheld.push({ property: p.id, decision: "deny", reason: "The disclosure matrix does not permit raw disclosure of this property for this recipient." });
    } else if (access === "derived") {
      if (!own.length) continue;
      const result = derive(pack, record, p.id);
      if (result.ok) derived.push({ property: p.id, rule: result.rule, ...result.statement, sources: result.sources });
      else withheld.push({ property: p.id, decision: "derived", rule: result.rule, reason: `Only a derived statement is permitted, and it cannot be made: ${result.reason}.` });
    } else {
      for (const v of own) {
        decide(pack, route, v.member ? `${p.id}/${v.member}` : p.id);
        // On customer route, select only the requested language authorised text (REF-17)
        if (route === "customer" && p.id === narrativeProp) {
          const textLang = v.assertions[0]?.details?.language;
          if (textLang && textLang !== lang) continue;
        }
        const convertMmToM = route === "customer" && nominalDimProps.has(p.id) && !v.member;
        values.push({
          property: v.property,
          ...(v.member ? { member: v.member } : {}),
          ...(v.qualifier ? { qualifier: v.qualifier } : {}),
          status: v.status,
          assertions: (v.status === "corrected" ? v.assertions.slice(0, 1) : v.assertions).map((a) => copy(a, evidenceVisible, convertMmToM)),
        });
      }
    }
  }
  for (const unknown of unknownProps) {
    withheld.push({ property: unknown, decision: "deny", reason: "The property is not in the profile, so nothing about it can be disclosed." });
  }

  const readiness =
    routeReadiness && routeReadiness.route === route
      ? routeReadiness
      : assess(pack, record, {
          routes: [route],
          language: lang,
          ...(options.context ? { context: { [route]: options.context } } : {}),
        })[0]!;

  const onHold = readiness.status === "HOLD";
  let customerPayload: CustomerProjectionPayload | undefined;
  let registryRequest: RegistryRequestEnvelope | undefined;
  let safeHold: SafeHoldEnvelope | undefined;

  if (route === "customer") {
    if (!onHold && record.dppPayload) {
      const refOut = exportReferenceRoute(record.dppPayload, pack.contracts, "customer", {
        language: lang,
        ...(options.context ? { context: options.context } : {}),
      });
      if (refOut.output.status === "RELEASED_REFERENCE_VIEW" && "payload" in refOut.output) {
        customerPayload = refOut.output.payload;
      } else {
        safeHold = refOut.output as SafeHoldEnvelope;
      }
    } else if (onHold) {
      safeHold = safeHoldEnvelope();
    }
  } else if (route === "registry" && record.dppPayload) {
    const refOut = exportReferenceRoute(record.dppPayload, pack.contracts, "registry");
    registryRequest = refOut.output as RegistryRequestEnvelope;
  } else if (onHold) {
    safeHold = safeHoldEnvelope();
  }

  return {
    route,
    recipient: info.recipient,
    status: readiness.status,
    onHold,
    language: lang,
    values,
    derived,
    withheld,
    ...(customerPayload ? { customerPayload } : {}),
    ...(safeHold ? { safeHold } : {}),
    ...(registryRequest ? { registryRequest } : {}),
  };
}
