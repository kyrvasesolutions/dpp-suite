import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Which contract pack the app embeds. The public build, CI and the live site use the stand-in in
 * contracts/n. A local build can point DPP_CONTRACT_PACK at the private pack (decision D1-01, option b);
 * `npm run check-bundle` refuses such a build for publication.
 */
export const PUBLIC_PACK = "contracts/n";
export const packDir = () => process.env.DPP_CONTRACT_PACK ?? PUBLIC_PACK;

/** The synthetic fixtures that follow the embedded pack: fixtures/n for the stand-in, spec/fixtures/n for the private pack. */
export const fixtureDir = () => process.env.DPP_FIXTURE_PACK ?? packDir().replace(/(^|\/)contracts\//, "$1fixtures/");

const listFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });

/** Reads every file of a pack as text, with its manifest, in the shape `loadProfilePack` expects. */
export function readPack(dir: string) {
  const files: Record<string, string> = {};
  for (const path of listFiles(dir)) {
    const rel = relative(dir, path).split("\\").join("/");
    if (rel !== "MANIFEST.json" && !rel.endsWith(".DS_Store") && !rel.endsWith("README.md")) files[rel] = readFileSync(path, "utf8");
  }
  const manifestText = readFileSync(join(dir, "MANIFEST.json"), "utf8");
  return {
    dir,
    manifest: JSON.parse(manifestText),
    files,
    manifestDigest: createHash("sha256").update(manifestText).digest("hex"),
  };
}

/** Runs the contract checker on the pack; throws, and so fails the build, unless the pack is frozen, valid and signed. */
export function checkPack(dir: string) {
  execFileSync("node", ["scripts/check-contracts.mjs", "--pack", dir, "--require-frozen", "--require-signed"], { stdio: "pipe", encoding: "utf8" });
}
