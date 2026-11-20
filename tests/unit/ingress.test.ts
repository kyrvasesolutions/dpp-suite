/**
 * Strict ingress probes for criterion C2-02 (failure cases FC-DUPLICATE-KEY and FC-NON-FINITE).
 *
 * Baseline finding B0-04: the JSON import keeps the last of two duplicate keys and accepts a number that
 * overflows to Infinity. `it.fails` passes while that defect exists. When Cycle 2 makes ingress strict
 * these tests turn red: change them to `it` then.
 */
import { describe, expect, it } from "vitest";
import { extractFields } from "../../src/model/dataFields";

const json = (text: string) => new File([text], "lab-assessment.json", { type: "application/json" });

describe("C2-02 strict JSON ingress (known failing, B0-04)", () => {
  it.fails("rejects duplicate object keys", async () => {
    await expect(extractFields(json('{"massPercent":1,"massPercent":2}'))).rejects.toThrow();
  });

  it.fails("rejects numbers that overflow to Infinity", async () => {
    await expect(extractFields(json('{"co2ePerKg":1e999}'))).rejects.toThrow();
  });
});

describe("C2-02 strict JSON ingress (already met)", () => {
  it("rejects NaN, which is not JSON", async () => {
    await expect(extractFields(json('{"co2ePerKg":NaN}'))).rejects.toThrow("lab-assessment.json: not valid JSON.");
  });
});
