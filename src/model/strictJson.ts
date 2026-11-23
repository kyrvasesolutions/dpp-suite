/**
 * A strict JSON parser for source files (criterion C2-02).
 *
 * JSON.parse keeps the last of two duplicate keys and turns 1e999 into Infinity, so a wrong value can be
 * accepted silently. This parser refuses both, and keeps the literal text of every number so a source
 * assertion can be stored verbatim (C2-03). It follows RFC 8259 otherwise.
 */
export type JsonValue =
  | { kind: "null" }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number; raw: string }
  | { kind: "string"; value: string }
  | { kind: "array"; items: JsonValue[] }
  | { kind: "object"; entries: Map<string, JsonValue> };

export class JsonSyntaxError extends Error {
  override name = "JsonSyntaxError";
  constructor(
    message: string,
    readonly code: "syntax" | "duplicate-key" | "non-finite-number" | "too-deep" | "too-many-nodes",
    readonly offset: number,
    readonly path: string,
  ) {
    super(message);
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

export interface ParseOptions {
  /** Deepest nesting allowed; the root container is depth 1. Checked before recursing, so a hostile text cannot overflow the stack. */
  maxDepth?: number;
  /** Most value nodes allowed in one document (every object, array, string, number, boolean and null counts once). Exceeding it throws `too-many-nodes`. */
  maxNodes?: number;
  /** Longest string value or key allowed, in UTF-16 code units. Exceeding it throws `syntax`. Default: unbounded (byte caps apply first). */
  maxStringLength?: number;
  /** Called for every value, so the caller can enforce a deadline. */
  tick?: () => void;
}

/** Applied when the caller sets no `maxDepth`, so an unbounded hostile nesting cannot overflow the stack (T01). */
export const DEFAULT_MAX_DEPTH = 1000;

export function parseStrictJson(text: string, options: ParseOptions = {}): JsonValue {
  let i = 0;
  let depth = 0;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxString = options.maxStringLength ?? Number.POSITIVE_INFINITY;
  const maxNodes = options.maxNodes ?? Number.POSITIVE_INFINITY;
  let nodes = 0;
  const enter = (path: string) => {
    depth++;
    if (depth > maxDepth) fail(`nesting is deeper than ${maxDepth} levels`, path, "too-deep");
  };

  const fail = (message: string, path: string, code: JsonSyntaxError["code"] = "syntax"): never => {
    throw new JsonSyntaxError(`${message} at offset ${i}${path ? ` (${path})` : ""}`, code, i, path);
  };
  const ws = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const expect = (word: string, path: string) => {
    if (text.startsWith(word, i)) i += word.length;
    else fail(`expected ${word}`, path);
  };

  const SIMPLE: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  });
  const isHigh = (u: number) => u >= 0xd800 && u <= 0xdbff;
  const isLow = (u: number) => u >= 0xdc00 && u <= 0xdfff;
  const hex4 = (at: number): number => (/^[0-9a-fA-F]{4}$/.test(text.slice(at, at + 4)) ? parseInt(text.slice(at, at + 4), 16) : -1);

  function string(path: string): string {
    i++; // opening quote
    let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated string", path);
      const c = text[i]!;
      if (c === '"') {
        i++;
        return out;
      }
      if (c < " ") fail("control character in string", path);
      if (c === "\\") {
        const e = text[i + 1] ?? "";
        if (e in SIMPLE) {
          out += SIMPLE[e];
          i += 2;
        } else if (e === "u") {
          const unit = hex4(i + 2);
          if (unit < 0) fail("invalid escape", path);
          if (isLow(unit)) fail("unpaired surrogate escape", path);
          if (isHigh(unit)) {
            // a high surrogate must be followed by a \uDC00-\uDFFF escape; a lone surrogate cannot be stored as UTF-8
            const next = text.startsWith("\\u", i + 6) ? hex4(i + 8) : -1;
            if (!isLow(next)) fail("unpaired surrogate escape", path);
            out += String.fromCharCode(unit, next);
            i += 12;
          } else {
            out += String.fromCharCode(unit);
            i += 6;
          }
        } else fail("invalid escape", path);
      } else {
        const u = c.charCodeAt(0);
        if (isHigh(u)) {
          if (!isLow(text.charCodeAt(i + 1))) fail("unpaired surrogate", path);
          out += c + text[i + 1];
          i += 2;
        } else if (isLow(u)) fail("unpaired surrogate", path);
        else {
          // a run of plain characters is copied with one slice: a 10 MiB string would otherwise build ten million pieces
          let j = i + 1;
          while (j < text.length) {
            const d = text.charCodeAt(j);
            if (d === 0x22 || d === 0x5c || d < 0x20 || (d >= 0xd800 && d <= 0xdfff)) break;
            j++;
          }
          out += text.slice(i, j);
          i = j;
        }
      }
      if (out.length > maxString) fail(`a string is longer than ${maxString} characters`, path);
    }
  }

  function value(path: string): JsonValue {
    options.tick?.();
    ws();
    if (++nodes > maxNodes) fail(`the document has more than ${maxNodes} values`, path, "too-many-nodes");
    const c = text[i];
    if (c === "{") {
      enter(path);
      i++;
      const entries = new Map<string, JsonValue>();
      ws();
      if (text[i] === "}") {
        i++;
        depth--;
        return { kind: "object", entries };
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("expected a key", path);
        const keyAt = i;
        const key = string(path);
        const child = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
        if (entries.has(key)) {
          i = keyAt;
          fail(`duplicate key "${key}"`, child, "duplicate-key");
        }
        ws();
        if (text[i] !== ":") fail("expected :", child);
        i++;
        entries.set(key, value(child));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          depth--;
          return { kind: "object", entries };
        }
        fail("expected , or }", path);
      }
    }
    if (c === "[") {
      enter(path);
      i++;
      const items: JsonValue[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        depth--;
        return { kind: "array", items };
      }
      for (;;) {
        items.push(value(`${path}/${items.length}`));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          depth--;
          return { kind: "array", items };
        }
        fail("expected , or ]", path);
      }
    }
    if (c === '"') return { kind: "string", value: string(path) };
    if (c === "t") return expect("true", path), { kind: "boolean", value: true };
    if (c === "f") return expect("false", path), { kind: "boolean", value: false };
    if (c === "n") return expect("null", path), { kind: "null" };
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) return fail("unexpected character", path);
    const raw = m[0];
    const num = Number(raw);
    if (!Number.isFinite(num)) fail(`number ${raw} is not finite`, path, "non-finite-number");
    i += raw.length;
    return { kind: "number", value: num, raw };
  }

  let root: JsonValue;
  try {
    root = value("");
  } catch (err) {
    // a backstop: the depth limit should always trip first
    if (err instanceof RangeError) fail("nesting is too deep to parse", "", "too-deep");
    throw err;
  }
  ws();
  if (i !== text.length) fail("unexpected text after the JSON value", "");
  return root;
}

/** Plain JavaScript value of a parsed document (numbers lose their literal text). */
export function toPlain(v: JsonValue): unknown {
  switch (v.kind) {
    case "null":
      return null;
    case "boolean":
    case "string":
    case "number":
      return v.value;
    case "array":
      return v.items.map(toPlain);
    case "object": {
      // A null-prototype object: a `__proto__`, `constructor` or `prototype` key is plain data and can never reach a prototype (T02).
      const out: Record<string, unknown> = Object.create(null);
      for (const [k, x] of v.entries) Object.defineProperty(out, k, { value: toPlain(x), enumerable: true, writable: true, configurable: true });
      return out;
    }
  }
}
