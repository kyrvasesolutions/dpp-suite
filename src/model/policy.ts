/**
 * The single decision point of the actor/field matrix (Cycle 3: FUNC-019 slice, criterion C3-01).
 *
 * `decide` is the only function that answers whether a recipient may see a property. Everything that
 * lets a value reach a route output or a recipient view goes through it (see disclosure.ts). The matrix
 * itself is a pinned file of the contract pack, read once by the profile loader. This is a fixed matrix
 * for a trusted local context: it proves no identity and is not a general policy engine.
 */
import { ROUTES, type Access, type ProfilePack, type Route } from "./profile";

/**
 * Whether the recipient of `route` may see `property`: `permit` (the value as it is), `deny` (nothing),
 * or `derived` (only the statement a derived rule allows). A nested member follows its property, so
 * "property/member" is decided as "property". An unknown route or property is an error, never a default.
 */
export function decide(pack: ProfilePack, route: Route, property: string): Access {
  if (!(ROUTES as readonly string[]).includes(route)) throw new Error(`Unknown route "${route}"`);
  const base = property.split("/")[0];
  const row = Object.hasOwn(pack.matrix, base) ? pack.matrix[base] : undefined;
  if (!row) throw new Error(`Unknown property "${base}": the matrix has no row for it`);
  return row[route];
}
