/**
 * Bounded structural record schema checker (Cycle 9: C9-03, C9-04, REF-20, REF-21, REF-26).
 *
 * Implements the exact bounded JSON Schema keyword set of the pinned reference specification.
 * Any unsupported non-annotation keyword is explicitly reported as an error rather than ignored,
 * so the checker never claims full JSON Schema conformance. Pure, synchronous, zero network.
 */

export const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "minLength",
]);

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

const TYPE_CHECKS: Record<string, (x: unknown) => boolean> = {
  object: (x) => typeof x === "object" && x !== null && !Array.isArray(x),
  array: (x) => Array.isArray(x),
  string: (x) => typeof x === "string",
  null: (x) => x === null,
  boolean: (x) => typeof x === "boolean",
  number: (x) => typeof x === "number" && Number.isFinite(x),
  integer: (x) => typeof x === "number" && Number.isInteger(x),
};

export function checkBoundedSchema(value: unknown, schema: Record<string, unknown>, path = "$"): string[] {
  const unsupported = Object.keys(schema).filter((k) => !SUPPORTED_SCHEMA_KEYWORDS.has(k)).sort();
  if (unsupported.length > 0) {
    return [`${path}: unsupported schema keywords ${JSON.stringify(unsupported)}`];
  }
  const errors: string[] = [];
  const rawTypes = schema.type;
  const types = typeof rawTypes === "string" ? [rawTypes] : Array.isArray(rawTypes) ? (rawTypes as string[]) : [];
  if (types.some((t) => !(t in TYPE_CHECKS))) {
    return [`${path}: unsupported type`];
  }
  if (types.length > 0 && !types.some((t) => TYPE_CHECKS[t]!(value))) {
    return [`${path}: type mismatch`];
  }
  if ("const" in schema && !deepEqual(value, schema.const)) {
    errors.push(`${path}: const mismatch`);
  }
  if ("enum" in schema && Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(value, e))) {
    errors.push(`${path}: enum mismatch`);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) {
    errors.push(`${path}: string too short`);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required as string[]) {
        if (!Object.hasOwn(obj, reqKey)) errors.push(`${path}: missing ${reqKey}`);
      }
    }
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!Object.hasOwn(props, k)) errors.push(`${path}: unexpected ${k}`);
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (Object.hasOwn(props, k)) {
        errors.push(...checkBoundedSchema(v, props[k]!, `${path}.${k}`));
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      const itemSchema = schema.items as Record<string, unknown>;
      value.forEach((item, idx) => {
        errors.push(...checkBoundedSchema(item, itemSchema, `${path}[${idx}]`));
      });
    }
  }
  return errors;
}
