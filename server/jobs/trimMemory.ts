/**
 * Gives memory back after a large import (D8-11).
 *
 * A record of several MB is held as bytes, text, parsed values and response text one after the other. V8 collects that garbage when it
 * decides to, which can be several jobs later, so the resident set of a burst of large records grows with the number of jobs and not
 * with the size of one. One full collection when a large job has ended keeps the resident set at the peak of a single job.
 * `--expose-gc` cannot be put on the command line of an installed server, so the collector is reached through V8 itself, once.
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

let collect: (() => void) | null | undefined;

/** Runs one full collection when the runtime allows it. Never throws and never changes behaviour: it is only a hint to V8. */
export function trimMemory(): void {
  if (collect === undefined) {
    try {
      setFlagsFromString("--expose-gc");
      const gc: unknown = runInNewContext("gc");
      collect = typeof gc === "function" ? (gc as () => void) : null;
    } catch {
      collect = null;
    }
  }
  try {
    collect?.();
  } catch {
    /* a hint only */
  }
}

/** Records at or above this many bytes are large enough for a collection after them to be worth its pause. */
export const TRIM_AFTER_BYTES = 1024 * 1024;
