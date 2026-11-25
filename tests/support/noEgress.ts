/**
 * Vitest no-egress monitor (D8-05, LEAN-DEF-13, threat T10).
 *
 * A setup file: in every node-environment test file it installs the egress guard in record mode and fails the file in
 * afterAll if any non-loopback destination was attempted. Attempts are never silenced here: a failure names the API
 * and the host. In a jsdom file there is no Node networking under test, so the monitor stays out of the way.
 */
import { afterAll } from "vitest";
import { installEgressGuard, type EgressGuardHandle } from "../../server/security/egressGuard";

/** The monitor's current guard, so the guard's own test can lift it and put it back. */
export const MONITOR_KEY = Symbol.for("dpp.noEgress.monitor");
const slot = globalThis as unknown as Record<symbol, EgressGuardHandle | undefined>;

// jsdom defines `document`; the node environment does not.
if (typeof document === "undefined") {
  slot[MONITOR_KEY] = installEgressGuard({ allowlist: [], mode: "record" });
  afterAll(() => {
    const guard = slot[MONITOR_KEY]!;
    guard();
    if (guard.attempts.length > 0) {
      const lines = [...new Set(guard.attempts.map((a) => `${a.api} -> ${a.host}`))];
      throw new Error(`no-egress monitor: ${guard.attempts.length} external attempt(s) in this test file:\n  ${lines.join("\n  ")}`);
    }
  });
}
