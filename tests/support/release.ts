/** A release of the clean stand-in pair, made the same way everywhere (golden files, double run, e2e checks). */
import { generateRelease } from "../../src/model/outputs/release";
import type { ProfilePack } from "../../src/model/profile";
import { MemoryRepository, storeRecord, type Snapshot } from "../../src/model/recordRepository";
import { CLEAN, loadPack, recordFor, type Combination } from "./records";

/** Fixed, so no golden file depends on the package version or on where the test runs. */
export const TEST_SOFTWARE = { name: "dpp-traceability", version: "0.0.0-golden", commit: "golden" };

export async function releaseFor(c: Combination = CLEAN, pack?: ProfilePack) {
  const p = pack ?? (await loadPack());
  const { snapshot } = await storeRecord(new MemoryRepository(), await recordFor(p, c));
  return { pack: p, snapshot: snapshot as Snapshot, release: await generateRelease(p, snapshot, { software: TEST_SOFTWARE }) };
}
