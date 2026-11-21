/** Builds product records from the digest-checked N fixtures, optionally with small edits, for the Cycle 3 tests. */
import { readPack } from "../../config/contractPack";
import { buildRecords, importErpCsv, importLabJson, type ProductRecord } from "../../src/model/ingress";
import { loadProfilePack, type ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "./fixtures";

export const loadPack = () => loadProfilePack(readPack("contracts/n"));
export const text = (name: string) => new TextDecoder().decode(fixtureBytes("n", name));
const enc = (s: string) => new TextEncoder().encode(s);

/** The property whose definition has this slug, so no test names an identifier. */
export function propertyBySlug(pack: ProfilePack, slug: string): string {
  const found = pack.properties.find((p) => p.definitionRef.endsWith(`:${slug}`));
  if (!found) throw new Error(`no property ${slug}`);
  return found.id;
}

export interface Combination {
  erp?: string;
  lab?: string;
  /** Edits of the ERP text (a scratch copy) and of the parsed lab document. */
  editErp?: (csv: string) => string;
  editLab?: (doc: any) => void;
}

/** Imports the files of one combination; throws if a file the test relies on is rejected. */
export async function recordsFor(pack: ProfilePack, c: Combination): Promise<ProductRecord[]> {
  const results = [];
  if (c.erp) {
    const csv = c.editErp ? c.editErp(text(c.erp)) : text(c.erp);
    const r = await importErpCsv(pack, { bytes: enc(csv), name: c.erp, type: "text/csv" });
    if (!r.ok) throw new Error(`${c.erp} rejected: ${r.errors[0].code}`);
    results.push(r);
  }
  if (c.lab) {
    const doc = JSON.parse(text(c.lab));
    c.editLab?.(doc);
    const r = await importLabJson(pack, { bytes: enc(JSON.stringify(doc)), name: c.lab, type: "application/json" });
    if (!r.ok) throw new Error(`${c.lab} rejected: ${r.errors[0].code}`);
    results.push(r);
  }
  return (await buildRecords(results)).records;
}

export const recordFor = async (pack: ProfilePack, c: Combination) => (await recordsFor(pack, c))[0];

export const CLEAN = { erp: "d03a-erp-extract.csv", lab: "d03a-lab-assessment.json" };

/** Every accepted ERP file combined with every accepted lab file, and each ERP file alone. */
export const ACCEPTED_ERP = ["d03a-erp-extract.csv", "erp-missing-recycled-content.csv", "erp-unknown-company-code.csv"];
export const ACCEPTED_LAB = ["d03a-lab-assessment.json", "lab-conflicting-alloy.json", "lab-two-footprints.json", "lab-evidence-digest-missing.json"];
export const COMBINATIONS: Combination[] = [
  ...ACCEPTED_ERP.flatMap((erp) => [{ erp }, ...ACCEPTED_LAB.map((lab) => ({ erp, lab }))]),
];
