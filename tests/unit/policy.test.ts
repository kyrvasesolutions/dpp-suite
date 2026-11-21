// @vitest-environment node
/** Cycle 3: the actor/field matrix has one decision function (criterion C3-01). */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { readPack } from "../../config/contractPack";
import { decide } from "../../src/model/policy";
import { ROUTES, loadProfilePack, type ProfilePack } from "../../src/model/profile";

let pack: ProfilePack;
const source = readPack("contracts/n");
beforeAll(async () => {
  pack = await loadProfilePack(source);
});

/** The matrix as the CSV file states it, read independently of the loader. */
function matrixRows() {
  const lines = source.files["policy/actor-field-matrix.csv"].split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  const [, ...rows] = lines.map((l) => l.split(","));
  return rows;
}

describe("decide", () => {
  it("matches every cell of the matrix file", () => {
    const rows = matrixRows();
    expect(rows).toHaveLength(24);
    for (const row of rows) {
      ROUTES.forEach((route, i) => expect(decide(pack, route, row[0]), `${row[0]} for ${route}`).toBe(row[i + 1]));
    }
  });

  it("lets a nested member follow its property", () => {
    for (const p of pack.properties) {
      for (const m of p.members) for (const route of ROUTES) expect(decide(pack, route, `${p.id}/${m.id}`)).toBe(decide(pack, route, p.id));
    }
  });

  it("throws for an unknown route or property rather than guessing", () => {
    expect(() => decide(pack, "customer-pdf", "ALU-NOPE")).toThrow(/Unknown property/);
    expect(() => decide(pack, "customer-pdf", "")).toThrow(/Unknown property/);
    expect(() => decide(pack, "carrier-pigeon" as never, pack.properties[0].id)).toThrow(/Unknown route/);
    expect(() => decide(pack, "__proto__" as never, pack.properties[0].id)).toThrow(/Unknown route/);
    expect(() => decide(pack, "customer-pdf", "__proto__")).toThrow(/Unknown property/);
    expect(() => decide(pack, "customer-pdf", "constructor")).toThrow(/Unknown property/);
  });

  it("derives only where the matrix says derived: the three kinds occur and no other", () => {
    const seen = new Set(matrixRows().flatMap((r) => r.slice(1)));
    expect([...seen].sort()).toEqual(["deny", "derived", "permit"]);
  });
});

describe("single decision point", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : [p];
    });

  it("lets only the loader and policy.ts name the matrix file in src/", () => {
    const naming = files("src")
      .filter((f) => /\.(ts|tsx)$/.test(f) && readFileSync(f, "utf8").includes("actor-field-matrix"))
      .sort();
    expect(naming).toEqual(["src/model/profile.ts"]);
  });

  it("lets only policy.ts read the matrix table (the loader builds it)", () => {
    const reading = files("src")
      .filter((f) => /\.(ts|tsx)$/.test(f) && /\.matrix\b/.test(readFileSync(f, "utf8")))
      .sort();
    expect(reading).toEqual(["src/model/policy.ts"]);
  });
});
