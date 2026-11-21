import { buildRecords, importErpCsv, importLabJson, type ImportResult, type RecordState } from "../model/ingress";
import type { ProfilePack } from "../model/profile";

/** The synthetic N fixtures that match the embedded pack, served with the app so the operator can try a clean and a faulty import. */
const FIXTURES = import.meta.glob(["@n-fixtures/*.{csv,json}", "!@n-fixtures/MANIFEST.json"], { query: "?url", import: "default", eager: true }) as Record<string, string>;
const BY_NAME = new Map(Object.entries(FIXTURES).map(([path, url]) => [path.split("/").pop()!, url]));
const fixtureUrl = (name: string) => {
  const url = BY_NAME.get(name);
  if (!url) throw new Error(`Sample file ${name} is not in the fixture pack`);
  return url;
};

export interface Sample {
  id: string;
  label: string;
  erp?: string;
  lab?: string;
}

export interface Input {
  bytes: Uint8Array;
  name: string;
  type: string;
}

/** Sample files for the Import screen: a clean pair and one file for each kind of error. */
export const IMPORT_SAMPLES: Sample[] = [
  { id: "clean", label: "Clean pair", erp: "d03a-erp-extract.csv", lab: "d03a-lab-assessment.json" },
  { id: "conflict", label: "Sources disagree on the alloy", erp: "d03a-erp-extract.csv", lab: "lab-conflicting-alloy.json" },
  { id: "unknown-code", label: "Unknown company code", erp: "erp-unknown-company-code.csv", lab: "d03a-lab-assessment.json" },
  { id: "two-footprints", label: "Two footprint results", erp: "d03a-erp-extract.csv", lab: "lab-two-footprints.json" },
  { id: "digest", label: "Evidence without digest", erp: "d03a-erp-extract.csv", lab: "lab-evidence-digest-missing.json" },
  { id: "encoding", label: "ERP extract not UTF-8", erp: "erp-latin1.csv" },
  { id: "missing-column", label: "ERP extract without the alloy column", erp: "erp-missing-alloy-column.csv" },
  { id: "decimal-comma", label: "ERP value with a decimal comma", erp: "erp-decimal-comma.csv" },
  { id: "duplicate-key", label: "Lab file with a duplicate key", lab: "lab-duplicate-key.json" },
  { id: "non-finite", label: "Lab file with 1e999", lab: "lab-non-finite.json" },
  { id: "missing-unit", label: "Lab value without a unit", lab: "lab-missing-unit.json" },
  { id: "wrong-unit", label: "Lab value in inches", lab: "lab-wrong-unit.json" },
  { id: "unit-alias", label: "Lab value in N/mm²", lab: "lab-unit-alias.json" },
];

/** Prepared record states for the Readiness screen. */
export const READINESS_SAMPLES: Sample[] = [
  { id: "clean", label: "Clean pair: customer PDF and ERP ready, registry on hold", erp: "d03a-erp-extract.csv", lab: "d03a-lab-assessment.json" },
  { id: "conflict", label: "Conflicting alloy: challenged value", erp: "d03a-erp-extract.csv", lab: "lab-conflicting-alloy.json" },
  { id: "two-footprints", label: "Two footprint results: no selection", erp: "d03a-erp-extract.csv", lab: "lab-two-footprints.json" },
  { id: "blocked", label: "Blocked export: recycled content missing", erp: "erp-missing-recycled-content.csv", lab: "d03a-lab-assessment.json" },
];

export async function readFixture(name: string): Promise<Input> {
  const response = await fetch(fixtureUrl(name));
  // The served type of a fixture depends on the web server; the name stands for what the operator's browser would send.
  return { bytes: new Uint8Array(await response.arrayBuffer()), name, type: name.endsWith(".csv") ? "text/csv" : "application/json" };
}

/** Imports the files of one sample against the pack, and combines the accepted ones into record states. */
export async function importInputs(
  profile: ProfilePack,
  inputs: { erp?: Input; lab?: Input },
): Promise<{ results: { erp?: ImportResult; lab?: ImportResult }; state: RecordState }> {
  const erp = inputs.erp ? await importErpCsv(profile, inputs.erp) : undefined;
  const lab = inputs.lab ? await importLabJson(profile, inputs.lab) : undefined;
  const state = await buildRecords([erp, lab].filter((r): r is ImportResult => !!r));
  return { results: { erp, lab }, state };
}

export async function importSample(profile: ProfilePack, sample: Sample) {
  const inputs = { erp: sample.erp ? await readFixture(sample.erp) : undefined, lab: sample.lab ? await readFixture(sample.lab) : undefined };
  return { inputs, ...(await importInputs(profile, inputs)) };
}
