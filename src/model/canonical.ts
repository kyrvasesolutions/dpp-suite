/**
 * Canonical JSON: object keys sorted, no insignificant whitespace, so the same content always gives the same text
 * and therefore the same digest on any machine. `canonicalPretty` is the same with two-space indentation, for the
 * files a person may open (JSON output, manifest, central-record export).
 */
export const canonical = (x: unknown): string =>
  Array.isArray(x)
    ? `[${x.map(canonical).join(",")}]`
    : x && typeof x === "object"
      ? `{${Object.keys(x)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(x);

const sortKeys = (x: unknown): unknown =>
  Array.isArray(x)
    ? x.map(sortKeys)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
            .map((k) => [k, sortKeys((x as Record<string, unknown>)[k])]),
        )
      : x;

/** Sorted keys, two-space indentation, a final newline. Same text for the same content on every run. */
export const canonicalPretty = (x: unknown): string => `${JSON.stringify(sortKeys(x), null, 2)}\n`;

const encoder = new TextEncoder();
export const utf8 = (text: string): Uint8Array => encoder.encode(text);

/** sha256 of bytes, as lower-case hex. */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
