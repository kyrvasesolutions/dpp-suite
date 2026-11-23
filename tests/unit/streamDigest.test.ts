// @vitest-environment node
/**
 * D8-11: the streamed digest is exactly the digest of `canonical()`. Every digest that is stored, signed or compared must stay the
 * same on every machine and in the browser, so the streamed walk is compared with the plain one for every shape `canonical` handles.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonical } from "../../src/model/canonical";
import { canonicalSha256Sync } from "../../server/store/streamDigest";

const viaCanonical = (x: unknown) => createHash("sha256").update(canonical(x)).digest("hex");

describe("canonicalSha256Sync equals sha256(canonical(x))", () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["numbers, booleans and strings", [0, -1.5, 1e21, true, false, "a\"b\\c\n é\u{1F600}"]],
    ["lone surrogate (escaped by JSON.stringify)", "\ud800 x"],
    ["empty containers", { a: [], b: {}, c: [[], {}] }],
    ["unsorted keys and nesting", { z: 1, a: { y: [3, { b: 2, a: 1 }], x: null }, m: "text" }],
    ["undefined, functions and symbols in objects", { a: undefined, b: () => 1, c: Symbol("s"), d: 1 }],
    ["undefined, functions and symbols in arrays", [1, undefined, () => 1, Symbol("s"), 2]],
    ["a Date is an object without keys", { when: new Date(0) }],
    ["keys that need escaping", { 'we"ird': 1, "new\nline": 2, "é": 3 }],
    ["a record-shaped value", { model: "M", batch: "B", sources: [{ role: "erp", name: "x.csv", sha256: "ab" }], values: [{ property: "p", status: "single", assertions: [{ raw: "1", value: 1, flags: [] }] }] }],
  ];
  for (const [name, value] of cases) {
    it(name, () => {
      expect(canonicalSha256Sync(value)).toBe(viaCanonical(value));
    });
  }

  it("a large value is hashed across the flush boundary exactly as the plain text is", () => {
    const big = { a: "x".repeat(200_000), b: ["y".repeat(70_000), "z".repeat(10)], c: Array.from({ length: 30_000 }, (_, i) => ({ i, s: `v${i}` })) };
    expect(canonicalSha256Sync(big)).toBe(viaCanonical(big));
  });
});
