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
  /** Called for every value, so the caller can enforce a deadline. */
  tick?: () => void;
}

export function parseStrictJson(text: string, options: ParseOptions = {}): JsonValue {
  let i = 0;
  let depth = 0;
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
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

  function string(path: string): string {
    i++; // opening quote
    let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated string", path);
      const c = text[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c < " ") fail("control character in string", path);
      if (c === "\\") {
        const e = text[i + 1];
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (e in simple) {
          out += simple[e];
          i += 2;
        } else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
        } else fail("invalid escape", path);
      } else {
        out += c;
        i++;
      }
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

  const root = value("");
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
    case "object":
      return Object.fromEntries([...v.entries].map(([k, x]) => [k, toPlain(x)]));
  }
}
