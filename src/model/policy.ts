/**
 * The single decision point of the actor/field matrix and recipient disclosure policy
 * (Cycle 3: FUNC-019 slice, criterion C3-01; aligned in Cycle 9 to PROFILE-ALU-24-01 1.0.0).
 *
 * Separates trusted processing permission (`permitted_processing_properties` minus
 * `deny_processing_properties`) from recipient disclosure (`forbid_raw_disclosure` and
 * `allowed_derived_representations`), matching REF-09, REF-10, and REF-28.
 */
import { ROUTES, type Access, type ProfilePack, type Route } from "./profile";

/**
 * Whether the recipient of `route` may see `property`: `permit`, `deny`, or `derived`.
 * A nested member follows its property. An unknown route or property throws, never defaults.
 */
export function decide(pack: ProfilePack, route: Route, property: string): Access {
  if (!(ROUTES as readonly string[]).includes(route)) throw new Error(`Unknown route "${route}"`);
  const base = property.split("/")[0]!;
  const row = Object.hasOwn(pack.matrix, base) ? pack.matrix[base] : undefined;
  if (!row) throw new Error(`Unknown property "${base}": the matrix has no row for it`);
  return row[route];
}

/** Whether the trusted derivation service may process `property` for `route` (PROFILE-ALU-24-01, REF-09). */
export function isProcessingPermitted(pack: ProfilePack, route: Route, property: string): boolean {
  const base = property.split("/")[0]!;
  const req = pack.contracts.profilePolicy[route];
  if (req.deny_processing_properties.includes(base)) return false;
  return req.permitted_processing_properties.includes(base);
}

/** Whether raw disclosure of `property` is explicitly forbidden to the customer recipient (REF-28). */
export function isRawDisclosureForbidden(pack: ProfilePack, route: Route, property: string): boolean {
  if (route !== "customer") return false;
  const base = property.split("/")[0]!;
  return pack.contracts.profilePolicy.customer.forbid_raw_disclosure.includes(base);
}

/** Whether a named derived representation is permitted for the customer recipient (REF-10). */
export function isDerivedAllowed(pack: ProfilePack, route: Route, representation: "recycled_total_with_basis" | "lead_screening"): boolean {
  if (route !== "customer") return false;
  return pack.contracts.profilePolicy.customer.allowed_derived_representations.includes(representation);
}
