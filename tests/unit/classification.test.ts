/** Default classification (criterion C0-07, LEAN-DEF-12). */
import { describe, expect, it } from "vitest";
import { DEFAULT_CLASSIFICATION, classify, mayDisclose } from "../../src/model/classification";

describe("classification", () => {
  it("defaults to restricted", () => {
    expect(DEFAULT_CLASSIFICATION).toBe("restricted");
  });

  it("treats missing, empty or unknown classes as restricted", () => {
    for (const stated of [undefined, null, "", "Public", "secret", "confidential"]) {
      expect(classify(stated)).toBe("restricted");
    }
  });

  it("keeps a valid stated class", () => {
    expect(classify("public")).toBe("public");
    expect(classify("internal")).toBe("internal");
  });

  it("never discloses restricted content to a lower clearance", () => {
    expect(mayDisclose("restricted", "public")).toBe(false);
    expect(mayDisclose("restricted", "internal")).toBe(false);
    expect(mayDisclose("internal", "public")).toBe(false);
    expect(mayDisclose("public", "public")).toBe(true);
    expect(mayDisclose("internal", "restricted")).toBe(true);
  });

  it("discloses unclassified content to restricted clearance only", () => {
    expect(mayDisclose(classify(undefined), "internal")).toBe(false);
    expect(mayDisclose(classify(undefined), "restricted")).toBe(true);
  });
});
