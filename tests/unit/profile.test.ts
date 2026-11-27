// @vitest-environment node
/**
 * Cycle 1: the frozen profile resolves through its pins (criteria C1-01 to C1-06).
 *
 * Runs on the public stand-in in contracts/n, and on the private pack in spec/contracts/n when it is
 * present (decision D1-01, option b: CI only has the stand-in).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readPack } from "../../config/contractPack";
import { PROVISIONS } from "../../src/model/legislation";
import { ProfileError, ROUTES, labelFor, loadProfilePack, lookup, memberCount } from "../../src/model/profile";

const ROOT = resolve(__dirname, "../..");
const PACKS = ["contracts/n", "spec/contracts/n"].filter((p) => existsSync(join(ROOT, p, "MANIFEST.json")));

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A scratch copy of a pack, so a test can change it. */
function copyOf(pack: string) {
  const dir = mkdtempSync(join(tmpdir(), "profile-"));
  tmpDirs.push(dir);
  cpSync(join(ROOT, pack), dir, { recursive: true });
  return dir;
}
const edit = (dir: string, path: string, change: (text: string) => string) =>
  writeFileSync(join(dir, path), change(readFileSync(join(dir, path), "utf8")));
const checker = (...args: string[]) =>
  execFileSync("node", ["scripts/check-contracts.mjs", ...args], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
/** Rewrites the manifest of a changed copy; the checker still reports the rule the change breaks. */
const rewrite = (dir: string) => {
  try {
    checker("--pack", dir, "--write");
  } catch {
    // The manifest is written before the rules run; the failure is asserted separately.
  }
};
const PROFILE = "profile/PROFILE-ALU-24-01@1.0.0.yaml";

describe.each(PACKS)("profile from %s", (pack) => {
  const load = () => loadProfilePack(readPack(join(ROOT, pack)));

  it("C1-01 resolves exactly 24 properties with definitions, units, requiredness, labels and members", async () => {
    const profile = await load();
    expect(profile.properties).toHaveLength(24);
    expect(new Set(profile.properties.map((p) => p.id)).size).toBe(24);
    for (const p of profile.properties) {
      expect(p.definition.length, p.id).toBeGreaterThan(10);
      expect(p.labels.en && p.labels.de, p.id).toBeTruthy();
      for (const r of ROUTES) expect(typeof p.requiredBy[r], `${p.id} ${r}`).toBe("boolean");
      if (p.unit !== null) expect(p.unitName, p.id).toBeTruthy();
      for (const m of p.members) expect(m.definition, m.id).toBeTruthy();
    }
    expect(memberCount(profile)).toBeGreaterThan(0);
    expect(profile.release.released).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(profile.languages).toEqual(["en", "de"]);
  });

  it("C1-02 refuses a file whose bytes no longer match the manifest", async () => {
    const source = readPack(join(ROOT, pack));
    source.files[PROFILE] = source.files[PROFILE].replace("unit: mm", "unit: cm");
    await expect(loadProfilePack(source)).rejects.toThrow(new ProfileError(`${PROFILE} does not match its pinned digest`));
  });

  it("C1-02 refuses a file that is not in the manifest", async () => {
    const source = readPack(join(ROOT, pack));
    source.files["code-lists/EXTRA@1.0.0.csv"] = "code\nX\n";
    await expect(loadProfilePack(source)).rejects.toThrow("is not in MANIFEST.json");
  });

  it("C1-02 refuses a moving version, even with a rewritten manifest", async () => {
    const dir = copyOf(pack);
    edit(dir, PROFILE, (t) => t.replace("terms: ALU-TERMS@1.0.0", "terms: ALU-TERMS@latest"));
    rewrite(dir);
    expect(() => checker("--pack", dir)).toThrow(/must be an exact id@version/);
    await expect(loadProfilePack(readPack(dir))).rejects.toThrow(/exact id@version/);
  });

  it.each([
    ["inputs/erp-extract.csv.contract.yaml", "version: 1.0.0", "version: latest"],
    ["inputs/lab-assessment.contract.yaml", "version: 1.0.0", "version: latest"],
    ["routes/customer.yaml", "version: 1.0.0", "version: latest"],
    ["inputs/erp-extract.csv.contract.yaml", "id: SRC-ERP-CSV-01", "id: SRC-ERP-CSV-02"],
  ])("C1-02 refuses a mapping contract that is not the pinned version (%s: %s -> %s)", async (file, from, to) => {
    const dir = copyOf(pack);
    edit(dir, file, (t) => t.replace(from, to));
    rewrite(dir);
    expect(() => checker("--pack", dir)).toThrow(/C1-02/);
    await expect(loadProfilePack(readPack(dir))).rejects.toThrow(ProfileError);
  });

  it("FUNC-091 refuses a declared mapping to a property or member that does not exist", () => {
    const dir = copyOf(pack);
    const erp = "inputs/erp-extract.csv.contract.yaml";
    const first = parse(readFileSync(join(dir, erp), "utf8")).columns[0].maps_to as string;
    edit(dir, erp, (t) => t.replace(`maps_to: ${first}\n`, "maps_to: ALU-D999\n"));
    rewrite(dir);
    expect(() => checker("--pack", dir)).toThrow(/is not a profile property/);
  });

  it("C1-03 an edited code list keeps its name and gets a new digest", async () => {
    const before = await load();
    const dir = copyOf(pack);
    edit(dir, "code-lists/TEMPER@1.0.0.csv", (t) => `${t}H14\n`);
    expect(() => checker("--pack", dir)).toThrow(/does not match its digest/);
    rewrite(dir);
    expect(checker("--pack", dir, "--require-frozen")).toContain("Pack frozen");
    const after = await loadProfilePack(readPack(dir));
    const temper = (p: typeof before) => p.codeLists.find((c) => c.ref === "TEMPER@1.0.0")!;
    expect(temper(after).digest).not.toBe(temper(before).digest);
    expect(temper(after).codes.map((c) => c.code)).toContain("H14");
    expect(after.manifestDigest).not.toBe(before.manifestDigest);
  });

  it("C1-04 an unresolved term reference fails the checker and the loader", async () => {
    const dir = copyOf(pack);
    const ref = parse(readFileSync(join(dir, PROFILE), "utf8")).properties[0].definition_ref as string;
    edit(dir, PROFILE, (t) => t.replace(`definition_ref: ${ref}`, `definition_ref: ${ref}-missing`));
    rewrite(dir);
    expect(() => checker("--pack", dir)).toThrow(/does not resolve to a governed term/);
    await expect(loadProfilePack(readPack(dir))).rejects.toThrow(/does not resolve to a governed term/);
  });

  it("C1-05 keeps the sector apart from the language tag", async () => {
    const profile = await load();
    const withContext = profile.properties.filter((p) => p.contextLabels.length);
    expect(withContext.length).toBeGreaterThan(0);
    for (const p of withContext) {
      for (const l of p.contextLabels) {
        expect(l.lang).toMatch(/^[a-z]{2}$/);
        expect(profile.sectors).toContain(l.context);
        expect(labelFor(p, l.lang as "en" | "de", l.context)).toBe(l.text);
      }
      expect(labelFor(p, "en")).toBe(p.labels.en);
    }
    const dir = copyOf(pack);
    const sample = withContext[0].contextLabels[0];
    edit(dir, PROFILE, (t) => t.replace(`lang: ${sample.lang}\n        context: ${sample.context}`, `lang: ${sample.lang}-${sample.context}\n        context: ${sample.context}`));
    rewrite(dir);
    expect(() => checker("--pack", dir)).toThrow(/plain language tag/);
  });

  it("C1-06 every property has one source-status label, and legal links resolve in the chain", async () => {
    const profile = await load();
    for (const p of profile.properties) {
      expect(Object.keys(profile.legalStatuses)).toContain(p.legal.status);
      if (p.legal.status === "voluntary") {
        expect(p.legal.requirement).toBeUndefined();
      } else {
        const found = PROVISIONS.some(
          (pr) => pr.dataRequirement === p.legal.requirement && pr.legislation === p.legal.legislation && pr.groups.includes("aluminium"),
        );
        expect(found, `${p.id}: ${p.legal.requirement} in ${p.legal.legislation}`).toBe(true);
      }
    }
    expect(profile.legalNote).toMatch(/not a legal assessment/i);
  });

  it("FUNC-030 the frozen mappings need no unit conversion", () => {
    const erp = parse(readFileSync(join(ROOT, pack, "inputs/erp-extract.csv.contract.yaml"), "utf8")) as {
      columns: Array<{ maps_to: string; unit: string | null }>;
    };
    const units = parse(readFileSync(join(ROOT, pack, PROFILE), "utf8")).properties as Array<{ id: string; unit: string | null }>;
    const unitOf = new Map(units.map((p) => [p.id, p.unit]));
    for (const c of erp.columns) if (c.unit) expect(c.unit, c.maps_to).toBe(unitOf.get(c.maps_to.split("/")[0]));
  });

  it("FUNC-081 looks up a property by ID or label", async () => {
    const profile = await load();
    const first = profile.properties[0];
    expect(lookup(profile, first.id.toLowerCase())).toEqual([first]);
    expect(lookup(profile, first.labels.de.slice(0, 6)).map((p) => p.id)).toContain(first.id);
    expect(lookup(profile, "")).toHaveLength(24);
    expect(lookup(profile, "no such property")).toEqual([]);
  });
});
