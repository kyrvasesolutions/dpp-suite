/**
 * Strict ingress probes for criterion C2-02 (failure cases FC-DUPLICATE-KEY and FC-NON-FINITE).
 *
 * Baseline finding B0-04 (the JSON import kept the last of two duplicate keys and accepted a number that
 * overflows to Infinity) was fixed in Cycle 2: the Mapping import now uses the strict parser too.
 */
import { describe, expect, it } from "vitest";
import { extractFields } from "../../src/model/dataFields";

const json = (text: string) => new File([text], "lab-assessment.json", { type: "application/json" });

describe("C2-02 strict JSON ingress (B0-04 fixed in Cycle 2)", () => {
  it("rejects duplicate object keys", async () => {
    await expect(extractFields(json('{"massPercent":1,"massPercent":2}'))).rejects.toThrow(/duplicate key "massPercent"/);
  });

  it("rejects numbers that overflow to Infinity", async () => {
    await expect(extractFields(json('{"co2ePerKg":1e999}'))).rejects.toThrow(/1e999 is not finite/);
  });
});

describe("C2-02 strict JSON ingress (already met)", () => {
  it("rejects NaN, which is not JSON", async () => {
    await expect(extractFields(json('{"co2ePerKg":NaN}'))).rejects.toThrow("lab-assessment.json: not valid JSON.");
  });
});
