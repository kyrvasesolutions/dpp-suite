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
import { canonical } from "./canonical";
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
  | "multiple-records"
  | "too-large"
  | "deadline"
  | "json-syntax"
  | "duplicate-key"
  | "too-deep"
  | "too-many-nodes"
  | "cancelled"
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
  | "precision-loss"
  | "duplicate-record"
  | "duplicate-id"
  | "padded-identifier"
  | "subject-mismatch"
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
  "multiple-records": "The extract has more than one data row. One import is one product record, so nothing is imported. Split the extract into one file per record.",
  "too-large": "The file is larger than the declared limit for a source file, so it was not read.",
  "deadline": "The import ran past its time limit and was stopped. Nothing is imported.",
  "too-deep": "The JSON is nested deeper than the declared limit.",
  "too-many-nodes": "The JSON holds more values than the declared limit, so it was not processed. Nothing is imported.",
  "cancelled": "The import was cancelled and stopped. Nothing is imported.",
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
  "precision-loss": "A number has more significant digits than can be kept exactly, or is too small to represent.",
  "duplicate-record": "Two rows describe the same product model and batch. Keep one row per batch.",
  "duplicate-id": "Two entries in the file have the same identifier, so it is unclear which one is meant.",
  "padded-identifier": "An identifier or code has spaces at its ends or invisible characters, so it would not match the same identifier written plainly.",
  "subject-mismatch": "A text is about another product model than the one this laboratory file reports on.",
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
  | "challenged"
  | "corrected"
  | "source-changed";

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
  "corrected": "Corrected by the operator: the earlier value stays visible",
  "source-changed": "The source now says something else than the value the operator corrected: both are kept until the operator decides",
};

/** The flag's text for the kind of file the value came from (the ERP text says "ERP extract", which is wrong for a laboratory value). */
export const flagTextFor = (flag: Flag, role: SourceRole): string =>
  flag === "declared" && role === "lab" ? "Declared in the laboratory file" : flag === "declared" && role === "correction" ? "Stated by the operator" : FLAG_TEXT[flag];

/** Where a source assertion comes from: an imported file, or an operator correction (Cycle 5). */
export type SourceRole = "erp" | "lab" | "correction";

export interface SourceFile {
  name: string;
  role: SourceRole;
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
  /** Where the text is; `row` is the ERP data row (1 for the first after the header), never parsed from text. */
  source: { file: string; role: SourceFile["role"]; sha256: string; location: string; row?: number };
  flags: Flag[];
  /** Only for an operator correction: the record version it made, who made it, and why. */
  correction?: { version: number; actor: string; reason: string };
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

/** The job deadline: checked at each stage boundary and inside the parsers, so a slow input stops with a bounded error. */
class Deadline {
  private readonly start: number;
  constructor(
    private readonly limitMs: number,
    private readonly clock: () => number,
    private readonly name: string,
    startedAt?: number,
  ) {
    // the deadline belongs to the job (the whole import of the pair), so a second file inherits the time the first one used
    this.start = startedAt ?? clock();
  }
  check(stage: Stage) {
    if (this.clock() - this.start > this.limitMs) {
      throw new StageFailure(stage, [issue(stage, "deadline", this.name, `The limit is ${this.limitMs / 1000} s.`)]);
    }
  }
}

/** Optional clock, so tests can run a job past its deadline without waiting for it. */
export interface ImportInput {
  bytes: Uint8Array;
  name: string;
  type: string;
  now?: () => number;
  /** When the job began, on the same clock: the deadline counts from here, not from this file. */
  startedAt?: number;
}

async function bytesStage(bytes: Uint8Array, name: string, declaredType: string, role: SourceFile["role"], maxBytes: number) {
  const expected = role === "erp" ? { type: "text/csv", ext: ".csv" } : { type: "application/json", ext: ".json" };
  // Browsers often send no type, or an Excel type for .csv, so the extension decides when the type is absent.
  // Windows browsers send application/vnd.ms-excel for .csv when Excel is installed.
  const tolerated = role === "erp" ? ["", "application/vnd.ms-excel"] : [""];
  const typeOk = declaredType === expected.type || (tolerated.includes(declaredType) && name.toLowerCase().endsWith(expected.ext));
  const extOk = name.toLowerCase().endsWith(expected.ext);
  failIf("bytes", typeOk && extOk ? [] : [issue("bytes", "media-type", name, `Expected ${expected.type} (${expected.ext}), got "${declaredType || "no type"}".`)]);
  failIf("bytes", bytes.length > maxBytes ? [issue("bytes", "too-large", name, `${bytes.length} bytes, the limit is ${maxBytes}.`)] : []);
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
function csvRows(text: string, delimiter: string, name: string, tick: () => void): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    if (i % 4096 === 0) tick();
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
  // Blank lines at the very end of the file are padding, not rows; a blank line between rows stays an error.
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  return rows;
}

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Characters that print as nothing: zero-width spaces and joiners, word joiner, byte order mark, soft hyphen. */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
/** The same set without the global flag, for test(), which would otherwise keep state between calls. */
const HAS_INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/;

/**
 * Whether a number literal survives as a double without changing: at most 15 significant digits, and no
 * nonzero literal that underflows to 0. Longer numbers would be silently rounded (re-assessment R2-5).
 */
function exact(raw: string) {
  const mantissa = raw.replace(/^-/, "").split(/[eE]/)[0].replace(".", "").replace(/^0+/, "");
  const digits = mantissa.replace(/0+$/, "").length;
  return digits <= 15 && !(Number(raw) === 0 && /[1-9]/.test(mantissa));
}

/** Physical range of a value by unit: lengths, masses and strengths are positive; shares lie in 0..100 %. */
function inRange(value: number, unit: string) {
  if (unit === "%") return value >= 0 && value <= 100;
  if (unit === "mm" || unit === "kg" || unit === "MPa") return value > 0;
  return value >= 0;
}
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
  input: ImportInput,
  actor = "ACT-01",
): Promise<ImportResult> {
  const contract = pack.inputs.erp;
  const limits = pack.policy.limits;
  const deadline = new Deadline(limits.job_deadline_ms, input.now ?? (() => performance.now()), input.name, input.startedAt);
  let file: SourceFile = { name: input.name, role: "erp", mediaType: input.type, sha256: "", size: input.bytes.length };
  try {
    deadline.check("bytes");
    const decoded = await bytesStage(input.bytes, input.name, input.type, "erp", limits.max_file_bytes);
    file = decoded.file;
    const name = input.name;

    // parse
    deadline.check("parse");
    const rows = csvRows(decoded.text, contract.delimiter, name, () => deadline.check("parse"));
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
    if (body.length > limits.max_erp_data_rows) {
      structure.push(issue("structure", "multiple-records", `${name}, row ${limits.max_erp_data_rows + 2}`, `${body.length} data rows, the limit is ${limits.max_erp_data_rows}.`));
    }
    failIf("structure", structure);

    // semantics
    deadline.check("semantics");
    const at = (row: number, col: string) => `${name}, row ${row}, column ${col}`;
    const assertions: Assertion[] = [];
    const errors: IngressIssue[] = [];
    const records: Array<{ model: string; batch: string }> = [];
    const seenRecords = new Map<string, number>();
    body.forEach((r, i) => {
      const rowNo = i + 2;
      const cell = Object.fromEntries(header.map((h, j) => [h, r[j]]));
      const key = `${cell.product_model_id}|${cell.batch_id}`;
      if (seenRecords.has(key)) {
        errors.push(issue("semantics", "duplicate-record", `${name}, row ${rowNo}`, `Same model and batch as row ${seenRecords.get(key)}.`));
      }
      seenRecords.set(key, rowNo);
      records.push({ model: cell.product_model_id, batch: cell.batch_id });
      for (const c of contract.columns) {
        const raw = cell[c.name];
        const loc = at(rowNo, c.name);
        if (raw.replace(INVISIBLE, "").trim() === "") {
          // A value of only spaces is as empty as no value; an optional one is simply absent.
          if (c.required) errors.push(issue("semantics", "missing-value", loc, raw === "" ? undefined : "The cell holds only spaces."));
          continue;
        }
        const [property, member] = c.maps_to.split("/");
        if ((c.code_list || member?.startsWith("FLD-Identifier-")) && (raw !== raw.trim() || HAS_INVISIBLE.test(raw))) {
          errors.push(issue("semantics", "padded-identifier", loc, JSON.stringify(raw)));
          continue;
        }
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
          if (!exact(raw)) {
            errors.push(issue("semantics", "precision-loss", loc, `"${raw}".`));
            continue;
          }
          value = Number(raw);
          if (!inRange(value, c.unit)) {
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
          source: { file: name, role: "erp", sha256: file.sha256, location: loc, row: i + 1 },
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
      if (Object.hasOwn(props, k)) validate(props[k], x, `${path}/${k}`, name, out);
      else if (schema.additionalProperties === false) out.push(issue("structure", "schema", `${name}, ${path}/${k}`, `"${k}" is not allowed.`));
    }
  }
}

const get = (v: JsonValue, key: string): JsonValue => (v.kind === "object" ? (v.entries.get(key) ?? { kind: "null" }) : { kind: "null" });
const str = (v: JsonValue) => (v.kind === "string" ? v.value : v.kind === "number" ? v.raw : "");
const list = (v: JsonValue) => (v.kind === "array" ? v.items : []);

export async function importLabJson(
  pack: ProfilePack,
  input: ImportInput,
  actor = "ACT-01",
): Promise<ImportResult> {
  const contract = pack.inputs.lab;
  const limits = pack.policy.limits;
  const deadline = new Deadline(limits.job_deadline_ms, input.now ?? (() => performance.now()), input.name, input.startedAt);
  let file: SourceFile = { name: input.name, role: "lab", mediaType: input.type, sha256: "", size: input.bytes.length };
  try {
    deadline.check("bytes");
    const decoded = await bytesStage(input.bytes, input.name, input.type, "lab", limits.max_file_bytes);
    file = decoded.file;
    const name = input.name;

    let doc: JsonValue;
    try {
      deadline.check("parse");
      doc = parseStrictJson(decoded.text, { maxDepth: limits.max_json_depth, tick: () => deadline.check("parse") });
    } catch (e) {
      if (!(e instanceof JsonSyntaxError)) throw e;
      const code: IngressCode = e.code === "duplicate-key" ? "duplicate-key" : e.code === "non-finite-number" ? "non-finite-number" : e.code === "too-deep" ? "too-deep" : "json-syntax";
      throw new StageFailure("parse", [issue("parse", code, `${name}, ${e.path || "/"}`, e.message)]);
    }

    deadline.check("structure");
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
      // The same rule as for identifiers in the ERP extract: padding would keep the value from matching its record.
      if (key !== "alloy" && (raw !== raw.trim() || HAS_INVISIBLE.test(raw))) {
        errors.push(issue("semantics", "padded-identifier", `${name}, /product/${key}`, JSON.stringify(raw)));
        return;
      }
      assertions.push({ property, ...(member ? { member } : {}), raw, value: raw, unit: null, source: src(`/product/${key}`), flags: ["declared"] });
    };
    reference("model_id", byRole(pack, "model"), "FLD-Identifier-value");
    reference("batch_id", byRole(pack, "batch"), "FLD-Identifier-value");
    reference("alloy", byRole(pack, "alloy"));

    const evidence = list(get(doc, "evidence"));
    const evidenceIds = new Set(evidence.map((e) => str(get(e, "evidence_id"))));
    // Identifiers inside the file must be unique, or two entries would silently share one identity.
    const unique = (items: JsonValue[], key: string, path: string) => {
      const seen = new Map<string, number>();
      items.forEach((x, i) => {
        const id = str(get(x, key));
        if (seen.has(id)) errors.push(issue("semantics", "duplicate-id", `${name}, ${path}/${i}/${key}`, `"${id}" also at ${path}/${seen.get(id)}.`));
        seen.set(id, i);
      });
    };
    unique(evidence, "evidence_id", "/evidence");
    unique(list(get(doc, "observations")), "observation_id", "/observations");
    unique(list(get(doc, "footprints")), "result_id", "/footprints");
    unique(list(get(doc, "texts")), "text_id", "/texts");
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
      if (v.kind === "number" && !exact(v.raw)) {
        errors.push(issue("semantics", "precision-loss", `${name}, ${path}/value`, `"${v.raw}".`));
        return;
      }
      if (v.kind === "number" && !inRange(v.value, str(get(o, "unit")))) {
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
      if (v.kind === "number" && !exact(v.raw)) {
        errors.push(issue("semantics", "precision-loss", `${name}, ${path}/value`, `"${v.raw}".`));
        return;
      }
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
      const subject = str(get(t, "subject_ref"));
      if (subject !== model) errors.push(issue("semantics", "subject-mismatch", `${name}, /texts/${i}/subject_ref`, `"${subject}" is not "${model}".`));
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

const ROLE_SLUGS = {
  model: "product-model-id",
  name: "product-name",
  batch: "batch-id",
  alloy: "alloy-designation",
  temper: "temper-designation",
  footprint: "carbon-footprint",
  evidence: "evidence-references",
  narrative: "product-narrative",
} as const;
export type Role = keyof typeof ROLE_SLUGS;

/**
 * Finds a property by the role its definition plays, so no code names an identifier: the public
 * stand-in and the private pack number their properties differently (decision D1-01, option b).
 */
export function byRole(pack: ProfilePack, role: Role): string {
  const slug = ROLE_SLUGS[role];
  const found = pack.properties.find((p) => p.definitionRef.endsWith(`:${slug}`));
  if (!found) throw new Error(`The profile has no ${role} property (${slug})`);
  return found.id;
}

// ---------- Record state ----------

export type ValueStatus = "single" | "agreeing" | "challenged" | "corrected";

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

export const sameAssertion = (a: Assertion, b: Assertion) =>
  typeof a.value === "number" && typeof b.value === "number" ? a.value === b.value : a.raw === b.raw;
const same = (a: Assertion, b: Assertion) => (typeof a.value === "number" && typeof b.value === "number" ? a.value === b.value : a.raw === b.raw);

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
      const rowAssertions = e.assertions.filter((a) => a.source.row !== undefined && e.records[a.source.row - 1] === ref);
      const labs = lab.filter((l) => l.records[0].model === ref.model && l.records[0].batch === ref.batch);
      labs.forEach((l) => attachedLab.add(l));
      const all = [...rowAssertions, ...labs.flatMap((l) => l.assertions)];
      const groups = new Map<string, Assertion[]>();
      for (const a of all) groups.set(keyOf(a), [...(groups.get(keyOf(a)) ?? []), a]);
      const values: RecordValue[] = [...groups.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, as]) => {
          const status: ValueStatus = valueStatus(as);
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

/** How many assertions say the same: one value, several that agree, or several that differ (C2-05). */
export const valueStatus = (assertions: Assertion[]): ValueStatus =>
  assertions.some((a) => a.flags.includes("source-changed")) ? "challenged" : assertions.some((a) => a.flags.includes("corrected")) ? "corrected" : assertions.length === 1 ? "single" : assertions.every((a) => same(a, assertions[0])) ? "agreeing" : "challenged";

/**
 * Re-checks a stored record against the pinned pack the way ingress checked the files (Cycle 4, central-record import):
 * the status of every value and the flags of every assertion are derived again from the assertions, codes are looked up
 * in the pinned code lists, numbers must be literal numbers in their physical range, units must be the contract's, and
 * every assertion must name a column or a place the contract has and a source file the record lists. It cannot tell a
 * value that was changed to another valid value: only signing could (out of scope). Returns every problem found.
 */
export function recheckRecord(pack: ProfilePack, record: ProductRecord): string[] {
  const problems: string[] = [];
  const props = new Map(pack.properties.map((p) => [p.id, p]));
  const evidenceProperty = byRole(pack, "evidence");
  const narrativeProperty = byRole(pack, "narrative");
  const footprintProperty = byRole(pack, "footprint");
  const evidenceIds = new Set(record.values.filter((v) => v.property === evidenceProperty).map((v) => v.qualifier));
  const footprintResults = record.values.filter((v) => v.property === footprintProperty && !v.member).flatMap((v) => v.assertions).filter((a) => a.source.role !== "correction").length;
  const erpColumns = new Map(pack.inputs.erp.columns.map((c) => [c.name, c]));

  for (const v of record.values) {
    const where = `${v.property}${v.member ? `/${v.member}` : ""}${v.qualifier ? ` (${v.qualifier})` : ""}`;
    const prop = props.get(v.property);
    if (!prop) {
      problems.push(`${where}: not a property of the profile`);
      continue;
    }
    if (v.member && !prop.members.some((m) => m.id === v.member)) problems.push(`${where}: not a member of the property`);
    const status = valueStatus(v.assertions);
    if (v.status !== status) problems.push(`${where}: status is ${v.status}, the assertions make it ${status}`);

    for (const a of v.assertions) {
      const at = `${where} at ${a.source.location}`;
      if (a.property !== v.property || a.member !== v.member || a.qualifier !== v.qualifier) problems.push(`${at}: the assertion is filed under another key`);
      if (!v.assertions.some((x) => x.source.role === "correction") && a.flags.includes("challenged") !== (status === "challenged")) problems.push(`${at}: the challenged flag does not match the status`);
      if (!record.sources.some((s) => s.name === a.source.file && s.role === a.source.role && s.sha256 === a.source.sha256)) problems.push(`${at}: its source file is not listed in the record`);
      if (!a.source.location.startsWith(`${a.source.file}, `)) problems.push(`${at}: the location is not in its source file`);
      if (a.source.role === "correction") {
        problems.push(...recheckCorrection(pack, v, a, at));
        continue;
      }
      const expected = new Set<Flag>();
      const rest = a.source.location.slice(a.source.file.length + 2);

      if (a.source.role === "erp") {
        const m = /^row (\d+), column (.+)$/.exec(rest);
        const c = m ? erpColumns.get(m[2]) : undefined;
        if (!m || !c) {
          problems.push(`${at}: not a column of the ERP contract`);
          continue;
        }
        const [cp, cm] = c.maps_to.split("/");
        if (cp !== a.property || cm !== a.member || c.language !== a.qualifier) problems.push(`${at}: the column maps to ${c.maps_to}, not to this value`);
        if (a.source.row !== Number(m[1]) - 1) problems.push(`${at}: the row does not match the location`);
        if (a.raw.replace(INVISIBLE, "").trim() === "") problems.push(`${at}: an empty value`);
        if ((c.code_list || cm?.startsWith("FLD-Identifier-")) && (a.raw !== a.raw.trim() || HAS_INVISIBLE.test(a.raw))) problems.push(`${at}: a padded identifier`);
        expected.add("declared");
        let value: string | number | null = a.raw;
        if (c.unit) {
          if (!DECIMAL.test(a.raw) || !exact(a.raw)) problems.push(`${at}: "${a.raw}" is not a literal number`);
          else {
            value = Number(a.raw);
            if (!inRange(value, c.unit)) problems.push(`${at}: ${a.raw} ${c.unit} is out of range`);
          }
          expected.add("unit-from-contract");
        }
        if (a.unit !== (c.unit ?? null)) problems.push(`${at}: the unit is ${a.unit}, the contract says ${c.unit ?? "none"}`);
        if (c.format === "ISO 8601 date" && !isCalendarDate(a.raw)) problems.push(`${at}: not a calendar date`);
        const list = codeListOf(pack, c.code_list);
        if (list) {
          const known = list.codes.find((x) => x.code === a.raw);
          if (!known) expected.add("unknown-code");
          else if (known.mapsTo !== undefined) {
            value = known.mapsTo;
            expected.add("code-mapped");
          }
          if (!known && list.codes.some((x) => x.mapsTo !== undefined)) value = null;
        }
        if (a.value !== value) problems.push(`${at}: the value is ${JSON.stringify(a.value)}, the source text gives ${JSON.stringify(value)}`);
      } else {
        const pointer = rest;
        const kind = /^\/(product|observations|footprints|evidence|texts)(\/|$)/.exec(pointer)?.[1];
        if (!kind) {
          problems.push(`${at}: not a place the laboratory contract has`);
          continue;
        }
        const linked = () => {
          const id = a.details?.evidence_id;
          if (id !== undefined && evidenceIds.has(id)) expected.add("evidence-linked");
          else problems.push(`${at}: names evidence ${JSON.stringify(id)}, which the record does not hold`);
        };
        // The same JSON-Schema rules and enums the laboratory contract applies at ingress, on the object this assertion stands for
        const schemaCheck = () => {
          const groups: Record<string, string> = { observations: "observations", footprints: "footprints", evidence: "evidence", texts: "texts" };
          const structure = pack.inputs.lab.structure as { properties?: Record<string, { items?: Schema }> };
          const itemSchema = structure.properties?.[groups[kind!]]?.items;
          if (!itemSchema) return;
          const props = (itemSchema.properties ?? {}) as Record<string, Schema>;
          const d = a.details ?? {};
          const typed = (key: string, text: string | undefined): JsonValue => {
            const types = ([] as string[]).concat((props[key]?.type as string | string[] | undefined) ?? []);
            if (text === undefined) return { kind: "null" };
            if (types.includes("null") && text === "") return { kind: "null" };
            if ((types.includes("number") || types.includes("integer")) && text.trim() !== "" && Number.isFinite(Number(text))) return { kind: "number", value: Number(text), raw: text };
            return { kind: "string", value: text };
          };
          const entries = new Map<string, JsonValue>();
          const put = (key: string, text: string | undefined) => text !== undefined && entries.set(key, typed(key, text));
          if (kind === "observations") {
            put("observation_id", d.observation_id);
            put("property", a.property);
            if (a.qualifier !== undefined) put("element", a.qualifier);
            entries.set("value", typeof a.value === "number" ? { kind: "number", value: a.value, raw: a.raw } : { kind: "string", value: a.raw });
            put("unit", a.unit ?? undefined);
            const num = (t: string | undefined): JsonValue => (t !== undefined && t.trim() !== "" && Number.isFinite(Number(t)) ? { kind: "number", value: Number(t), raw: t } : { kind: "string", value: t ?? "" });
            entries.set("uncertainty", { kind: "object", entries: new Map<string, JsonValue>([["expanded", num(d.expanded_uncertainty)], ["coverage_factor", num(d.coverage_factor)], ["uncertainty_kind", { kind: "string", value: d.uncertainty_kind ?? "" }]]) });
            put("method", d.method);
            put("evidence_id", d.evidence_id);
          } else if (kind === "footprints") {
            put("result_id", a.qualifier);
            put("property", a.property);
            entries.set("value", typeof a.value === "number" ? { kind: "number", value: a.value, raw: a.raw } : { kind: "string", value: a.raw });
            put("unit", a.unit ?? undefined);
            for (const k of ["method", "system_boundary", "reference_year", "calculated_by", "evidence_id"]) put(k, d[k]);
          } else if (kind === "evidence") {
            put("evidence_id", a.raw);
            for (const k of ["issuer", "revision", "record_kind", "scope", "digest", "access_policy_ref"]) put(k, d[k]);
          } else {
            for (const k of ["text_id", "subject_ref", "language", "sector", "market", "approval_state", "revision"]) put(k, d[k]);
            put("text", a.raw);
          }
          const issues: IngressIssue[] = [];
          validate(itemSchema, { kind: "object", entries }, "", "record", issues);
          for (const i of issues) problems.push(`${at}: breaks the laboratory contract: ${i.message}`);
        };
        const number = () => {
          if (a.value === null) return;
          if (typeof a.value !== "number" || !Number.isFinite(a.value) || Number(a.raw) !== a.value || !exact(a.raw)) problems.push(`${at}: "${a.raw}" is not the literal of its number`);
        };
        const unit = () => {
          if (!(pack.inputs.lab.allowed_units[a.property] ?? []).includes(a.unit ?? "")) problems.push(`${at}: the unit ${a.unit} is not allowed for ${a.property}`);
        };
        if (kind !== "product") schemaCheck();
        if (kind === "product") {
          expected.add("declared");
          if (a.value !== a.raw) problems.push(`${at}: the value differs from its text`);
        } else if (kind === "observations") {
          for (const f of ["measured", "unit-stated", "uncertainty-stated"] as Flag[]) expected.add(f);
          linked();
          unit();
          number();
          if (typeof a.value === "number" && a.unit && !inRange(a.value, a.unit)) problems.push(`${at}: ${a.raw} ${a.unit} is out of range`);
        } else if (kind === "footprints") {
          for (const f of ["calculated-externally", "unit-stated"] as Flag[]) expected.add(f);
          if (footprintResults > 1) expected.add("several-results");
          if (a.property !== footprintProperty) problems.push(`${at}: not the footprint property`);
          linked();
          unit();
          number();
        } else if (kind === "evidence") {
          expected.add("declared");
          if (a.property !== evidenceProperty) problems.push(`${at}: not the evidence property`);
          if ((a.details?.digest ?? "") === "") expected.add("evidence-digest-missing");
          if (a.value !== a.raw || a.qualifier !== a.raw) problems.push(`${at}: the identifier differs from its text`);
        } else {
          expected.add("declared");
          if (a.property !== narrativeProperty) problems.push(`${at}: not the narrative property`);
          if (a.details?.approval_state !== "approved") expected.add("draft-text");
          if (a.value !== a.raw) problems.push(`${at}: the value differs from its text`);
          if (a.qualifier !== `${a.details?.language}/${a.details?.sector}/${a.details?.market}`) problems.push(`${at}: the qualifier does not match the text's language, sector and market`);
        }
      }
      const have = a.flags.filter((f) => f !== "challenged" && f !== "source-changed");
      const sameFlags = have.length === expected.size && have.every((f) => expected.has(f));
      if (!sameFlags) problems.push(`${at}: the flags are [${have.join(", ")}], the contract gives [${[...expected].join(", ")}]`);
    }
  }
  return problems;
}

// ---------- Operator correction (Cycle 5) ----------

/** The assertion a correction is measured against: the first one that came from a file, never an earlier correction. */
export const baseAssertion = (v: RecordValue): Assertion | undefined => v.assertions.find((a) => a.source.role !== "correction");

/**
 * Checks a corrected value the way ingress checked the original: the same kind of text, a plain number in its range and unit,
 * a date that exists, and for a coded column a code the pinned list already has (a correction never adds a code).
 * Returns the value to store, or the reason it is refused.
 */
export function checkCorrectedValue(pack: ProfilePack, base: Assertion, raw: string): { ok: true; value: string | number | null } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (raw.replace(INVISIBLE, "").trim() === "") return no("The corrected value is empty.");
  if (raw !== raw.trim() || HAS_INVISIBLE.test(raw)) return no("The corrected value has spaces at its ends or invisible characters.");
  if (/[\u0000-\u001f\u007f]/.test(raw)) return no("The corrected value has a control character or a line break.");
  let value: string | number | null = raw;
  const unit = base.unit;
  const rest = base.source.location.slice(base.source.file.length + 2);
  const column = base.source.role === "erp" ? pack.inputs.erp.columns.find((c) => c.name === /^row \d+, column (.+)$/.exec(rest)?.[1]) : undefined;
  if (unit !== null) {
    if (DECIMAL_COMMA.test(raw)) return no("The corrected value uses a decimal comma; the contract requires a point.");
    if (!DECIMAL.test(raw)) return no("The corrected value is not a plain number with a point as decimal separator.");
    if (!exact(raw)) return no("The corrected number has more significant digits than can be kept exactly.");
    value = Number(raw);
    if (!inRange(value, unit)) return no(`The corrected value is outside its possible range for ${unit}.`);
  }
  if (column) {
    if (column.format === "ISO 8601 date" && !isCalendarDate(raw)) return no("The corrected value is not a real calendar date in the form YYYY-MM-DD.");
    const list = codeListOf(pack, column.code_list);
    if (list) {
      const known = list.codes.find((x) => x.code === raw);
      if (!known) return no("The corrected value is not in the pinned code list; a correction cannot add a code.");
      if (known.mapsTo !== undefined) value = known.mapsTo;
    }
  }
  return { ok: true, value };
}

/** What a stored operator-correction assertion must satisfy: its fixed shape, and a value that passes the same checks. */
function recheckCorrection(pack: ProfilePack, v: RecordValue, a: Assertion, at: string): string[] {
  const problems: string[] = [];
  const c = a.correction;
  if (!c || !Number.isInteger(c.version) || c.version < 2 || c.actor !== "ACT-01" || c.reason.trim() === "") return [`${at}: a correction needs its version, its actor and a reason`];
  if (a.source.file !== `Operator correction v${c.version}`) problems.push(`${at}: the correction is named for another version`);
  if (a.flags.length !== 1 || a.flags[0] !== "corrected") problems.push(`${at}: a correction carries exactly the corrected flag`);
  if (v.assertions[0] !== a && v.assertions.findIndex((x) => x.source.role !== "correction") < v.assertions.indexOf(a)) problems.push(`${at}: a correction comes before the values it replaces`);
  const base = baseAssertion(v);
  if (!base) return [...problems, `${at}: a correction with nothing to correct`];
  const checked = checkCorrectedValue(pack, base, a.raw);
  if (!checked.ok) problems.push(`${at}: ${checked.reason}`);
  else if (a.value !== checked.value) problems.push(`${at}: the value is ${JSON.stringify(a.value)}, the corrected text gives ${JSON.stringify(checked.value)}`);
  if (a.unit !== base.unit) problems.push(`${at}: the unit differs from the value it corrects`);
  if (JSON.stringify(a.details ?? null) !== JSON.stringify(base.details ?? null)) problems.push(`${at}: the details differ from the value it corrects`);
  return problems;
}
