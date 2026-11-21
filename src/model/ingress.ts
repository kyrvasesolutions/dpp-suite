/**
 * Strict import of the two fixed N source files (Cycle 2, N03): the ERP CSV extract and the laboratory and
 * assessment JSON, each against its pinned input contract (FUNC-039, FUNC-125 import side).
 *
 * Every file passes the ingress stages in order: bytes, parse, structure, semantics, authorisation. The first
 * stage with a problem rejects the file with typed errors that name the stage and the location (C2-02).
 * An accepted file becomes source assertions: the verbatim text, where it came from, and explicit flags
 * (C2-03, C2-06). Unknown codes are kept and flagged, never dropped or guessed. Units are checked against
 * the contract and never converted, because the frozen mappings need no conversion (C2-04, FUNC-030).
 * Combining the two files keeps both assertions when they disagree and marks the value challenged (C2-05).
 * The resulting record state depends only on the file bytes and the pack, so importing again gives the
 * same record and the same digest (C2-07). There is no overall quality score (FUNC-017 slice).
 */
import { JsonSyntaxError, parseStrictJson, type JsonValue } from "./strictJson";
import { sha256Hex, type CodeList, type ProfilePack } from "./profile";

export const STAGES = ["bytes", "parse", "structure", "semantics", "authorisation", "route"] as const;
export type Stage = (typeof STAGES)[number];

export type IngressCode =
  | "media-type"
  | "byte-order-mark"
  | "wrong-encoding"
  | "empty-file"
  | "csv-syntax"
  | "ragged-row"
  | "duplicate-column"
  | "missing-column"
  | "unexpected-column"
  | "no-rows"
  | "json-syntax"
  | "duplicate-key"
  | "non-finite-number"
  | "schema"
  | "missing-value"
  | "not-a-number"
  | "decimal-comma"
  | "out-of-range"
  | "invalid-date"
  | "missing-unit"
  | "wrong-unit"
  | "unknown-evidence"
  | "not-authorised";

/** What each error means for the operator, in the words of the operator notes (C2-08). */
export const ERROR_TEXT: Record<IngressCode, string> = {
  "media-type": "The file is not of the expected type. Use the ERP extract as .csv and the laboratory file as .json.",
  "byte-order-mark": "The file starts with a byte order mark. Save it as UTF-8 without BOM.",
  "wrong-encoding": "The file is not valid UTF-8. Export it again with UTF-8 encoding.",
  "empty-file": "The file is empty.",
  "csv-syntax": "The CSV text is malformed, for example a quote that is never closed.",
  "ragged-row": "A row has a different number of fields from the header. Check for an extra or missing delimiter.",
  "duplicate-column": "A column name appears twice in the header.",
  "missing-column": "A column the contract requires is missing from the header.",
  "unexpected-column": "The header has a column the contract does not know. Remove it or ask for the contract to change.",
  "no-rows": "The extract has a header but no data rows.",
  "json-syntax": "The JSON text is malformed.",
  "duplicate-key": "An object in the JSON has the same key twice, so it is unclear which value is meant.",
  "non-finite-number": "A number is too large to represent, or not a number at all.",
  "schema": "The JSON does not have the structure the contract requires.",
  "missing-value": "A required value is empty.",
  "not-a-number": "A numeric value is not a plain number with a point as decimal separator.",
  "decimal-comma": "A numeric value uses a comma as decimal separator. The contract requires a point.",
  "out-of-range": "A value is outside its possible range, such as a negative length or a share over 100 %.",
  "invalid-date": "A date is not a real calendar date in the form YYYY-MM-DD.",
  "missing-unit": "A measured value has no unit. It is not accepted as unitless.",
  "wrong-unit": "A measured value has a unit the contract does not allow for this property. Nothing is converted.",
  "unknown-evidence": "A value refers to an evidence record that the file does not contain.",
  "not-authorised": "This role may not import source files.",
};

export interface IngressIssue {
  stage: Stage;
  code: IngressCode;
  message: string;
  /** File and position: row and column for CSV, JSON pointer for JSON. */
  location: string;
}

export type Flag =
  | "declared"
  | "measured"
  | "calculated-externally"
  | "unit-from-contract"
  | "unit-stated"
  | "uncertainty-stated"
  | "evidence-linked"
  | "evidence-digest-missing"
  | "code-mapped"
  | "unknown-code"
  | "several-results"
  | "draft-text"
  | "challenged";

export const FLAG_TEXT: Record<Flag, string> = {
  declared: "Declared in the ERP extract",
  measured: "Measured by the laboratory",
  "calculated-externally": "Calculated outside this tool and imported as is",
  "unit-from-contract": "Unit given by the ERP contract column",
  "unit-stated": "Unit stated in the source",
  "uncertainty-stated": "Measurement uncertainty stated",
  "evidence-linked": "Linked to an evidence record",
  "evidence-digest-missing": "Evidence record has no digest",
  "code-mapped": "Company code mapped through the code list",
  "unknown-code": "Code not in the code list: kept as given",
  "several-results": "Several results and no rule to select one",
  "draft-text": "Text not yet approved",
  challenged: "The sources disagree: both values are kept",
};

export interface SourceFile {
  name: string;
  role: "erp" | "lab";
  mediaType: string;
  sha256: string;
  size: number;
}

export interface Assertion {
  property: string;
  member?: string;
  /** Distinguishes several assertions of one property: language, element, result or evidence ID. */
  qualifier?: string;
  /** The source text exactly as it appears in the file. */
  raw: string;
  value: string | number | null;
  unit: string | null;
  details?: Record<string, string>;
  source: { file: string; role: SourceFile["role"]; sha256: string; location: string };
  flags: Flag[];
}

export type ImportResult =
  | { ok: true; file: SourceFile; assertions: Assertion[]; records: Array<{ model: string; batch: string }> }
  | { ok: false; file: SourceFile; stage: Stage; errors: IngressIssue[] };

/** Roles that may import source files in the local N build (trusted local context, no identity proof). */
export const IMPORT_ROLES = ["ACT-01"] as const;

class StageFailure extends Error {
  constructor(
    readonly stage: Stage,
    readonly errors: IngressIssue[],
  ) {
    super(errors[0]?.message ?? stage);
  }
}

const issue = (stage: Stage, code: IngressCode, location: string, detail?: string): IngressIssue => ({
  stage,
  code,
  location,
  message: detail ? `${ERROR_TEXT[code]} ${detail}` : ERROR_TEXT[code],
});

const failIf = (stage: Stage, errors: IngressIssue[]) => {
  if (errors.length) throw new StageFailure(stage, errors);
};

async function bytesStage(bytes: Uint8Array, name: string, declaredType: string, role: SourceFile["role"]) {
  const expected = role === "erp" ? { type: "text/csv", ext: ".csv" } : { type: "application/json", ext: ".json" };
  // Browsers often send no type, or an Excel type for .csv, so the extension decides when the type is absent.
  const typeOk = declaredType === expected.type || (declaredType === "" && name.toLowerCase().endsWith(expected.ext));
  const extOk = name.toLowerCase().endsWith(expected.ext);
  failIf("bytes", typeOk && extOk ? [] : [issue("bytes", "media-type", name, `Expected ${expected.type} (${expected.ext}), got "${declaredType || "no type"}".`)]);
  failIf("bytes", bytes.length === 0 ? [issue("bytes", "empty-file", name)] : []);
  failIf("bytes", bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? [issue("bytes", "byte-order-mark", `${name}, byte 0`)] : []);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    let at = 0;
    for (let n = 1; n <= bytes.length; n++) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n));
        at = n;
      } catch {
        if (n - at > 4) break;
      }
    }
    throw new StageFailure("bytes", [issue("bytes", "wrong-encoding", `${name}, byte ${at}`)]);
  }
  const file: SourceFile = { name, role, mediaType: expected.type, sha256: await sha256Hex(text), size: bytes.length };
  return { text, file };
}

function authorise(actor: string, name: string) {
  failIf("authorisation", (IMPORT_ROLES as readonly string[]).includes(actor) ? [] : [issue("authorisation", "not-authorised", name, `Role ${actor}.`)]);
}

// ---------- ERP CSV ----------

/** RFC 4180 rows with a one-character delimiter; quotes may enclose delimiters, quotes ("") and line breaks. */
function csvRows(text: string, delimiter: string, name: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        const next = text[i + 1];
        if (next !== undefined && next !== delimiter && next !== "\n" && next !== "\r") {
          throw new StageFailure("parse", [issue("parse", "csv-syntax", `${name}, line ${line}`, "Text after a closing quote.")]);
        }
      } else {
        if (c === "\n") line++;
        field += c;
      }
    } else if (c === '"') {
      if (field !== "") throw new StageFailure("parse", [issue("parse", "csv-syntax", `${name}, line ${line}`, "Quote inside an unquoted field.")]);
      quoted = true;
      wasQuoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
      wasQuoted = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      wasQuoted = false;
      line++;
    } else {
      field += c;
    }
  }
  if (quoted) throw new StageFailure("parse", [issue("parse", "csv-syntax", `${name}, line ${line}`, "A quote is never closed.")]);
  if (field !== "" || wasQuoted || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const DECIMAL_COMMA = /^-?\d+,\d+$/;

function isCalendarDate(s: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const codeListOf = (pack: ProfilePack, ref?: string): CodeList | undefined => (ref ? pack.codeLists.find((c) => c.ref === ref) : undefined);

export async function importErpCsv(
  pack: ProfilePack,
  input: { bytes: Uint8Array; name: string; type: string },
  actor = "ACT-01",
): Promise<ImportResult> {
  const contract = pack.inputs.erp;
  let file: SourceFile = { name: input.name, role: "erp", mediaType: input.type, sha256: "", size: input.bytes.length };
  try {
    const decoded = await bytesStage(input.bytes, input.name, input.type, "erp");
    file = decoded.file;
    const name = input.name;

    // parse
    const rows = csvRows(decoded.text, contract.delimiter, name);
    const [header = [], ...body] = rows;
    failIf(
      "parse",
      body.flatMap((r, i) =>
        r.length === header.length ? [] : [issue("parse", "ragged-row", `${name}, row ${i + 2}`, `${r.length} fields, header has ${header.length}.`)],
      ),
    );

    // structure
    const expected = contract.columns.map((c) => c.name);
    const seen = new Set<string>();
    const structure: IngressIssue[] = [];
    header.forEach((h, i) => {
      if (seen.has(h)) structure.push(issue("structure", "duplicate-column", `${name}, column ${i + 1}`, `"${h}".`));
      seen.add(h);
      if (!expected.includes(h)) structure.push(issue("structure", "unexpected-column", `${name}, column ${i + 1}`, `"${h}".`));
    });
    for (const c of contract.columns) if (!seen.has(c.name)) structure.push(issue("structure", "missing-column", name, `"${c.name}".`));
    if (!body.length) structure.push(issue("structure", "no-rows", name));
    failIf("structure", structure);

    // semantics
    const at = (row: number, col: string) => `${name}, row ${row}, column ${col}`;
    const assertions: Assertion[] = [];
    const errors: IngressIssue[] = [];
    const records: Array<{ model: string; batch: string }> = [];
    body.forEach((r, i) => {
      const rowNo = i + 2;
      const cell = Object.fromEntries(header.map((h, j) => [h, r[j]]));
      records.push({ model: cell.product_model_id, batch: cell.batch_id });
      for (const c of contract.columns) {
        const raw = cell[c.name];
        const loc = at(rowNo, c.name);
        if (raw === "") {
          if (c.required) errors.push(issue("semantics", "missing-value", loc));
          continue;
        }
        const [property, member] = c.maps_to.split("/");
        const flags: Flag[] = ["declared"];
        let value: string | number | null = raw;
        if (c.unit) {
          if (DECIMAL_COMMA.test(raw)) {
            errors.push(issue("semantics", "decimal-comma", loc, `"${raw}".`));
            continue;
          }
          if (!DECIMAL.test(raw)) {
            errors.push(issue("semantics", "not-a-number", loc, `"${raw}".`));
            continue;
          }
          value = Number(raw);
          if (value < 0 || (c.unit === "%" && value > 100)) {
            errors.push(issue("semantics", "out-of-range", loc, `${raw} ${c.unit}.`));
            continue;
          }
          flags.push("unit-from-contract");
        }
        if (c.format === "ISO 8601 date" && !isCalendarDate(raw)) {
          errors.push(issue("semantics", "invalid-date", loc, `"${raw}".`));
          continue;
        }
        const list = codeListOf(pack, c.code_list);
        if (list) {
          const known = list.codes.find((x) => x.code === raw);
          if (!known) flags.push("unknown-code");
          else if (known.mapsTo !== undefined) {
            value = known.mapsTo;
            flags.push("code-mapped");
          }
          if (!known && list.codes.some((x) => x.mapsTo !== undefined)) value = null;
        }
        assertions.push({
          property,
          ...(member ? { member } : {}),
          ...(c.language ? { qualifier: c.language } : {}),
          raw,
          value,
          unit: c.unit,
          source: { file: name, role: "erp", sha256: file.sha256, location: loc },
          flags,
        });
      }
    });
    failIf("semantics", errors);
    authorise(actor, name);
    return { ok: true, file, assertions, records };
  } catch (e) {
    if (e instanceof StageFailure) return { ok: false, file, stage: e.stage, errors: e.errors };
    throw e;
  }
}

// ---------- Laboratory and assessment JSON ----------

type Schema = Record<string, unknown>;

/** Checks the subset of JSON Schema the contract uses; reports every violation with its JSON pointer. */
function validate(schema: Schema, v: JsonValue, path: string, name: string, out: IngressIssue[]) {
  const at = `${name}, ${path || "/"}`;
  const typeOf = (x: JsonValue) => (x.kind === "number" && Number.isInteger(x.value) ? ["number", "integer"] : [x.kind]);
  if ("const" in schema && !(v.kind === "string" && v.value === schema.const)) {
    out.push(issue("structure", "schema", at, `Must be ${JSON.stringify(schema.const)}.`));
    return;
  }
  if (Array.isArray(schema.enum) && !(v.kind === "string" && schema.enum.includes(v.value))) {
    out.push(issue("structure", "schema", at, `Must be one of ${schema.enum.join(", ")}.`));
    return;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!typeOf(v).some((t) => types.includes(t))) {
      out.push(issue("structure", "schema", at, `Must be ${types.join(" or ")}, found ${v.kind}.`));
      return;
    }
  }
  if (v.kind === "number") {
    if (typeof schema.minimum === "number" && v.value < schema.minimum) out.push(issue("structure", "schema", at, `Must be at least ${schema.minimum}.`));
    if (typeof schema.exclusiveMinimum === "number" && v.value <= schema.exclusiveMinimum) out.push(issue("structure", "schema", at, `Must be more than ${schema.exclusiveMinimum}.`));
  }
  if (v.kind === "string" && typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(v.value)) {
    out.push(issue("structure", "schema", at, `Does not match ${schema.pattern}.`));
  }
  if (v.kind === "array" && schema.items) v.items.forEach((x, i) => validate(schema.items as Schema, x, `${path}/${i}`, name, out));
  if (v.kind === "object") {
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const k of (schema.required as string[] | undefined) ?? []) if (!v.entries.has(k)) out.push(issue("structure", "schema", at, `"${k}" is required.`));
    for (const [k, x] of v.entries) {
      if (props[k]) validate(props[k], x, `${path}/${k}`, name, out);
      else if (schema.additionalProperties === false) out.push(issue("structure", "schema", `${name}, ${path}/${k}`, `"${k}" is not allowed.`));
    }
  }
}

const get = (v: JsonValue, key: string): JsonValue => (v.kind === "object" ? (v.entries.get(key) ?? { kind: "null" }) : { kind: "null" });
const str = (v: JsonValue) => (v.kind === "string" ? v.value : v.kind === "number" ? v.raw : "");
const list = (v: JsonValue) => (v.kind === "array" ? v.items : []);

export async function importLabJson(
  pack: ProfilePack,
  input: { bytes: Uint8Array; name: string; type: string },
  actor = "ACT-01",
): Promise<ImportResult> {
  const contract = pack.inputs.lab;
  let file: SourceFile = { name: input.name, role: "lab", mediaType: input.type, sha256: "", size: input.bytes.length };
  try {
    const decoded = await bytesStage(input.bytes, input.name, input.type, "lab");
    file = decoded.file;
    const name = input.name;

    let doc: JsonValue;
    try {
      doc = parseStrictJson(decoded.text);
    } catch (e) {
      if (!(e instanceof JsonSyntaxError)) throw e;
      const code: IngressCode = e.code === "duplicate-key" ? "duplicate-key" : e.code === "non-finite-number" ? "non-finite-number" : "json-syntax";
      throw new StageFailure("parse", [issue("parse", code, `${name}, ${e.path || "/"}`, e.message)]);
    }

    const structure: IngressIssue[] = [];
    validate(contract.structure as Schema, doc, "", name, structure);
    failIf("structure", structure);

    const errors: IngressIssue[] = [];
    const assertions: Assertion[] = [];
    const src = (location: string) => ({ file: name, role: "lab" as const, sha256: file.sha256, location: `${name}, ${location}` });
    const product = get(doc, "product");
    const model = str(get(product, "model_id"));
    const batch = str(get(product, "batch_id"));
    // The lab file names the model, batch and alloy it reports on, so they become assertions too (FUNC-065).
    const reference = (key: string, property: string, member?: string) => {
      const raw = str(get(product, key));
      assertions.push({ property, ...(member ? { member } : {}), raw, value: raw, unit: null, source: src(`/product/${key}`), flags: ["declared"] });
    };
    reference("model_id", byRole(pack, "model"), "FLD-Identifier-value");
    reference("batch_id", byRole(pack, "batch"), "FLD-Identifier-value");
    reference("alloy", byRole(pack, "alloy"));

    const evidence = list(get(doc, "evidence"));
    const evidenceIds = new Set(evidence.map((e) => str(get(e, "evidence_id"))));
    const linked = (e: JsonValue, path: string, flags: Flag[]) => {
      const id = str(get(e, "evidence_id"));
      if (!evidenceIds.has(id)) errors.push(issue("semantics", "unknown-evidence", `${name}, ${path}/evidence_id`, `"${id}".`));
      else flags.push("evidence-linked");
    };
    const unitCheck = (property: string, unit: JsonValue, path: string) => {
      if (unit.kind === "null") {
        errors.push(issue("semantics", "missing-unit", `${name}, ${path}/unit`, `${property}.`));
        return false;
      }
      const allowed = contract.allowed_units[property] ?? [];
      if (!allowed.includes(str(unit))) {
        errors.push(issue("semantics", "wrong-unit", `${name}, ${path}/unit`, `"${str(unit)}" for ${property}; allowed: ${allowed.join(", ")}.`));
        return false;
      }
      return true;
    };

    list(get(doc, "observations")).forEach((o, i) => {
      const path = `/observations/${i}`;
      const property = str(get(o, "property"));
      const flags: Flag[] = ["measured", "unit-stated", "uncertainty-stated"];
      const unitOk = unitCheck(property, get(o, "unit"), path);
      linked(o, path, flags);
      if (!unitOk) return;
      const v = get(o, "value");
      const u = get(o, "uncertainty");
      if (v.kind === "number" && (v.value < 0 || (str(get(o, "unit")) === "%" && v.value > 100))) {
        errors.push(issue("semantics", "out-of-range", `${name}, ${path}/value`, `${v.raw} ${str(get(o, "unit"))}.`));
        return;
      }
      const element = str(get(o, "element"));
      assertions.push({
        property,
        ...(element ? { qualifier: element } : {}),
        raw: str(v),
        value: v.kind === "number" ? v.value : null,
        unit: str(get(o, "unit")),
        details: {
          observation_id: str(get(o, "observation_id")),
          method: str(get(o, "method")),
          expanded_uncertainty: str(get(u, "expanded")),
          coverage_factor: str(get(u, "coverage_factor")),
          uncertainty_kind: str(get(u, "uncertainty_kind")),
          evidence_id: str(get(o, "evidence_id")),
        },
        source: src(`${path}/value`),
        flags,
      });
    });

    const footprints = list(get(doc, "footprints"));
    footprints.forEach((f, i) => {
      const path = `/footprints/${i}`;
      const property = str(get(f, "property"));
      const flags: Flag[] = ["calculated-externally", "unit-stated"];
      if (footprints.length > 1) flags.push("several-results");
      const unitOk = unitCheck(property, get(f, "unit"), path);
      linked(f, path, flags);
      if (!unitOk) return;
      const v = get(f, "value");
      assertions.push({
        property,
        qualifier: str(get(f, "result_id")),
        raw: str(v),
        value: v.kind === "number" ? v.value : null,
        unit: str(get(f, "unit")),
        details: {
          method: str(get(f, "method")),
          system_boundary: str(get(f, "system_boundary")),
          reference_year: str(get(f, "reference_year")),
          calculated_by: str(get(f, "calculated_by")),
          evidence_id: str(get(f, "evidence_id")),
        },
        source: src(`${path}/value`),
        flags,
      });
    });

    const evidenceProperty = byRole(pack, "evidence");
    evidence.forEach((e, i) => {
      const digest = get(e, "digest");
      const flags: Flag[] = ["declared"];
      if (digest.kind === "null") flags.push("evidence-digest-missing");
      const id = str(get(e, "evidence_id"));
      assertions.push({
        property: evidenceProperty,
        qualifier: id,
        raw: id,
        value: id,
        unit: null,
        details: Object.fromEntries(["issuer", "revision", "record_kind", "scope", "digest", "access_policy_ref"].map((k) => [k, str(get(e, k))])),
        source: src(`/evidence/${i}`),
        flags,
      });
    });

    const narrativeProperty = byRole(pack, "narrative");
    list(get(doc, "texts")).forEach((t, i) => {
      const flags: Flag[] = ["declared"];
      if (str(get(t, "approval_state")) !== "approved") flags.push("draft-text");
      assertions.push({
        property: narrativeProperty,
        qualifier: `${str(get(t, "language"))}/${str(get(t, "sector"))}/${str(get(t, "market"))}`,
        raw: str(get(t, "text")),
        value: str(get(t, "text")),
        unit: null,
        details: Object.fromEntries(["text_id", "subject_ref", "language", "sector", "market", "approval_state", "revision"].map((k) => [k, str(get(t, k))])),
        source: src(`/texts/${i}/text`),
        flags,
      });
    });

    failIf("semantics", errors);
    authorise(actor, name);
    return { ok: true, file, assertions, records: [{ model, batch }] };
  } catch (e) {
    if (e instanceof StageFailure) return { ok: false, file, stage: e.stage, errors: e.errors };
    throw e;
  }
}

/**
 * Finds a property by the role its definition plays, so the import code names no identifier: the public
 * stand-in and the private pack number their properties differently (decision D1-01, option b).
 */
function byRole(pack: ProfilePack, role: "model" | "batch" | "alloy" | "evidence" | "narrative"): string {
  const slug = { model: "product-model-id", batch: "batch-id", alloy: "alloy-designation", evidence: "evidence-references", narrative: "product-narrative" }[role];
  const found = pack.properties.find((p) => p.definitionRef.endsWith(`:${slug}`));
  if (!found) throw new Error(`The profile has no ${role} property (${slug})`);
  return found.id;
}

// ---------- Record state ----------

export type ValueStatus = "single" | "agreeing" | "challenged";

export interface RecordValue {
  property: string;
  member?: string;
  qualifier?: string;
  status: ValueStatus;
  assertions: Assertion[];
}

export interface ProductRecord {
  model: string;
  batch: string;
  sources: SourceFile[];
  values: RecordValue[];
  /** sha256 of the canonical record state: the same files always give the same digest (C2-07). */
  digest: string;
}

export interface RecordState {
  records: ProductRecord[];
  /** Lab assertions about a model or batch the ERP extract does not contain; kept, not attached. */
  unattached: Assertion[];
}

const keyOf = (a: { property: string; member?: string; qualifier?: string }) => `${a.property}|${a.member ?? ""}|${a.qualifier ?? ""}`;

const same = (a: Assertion, b: Assertion) => (typeof a.value === "number" && typeof b.value === "number" ? a.value === b.value : a.raw === b.raw);

const canonical = (x: unknown): string =>
  Array.isArray(x)
    ? `[${x.map(canonical).join(",")}]`
    : x && typeof x === "object"
      ? `{${Object.keys(x)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(x);

/**
 * Combines accepted imports into one record per product model and batch (FUNC-065 references). When two
 * sources state different values for the same property, both stay and the value is challenged (C2-05).
 */
export async function buildRecords(results: ImportResult[]): Promise<RecordState> {
  const accepted = results.filter((r): r is Extract<ImportResult, { ok: true }> => r.ok);
  const erp = accepted.filter((r) => r.file.role === "erp");
  const lab = accepted.filter((r) => r.file.role === "lab");
  const records: ProductRecord[] = [];
  const unattached: Assertion[] = [];
  const attachedLab = new Set<Extract<ImportResult, { ok: true }>>();

  for (const e of erp) {
    for (const ref of e.records) {
      const rowAssertions = e.assertions.filter((a) => rowOf(a, e) === ref);
      const labs = lab.filter((l) => l.records[0].model === ref.model && l.records[0].batch === ref.batch);
      labs.forEach((l) => attachedLab.add(l));
      const all = [...rowAssertions, ...labs.flatMap((l) => l.assertions)];
      const groups = new Map<string, Assertion[]>();
      for (const a of all) groups.set(keyOf(a), [...(groups.get(keyOf(a)) ?? []), a]);
      const values: RecordValue[] = [...groups.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, as]) => {
          const status: ValueStatus = as.length === 1 ? "single" : as.every((a) => same(a, as[0])) ? "agreeing" : "challenged";
          const assertions = status === "challenged" ? as.map((a) => ({ ...a, flags: [...a.flags, "challenged" as Flag] })) : as;
          return { property: as[0].property, ...(as[0].member ? { member: as[0].member } : {}), ...(as[0].qualifier ? { qualifier: as[0].qualifier } : {}), status, assertions };
        });
      const sources = [e.file, ...labs.map((l) => l.file)];
      const state = { model: ref.model, batch: ref.batch, sources, values };
      records.push({ ...state, digest: await sha256Hex(canonical(state)) });
    }
  }
  for (const l of lab) if (!attachedLab.has(l)) unattached.push(...l.assertions);
  return { records, unattached };
}

/** The ERP row an assertion came from, as the record reference of that row. */
function rowOf(a: Assertion, e: Extract<ImportResult, { ok: true }>) {
  const row = Number(/row (\d+)/.exec(a.source.location)?.[1] ?? 0);
  return e.records[row - 2];
}
