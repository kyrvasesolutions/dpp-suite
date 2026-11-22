/**
 * The server runs only a contract pack that passes the same check CI runs (`check-contracts --require-frozen
 * --require-signed`): every file matches its manifest digest, the pack is frozen and valid, and the sha256 of
 * MANIFEST.json is the digest the owner signed in SIGNATURES.json next to the pack. A pack changed with a rewritten
 * manifest is therefore refused until it is signed again (C6-02). The checker itself is reused, not reimplemented.
 */
import { checkPack } from "../config/contractPack";

export class PackNotSignedError extends Error {
  override name = "PackNotSignedError";
}

export function verifyPackForServer(dir: string): void {
  try {
    checkPack(dir);
  } catch (err) {
    const detail = err as { stderr?: string; message?: string };
    const text = (detail.stderr ?? detail.message ?? String(err)).toString().trim().split("\n").filter(Boolean).slice(-3).join(" | ");
    throw new PackNotSignedError(`Refusing to start: contract pack "${dir}" failed the frozen and signed check (${text})`);
  }
}
