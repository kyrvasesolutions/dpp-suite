import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// relative to this file, so it works under both vitest and Playwright
const ROOT = fileURLToPath(new URL("../../fixtures", import.meta.url));

/** Reads a fixture after checking it against its pack's MANIFEST.json; a drifted file fails the test. */
export function fixtureBytes(pack: string, name: string): Uint8Array {
  const manifest = JSON.parse(readFileSync(join(ROOT, pack, "MANIFEST.json"), "utf8")) as {
    files: Record<string, string>;
  };
  const expected = manifest.files[name];
  if (!expected) throw new Error(`fixture ${pack}/${name} is not in the manifest`);
  const bytes = readFileSync(join(ROOT, pack, name));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`fixture ${pack}/${name} does not match its digest`);
  return new Uint8Array(bytes);
}

/** A digest-checked fixture as a browser File, named as the code under test expects. */
export function fixtureFile(pack: string, name: string, type = ""): File {
  return new File([fixtureBytes(pack, name) as BlobPart], name, { type });
}
