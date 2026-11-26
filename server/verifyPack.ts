/**
 * The server runs only a contract pack that passes the same check CI runs (`check-contracts --require-frozen
 * --require-signed`): every file matches its manifest digest, the pack is frozen and valid, and the sha256 of
 * MANIFEST.json matches the owner digest approval in SIGNATURES.json next to the pack (A-22; no cryptographic
 * signing profile approved). A pack changed with a rewritten manifest is therefore refused until owner digest
 * approval is updated (C6-02). The checker itself is reused, not reimplemented.
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
    throw new PackNotSignedError(`Refusing to start: contract pack "${dir}" failed the frozen and owner-digest-approval check (${text})`);
  }
}
