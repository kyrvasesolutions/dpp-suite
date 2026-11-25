/**
 * The public log (D8-04, T07): one JSON line per request on stdout with exactly six fields.
 * Built on `toPublicLogLine`, which validates every value against a strict pattern, so no restricted value, raw path,
 * query, header, CR, LF or ANSI escape can reach stdout. An entry that does not pass is dropped, never printed.
 */
import { toPublicLogLine, type PublicLogEntry } from "../../src/model/c8Contracts";

export type LineWriter = (line: string) => void;

const stdoutLine: LineWriter = (line) => {
  process.stdout.write(`${line}\n`);
};

/** A log function for `createDppServer({ log })` that writes through `write` (stdout by default). */
export function createPublicLogWriter(write: LineWriter = stdoutLine): (entry: PublicLogEntry) => void {
  return (entry) => {
    let line: string;
    try {
      line = toPublicLogLine(entry);
    } catch {
      return; // fail closed: an entry that is not a clean six-field line is never printed, and its content is never echoed
    }
    write(line);
  };
}

export const publicLogWriter = createPublicLogWriter();

/** A start-up or lifecycle line in the same six-field form (request_id and route are fixed placeholders). */
export function publicEventEntry(event: string, level: PublicLogEntry["level"] = "info", status = 200): PublicLogEntry {
  return { ts: new Date().toISOString(), level, event, request_id: "00000000", route: "GET /", status };
}
