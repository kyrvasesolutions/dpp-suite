// @vitest-environment node
/** Helper of the double-run test: when EMIT_DIR is set, writes the three outputs and the manifest there. Skipped otherwise. */
import { mkdirSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { releaseFor } from "../support/release";

it.runIf(!!process.env.EMIT_DIR)("emits a release into EMIT_DIR", async () => {
  const dir = process.env.EMIT_DIR!;
  mkdirSync(dir, { recursive: true });
  const { release } = await releaseFor();
  for (const f of release.files) writeFileSync(`${dir}/${f.fileName}`, f.bytes);
  writeFileSync(`${dir}/${release.manifestFile.fileName}`, release.manifestFile.bytes);
});
