// @vitest-environment node
/**
 * Cycle 6: the server runs only a contract pack that passes the frozen and signed check (C6-02). A pack whose retention
 * policy was weakened and whose manifest was rewritten to match must be refused at start-up, as must an unsigned one.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { verifyPackForServer } from "../../server/verifyPack";

const dirs: string[] = [];
/** A copy of the stand-in pack with its SIGNATURES.json beside it, as the checker expects. */
function copyPack() {
  const root = mkdtempSync(join(tmpdir(), "dpp-c6-pack-"));
  dirs.push(root);
  cpSync("contracts/n", join(root, "n"), { recursive: true });
  cpSync("contracts/SIGNATURES.json", join(root, "SIGNATURES.json"));
  return { root, pack: join(root, "n") };
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("the server verifies the pack it runs (C6-02)", () => {
  it("accepts the signed stand-in pack", () => {
    const { pack } = copyPack();
    expect(() => verifyPackForServer(pack)).not.toThrow();
  });

  it("refuses a pack with a weakened retention policy and a rewritten manifest, until it is signed again", () => {
    const { pack, root } = copyPack();
    const file = join(pack, "policy/RETENTION@1.0.0.yaml");
    const weak = readFileSync(file, "utf8")
      .replace(/default_retention_days: 3650/, "default_retention_days: 1")
      .replace(/(dataset: evidence-object\n\s+classification: )restricted/, "$1public")
      .replace(/(dataset: evidence-object\n(?:.*\n)?\s+retention_days: )3650/, "$11");
    expect(weak).not.toBe(readFileSync(file, "utf8"));
    writeFileSync(file, weak);
    const manifestPath = join(pack, "MANIFEST.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files["policy/RETENTION@1.0.0.yaml"] = sha(weak);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    // every file now matches the rewritten manifest, but the manifest is not the signed one
    expect(() => verifyPackForServer(pack)).toThrow(/Refusing to start.*not the signed digest/);
    // and the owner's signature of the changed manifest is the only way through
    const signaturesPath = join(root, "SIGNATURES.json");
    const signatures = JSON.parse(readFileSync(signaturesPath, "utf8"));
    signatures.n.manifest_sha256 = sha(readFileSync(manifestPath, "utf8"));
    writeFileSync(signaturesPath, JSON.stringify(signatures));
    expect(() => verifyPackForServer(pack)).not.toThrow();
  });

  it("refuses a pack with no signature, a wrong signed digest, or a file that no longer matches its manifest", () => {
    const unsigned = copyPack();
    writeFileSync(join(unsigned.root, "SIGNATURES.json"), "{}");
    expect(() => verifyPackForServer(unsigned.pack)).toThrow(/no signature/);

    const wrong = copyPack();
    const sig = JSON.parse(readFileSync(join(wrong.root, "SIGNATURES.json"), "utf8"));
    sig.n.manifest_sha256 = "0".repeat(64);
    writeFileSync(join(wrong.root, "SIGNATURES.json"), JSON.stringify(sig));
    expect(() => verifyPackForServer(wrong.pack)).toThrow(/not the signed digest/);

    const edited = copyPack();
    const file = join(edited.pack, "policy/RETENTION@1.0.0.yaml");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n# edited`);
    expect(() => verifyPackForServer(edited.pack)).toThrow(/Refusing to start/);
  });
});
