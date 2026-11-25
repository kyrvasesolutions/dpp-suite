/**
 * sha256 of `canonical(value)` without ever building the canonical text (D8-11).
 *
 * `canonical()` joins nested arrays and objects level by level, so a record with a 10 MB value is copied once per level of nesting,
 * and a snapshot is hashed three times on the way to the store. This walks the value and feeds the hash in small pieces, so the memory
 * it needs is one piece (a large string value is escaped once, then dropped). The bytes fed are exactly those of `canonical(value)`,
 * which the tests compare for every shape, so every digest stays the same on every machine and in the browser.
 */
import { createHash, type Hash } from "node:crypto";

const FLUSH_AT = 1 << 16;

class Feeder {
  readonly #hash: Hash = createHash("sha256");
  #pending = "";

  write(piece: string): void {
    if (piece.length >= FLUSH_AT) {
      this.#flush();
      this.#hash.update(piece);
      return;
    }
    this.#pending += piece;
    if (this.#pending.length >= FLUSH_AT) this.#flush();
  }
  #flush(): void {
    if (this.#pending) this.#hash.update(this.#pending);
    this.#pending = "";
  }
  hex(): string {
    this.#flush();
    return this.#hash.digest("hex");
  }
}

/** Writes `canonical(x)`; returns false (and writes nothing) when `canonical(x)` is `undefined` (a function, a symbol or undefined). */
function walk(x: unknown, out: Feeder): boolean {
  if (Array.isArray(x)) {
    out.write("[");
    for (let i = 0; i < x.length; i++) {
      if (i > 0) out.write(",");
      walk(x[i], out); // an item with no JSON form joins as the empty string, exactly as `[undefined].map(canonical).join()` does
    }
    out.write("]");
    return true;
  }
  if (x && typeof x === "object") {
    out.write("{");
    const o = x as Record<string, unknown>;
    let first = true;
    for (const k of Object.keys(o).sort()) {
      if (!first) out.write(",");
      first = false;
      out.write(`${JSON.stringify(k)}:`);
      if (!walk(o[k], out)) out.write("undefined"); // a template literal turns `undefined` into this text
    }
    out.write("}");
    return true;
  }
  const text = JSON.stringify(x);
  if (text === undefined) return false;
  out.write(text);
  return true;
}

/** Lower-case hex sha256 of the UTF-8 bytes of `canonical(value)`. */
export function canonicalSha256Sync(value: unknown): string {
  const out = new Feeder();
  walk(value, out);
  return out.hex();
}
