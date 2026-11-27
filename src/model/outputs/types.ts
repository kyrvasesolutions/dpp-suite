import type { ExchangeType } from "../context";
import type { LineageEntry } from "../lineage";
import type { Route } from "../profile";
import type { HoldReason, RouteStatus } from "../readiness";
import type { OutputValue } from "./items";

/** One generated file, with what the release manifest needs to describe it. */
export interface OutputFile {
  route: Route;
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
  /** `RELEASED`, or `HOLD` for the registry preparation preview (never submitted). */
  status: RouteStatus;
  holds: HoldReason[];
  items: OutputValue[];
  lineage: LineageEntry[];
  /** S5-EXCHANGE-rev2 exchange type when the output is a JSON exchange envelope. */
  exchangeType?: ExchangeType;
  /** The internal CSV only: how many text cells received a leading apostrophe for formula safety. */
  formulaPrefixedCells?: number;
}

export const SAFE_NAME_MAX = 128;

export function safePart(p: string, max = SAFE_NAME_MAX): string {
  let from = 0;
  while (from < p.length && !/[A-Za-z0-9._]/.test(p[from]!)) from++;
  const cleaned = p.slice(from, from + max * 4).replace(/[^A-Za-z0-9._-]+/g, "-");
  let end = Math.min(cleaned.length, max);
  while (end > 0 && cleaned[end - 1] === "-") end--;
  return cleaned.slice(0, end);
}

export const safeName = (...parts: string[]) => parts.map((p) => safePart(p)).join("_").slice(0, SAFE_NAME_MAX);
