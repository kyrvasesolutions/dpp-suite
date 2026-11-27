// @vitest-environment node
/** Cycle 4 (aligned in Cycle 9): the pinned output mapping. Every route field has one item and reads what the matrix allows. */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readPack } from "../../config/contractPack";
import { decide } from "../../src/model/policy";
import { loadProfilePack, ROUTES, type ProfilePack } from "../../src/model/profile";

const packs: Array<[string, string]> = [["stand-in", "contracts/n"], ["private", "spec/contracts/n"]];

describe.each(packs)("output mapping of the %s pack", (_, dir) => {
  const run = existsSync(`${dir}/MANIFEST.json`) ? it : it.skip;
  const load = (): Promise<ProfilePack> => loadProfilePack(readPack(dir));

  run("has exactly one field item per route field, and nothing for a denied property", async () => {
    const pack = await load();
    for (const route of ROUTES) {
      const items = pack.routes[route].output;
      const fields = items.filter((i) => i.role === "field").map((i) => i.property);
      const expected = pack.properties.filter((p) => decide(pack, route, p.id) !== "deny").map((p) => p.id);
      expect([...fields].sort(), route).toEqual([...expected].sort());
      expect(new Set(fields).size).toBe(fields.length);
      for (const item of items) expect(decide(pack, route, item.property), `${route} ${item.step}`).not.toBe("deny");
    }
  });

  run("gives every step an ID that is unique across the pack, and derived statements their derived rule", async () => {
    const pack = await load();
    const steps = ROUTES.flatMap((r) => pack.routes[r].output.map((i) => i.step));
    expect(new Set(steps).size).toBe(steps.length);
    for (const route of ROUTES) {
      for (const item of pack.routes[route].output) {
        const derived = decide(pack, route, item.property) === "derived";
        expect(item.reads.kind === "derived", `${route} ${item.step}`).toBe(derived);
        if (item.reads.kind === "derived") {
          const rule = pack.policy.derived.rules.find((r) => r.property === item.property);
          expect(item.reads.rule).toBe(rule?.id);
        }
      }
    }
  });

  run("limits the registry output to its permitted fields and carries context items only on non-registry routes", async () => {
    const pack = await load();
    for (const item of pack.routes.registry.output) expect(decide(pack, "registry", item.property)).toBe("permit");
    expect(pack.routes.registry.output.some((i) => i.role === "context")).toBe(false);
    expect(pack.routes.internal.output.some((i) => i.role === "context")).toBe(true);
  });
});
