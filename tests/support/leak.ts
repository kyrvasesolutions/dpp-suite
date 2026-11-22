/** The disclosure invariant as a helper: nothing a recipient may not see appears anywhere in a projection. */
import type { ProductRecord } from "../../src/model/ingress";
import type { Projection } from "../../src/model/disclosure";
import { decide } from "../../src/model/policy";
import type { ProfilePack } from "../../src/model/profile";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Throws if the raw text of any value the recipient may not see (denied, or only derived) appears in
 * `JSON.stringify(projection)`. Long detail strings such as a method or an issuer count too. A token matches only as a
 * whole word, and text that a permitted value states too is not counted, so "228" is not found inside "2284" or "H111" inside "PM-5754-H111-2000".
 */
export function assertNoLeak(projection: Projection, record: ProductRecord, pack: ProfilePack): void {
  assertNoLeakText(JSON.stringify(projection), projection.route, record, pack);
}

/** The same check over any generated text (a CSV, a JSON file, extracted PDF text) made for `route`. */
export function assertNoLeakText(json: string, route: Projection["route"], record: ProductRecord, pack: ProfilePack): void {
  const projection = { route };
  // Text that a permitted value states too (two properties can both say "1.0") cannot show that a denied one leaked.
  // The evidence identifier in a value's details is left out of this pool: it is the evidence property's own value.
  const permitted = new Set(
    record.values
      .filter((v) => decide(pack, projection.route, v.property) === "permit")
      .flatMap((v) =>
        v.assertions.flatMap((a) => [a.raw, String(a.value ?? ""), ...Object.entries(a.details ?? {}).filter(([k]) => k !== "evidence_id").map(([, d]) => d)]),
      ),
  );
  for (const v of record.values) {
    if (decide(pack, projection.route, v.property) === "permit") continue;
    for (const a of v.assertions) {
      // the raw text and value, and the long free-text details that identify the record (method, issuer, ...); the short
      // coded details (uncertainty kind, coverage factor, ...) are not identifying and would match unrelated words
      const long = Object.entries(a.details ?? {}).filter(([k, d]) => ["method", "issuer", "calculated_by", "scope", "digest", "access_policy_ref", "evidence_id"].includes(k) && d.length >= 4);
      const tokens = [a.raw, String(a.value ?? ""), ...long.map(([, d]) => d)].filter((t) => t.length >= 2 && !permitted.has(t));
      for (const token of tokens) {
        if (new RegExp(`(?<![\\w-])(?<!\\d\\.)${escape(token)}(?![\\w-])(?!\\.\\d)`).test(json)) {
          throw new Error(`leak: "${token}" of ${v.property}${v.member ? `/${v.member}` : ""} appears in the ${projection.route} projection`);
        }
      }
    }
  }
}
