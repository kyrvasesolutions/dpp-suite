/** The one-record, two-input, three-route scenario, on the model functions: import, readiness, the three outputs and the manifest. */
import { buildRecords, importErpCsv, importLabJson } from "../../src/model/ingress";
import { generateRelease } from "../../src/model/outputs/release";
import type { ProfilePack } from "../../src/model/profile";
import { assess } from "../../src/model/readiness";
import { MemoryRepository, storeRecord } from "../../src/model/recordRepository";
import { fixtureBytes } from "./fixtures";
import { TEST_SOFTWARE } from "./release";

export async function runScenario(pack: ProfilePack) {
  const erp = await importErpCsv(pack, { bytes: fixtureBytes("n", "erp-extract.csv"), name: "erp-extract.csv", type: "text/csv" });
  const lab = await importLabJson(pack, { bytes: fixtureBytes("n", "lab-assessment.json"), name: "lab-assessment.json", type: "application/json" });
  const { records } = await buildRecords([erp, lab], pack);
  const readiness = assess(pack, records[0]);
  const { snapshot } = await storeRecord(new MemoryRepository(), records[0]);
  const release = await generateRelease(pack, snapshot, { software: TEST_SOFTWARE });
  return { records, readiness, release };
}
