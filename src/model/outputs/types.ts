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
}

/** A file name from the record's own identifiers, reduced to characters every system accepts. */
export const safeName = (...parts: string[]) => parts.map((p) => p.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")).join("_");
