/** Characterisation of the specification YAML in src/model/spec.ts (profile precursor, FUNC-001 at F1). */
import { describe, expect, it } from "vitest";
import { parseSpec, toYaml, type Spec } from "../../src/model/spec";

const spec: Spec = {
  version: 1,
  id: "aluminium-espr",
  name: "Aluminum · ESPR",
  savedAt: "2026-11-20T09:42:12.000Z",
  productGroup: "aluminium",
  productGroupName: "Aluminum",
  legislations: [
    { id: "espr", short: "ESPR", title: "Ecodesign for Sustainable Products Regulation", ref: "Regulation (EU) 2024/1781", url: "https://eur-lex.europa.eu/eli/reg/2024/1781/oj", type: "b2g" },
  ],
  dataRequirements: [
    {
      id: "product-id",
      name: "Unique product identifier",
      theme: "Identification & operators",
      sources: [
        { legislation: "ESPR", act: "Regulation (EU) 2024/1781", provision: "Art. 10(1)(a)", url: "https://eur-lex.europa.eu/", summary: "yes", quotes: ["a unique product identifier"] },
      ],
      standards: ["ISO/IEC 15459-1:2014"],
    },
  ],
};

describe("specification YAML", () => {
  it("reads back what it writes", () => {
    expect(parseSpec(toYaml(spec))).toEqual({ ok: true, spec });
  });

  it("quotes strings YAML would read as other types", () => {
    expect(toYaml({ a: "yes", b: "12", c: "plain text" })).toBe('a: "yes"\nb: "12"\nc: plain text\n');
  });

  it("rejects an empty document", () => {
    expect(parseSpec("")).toEqual({ ok: false, error: "The YAML is empty or not a specification." });
  });

  it("rejects a repeated data requirement id", () => {
    const twice = { ...spec, dataRequirements: [spec.dataRequirements[0], spec.dataRequirements[0]] };
    expect(parseSpec(toYaml(twice))).toEqual({
      ok: false,
      error: 'dataRequirements: id "product-id" is used more than once',
    });
  });

  it("requires at least one data requirement", () => {
    expect(parseSpec(toYaml({ ...spec, dataRequirements: [] }))).toEqual({
      ok: false,
      error: "dataRequirements: needs at least one data requirement",
    });
  });
});
