import type { LineageEntry } from "../lineage";
import type { Route } from "../profile";
import type { HoldReason } from "../readiness";
import type { OutputValue } from "./items";

/** One generated file, with what the release manifest needs to describe it. */
export interface OutputFile {
  route: Route;
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
  /** `ready`, or `hold` for the registry draft, which is always a draft and never sent anywhere. */
  status: "ready" | "hold";
  holds: HoldReason[];
  items: OutputValue[];
  lineage: LineageEntry[];
  /** The ERP CSV only: how many text cells got the leading apostrophe. */
  formulaPrefixedCells?: number;
}

/** The longest generated file name (without its extension), so a hostile identifier cannot make a huge name (V4-02). */
export const SAFE_NAME_MAX = 128;

/**
 * One identifier reduced to the characters every system accepts. Linear in its input: no backtracking pattern runs on
 * unbounded text, the input is cut to the cap first, and leading and trailing dashes are trimmed by index.
 */
export function safePart(p: string, max = SAFE_NAME_MAX): string {
  // skip leading characters that would only become dashes, on the original text (so a long dash run cannot hide the name)
  let from = 0;
  while (from < p.length && !/[A-Za-z0-9._]/.test(p[from]!)) from++;
  const cleaned = p.slice(from, from + max * 4).replace(/[^A-Za-z0-9._-]+/g, "-");
  let end = Math.min(cleaned.length, max);
  while (end > 0 && cleaned[end - 1] === "-") end--;
  return cleaned.slice(0, end);
}

/** A file name from the record's own identifiers, reduced to safe characters and at most `SAFE_NAME_MAX` long. */
export const safeName = (...parts: string[]) => parts.map((p) => safePart(p)).join("_").slice(0, SAFE_NAME_MAX);
