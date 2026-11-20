/**
 * Characterisation of src/model/dataFields.ts as found in the Cycle 0 baseline (FUNC-039 at F1).
 * These tests pin current behaviour, not the N import contract; Cycle 2 replaces the import path.
 */
import { Blob as NodeBlob } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractFields } from "../../src/model/dataFields";
import { fixtureFile } from "../support/fixtures";

const textFile = (name: string, text: string) => new File([text], name);
const paths = (fields: Array<{ path: string }>) => fields.map((f) => f.path);

describe("CSV", () => {
  it("reads the header as fields and the first row as samples, honouring quotes", async () => {
    const fields = await extractFields(fixtureFile("baseline", "erp-comma.csv"));
    expect(fields).toEqual([
      { path: "sku", sample: "AP-6063-T5" },
      { path: "gtin", sample: "05412345678901" },
      { path: "massKg", sample: "12.5" },
      { path: "description", sample: "Profile, 40x40 mm" },
    ]);
  });

  it("strips a byte-order mark and switches to ';' when the header has more of them", async () => {
    const fields = await extractFields(fixtureFile("baseline", "erp-semicolon-bom.csv"));
    expect(fields).toEqual([
      { path: "Artikel", sample: "AP; 6063" },
      { path: "Legierung", sample: "EN AW-6063" },
      { path: "Masse kg", sample: "12,5" },
    ]);
  });
});

describe("JSON", () => {
  it("flattens nested objects and arrays into paths, keeping the first value of an array", async () => {
    const fields = await extractFields(fixtureFile("baseline", "nested.json"));
    expect(paths(fields)).toEqual([
      "article.sku",
      "article.gtin",
      "alloy.composition[].element",
      "alloy.composition[].massPercent",
      "alloy.svhcList",
      "note",
    ]);
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f.sample]));
    expect(byPath["alloy.composition[].element"]).toBe("Al");
    expect(byPath["alloy.svhcList"]).toBeUndefined();
  });

  it("shortens samples over 60 characters to 57 plus an ellipsis", async () => {
    const fields = await extractFields(fixtureFile("baseline", "nested.json"));
    const note = fields.find((f) => f.path === "note")?.sample ?? "";
    expect(note).toHaveLength(58);
    expect(note.endsWith("…")).toBe(true);
  });

  it("stops at 500 fields", async () => {
    const big = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`f${i}`, i]));
    const fields = await extractFields(textFile("big.json", JSON.stringify(big)));
    expect(fields).toHaveLength(500);
  });

  it("names the file in the error for invalid JSON", async () => {
    await expect(extractFields(textFile("broken.json", "{"))).rejects.toThrow("broken.json: not valid JSON.");
  });

  it("treats .jsonld and .json-ld as JSON", async () => {
    for (const name of ["a.jsonld", "a.json-ld"]) {
      expect(paths(await extractFields(textFile(name, '{"x":{"y":1}}')))).toEqual(["x.y"]);
    }
  });
});

describe("XML", () => {
  it("starts paths below the root and records attributes with @", async () => {
    const fields = await extractFields(fixtureFile("baseline", "product.xml"));
    expect(fields).toEqual([
      { path: "article@sku", sample: "AP-6063-T5" },
      { path: "article.gtin", sample: "05412345678901" },
      { path: "alloy.designation", sample: "EN AW-6063" },
    ]);
  });

  it("rejects XML that is not well-formed", async () => {
    await expect(extractFields(textFile("bad.xml", "<a><b></a>"))).rejects.toThrow("bad.xml: not well-formed XML.");
  });
});

describe("RDF", () => {
  it("does not accept the .ttl extension", async () => {
    await expect(extractFields(fixtureFile("baseline", "product.ttl"))).rejects.toThrow(
      "product.ttl: unsupported file type .ttl",
    );
  });

  it("lists the predicates of Turtle triples in an .rdf file and skips rdf:type", async () => {
    const ttl = new TextDecoder().decode(new Uint8Array(await fixtureFile("baseline", "product.ttl").arrayBuffer()));
    const fields = await extractFields(textFile("product.rdf", ttl));
    expect(fields).toEqual([
      { path: "schema:gtin", sample: "05412345678901" },
      { path: "schema:material", sample: "EN AW-6063" },
    ]);
  });
});

describe("Excel", () => {
  // jsdom's Blob has no stream(), which the browser's has; inflate() needs it. Use Node's for this block.
  const jsdomBlob = globalThis.Blob;
  beforeAll(() => {
    globalThis.Blob = NodeBlob as unknown as typeof Blob;
  });
  afterAll(() => {
    globalThis.Blob = jsdomBlob;
  });

  it("reads the first row of the first sheet as fields and the second as samples", async () => {
    const fields = await extractFields(fixtureFile("baseline", "erp.xlsx"));
    expect(fields).toEqual([
      { path: "sku", sample: "AP-6063-T5" },
      { path: "gtin", sample: "05412345678901" },
      { path: "massKg", sample: "12.5" },
    ]);
  });
});

describe("file types and duplicates", () => {
  it("rejects other extensions, naming the file", async () => {
    await expect(extractFields(textFile("sheet.pdf", "%PDF"))).rejects.toThrow("sheet.pdf: unsupported file type .pdf");
  });

  it("keeps the first of repeated paths", async () => {
    const fields = await extractFields(textFile("dup.csv", "a,a,b\n1,2,3\n"));
    expect(fields).toEqual([
      { path: "a", sample: "1" },
      { path: "b", sample: "3" },
    ]);
  });
});
