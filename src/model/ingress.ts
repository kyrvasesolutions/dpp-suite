/**
 * Strict import of the two fixed N source files (Cycle 2: FUNC-039, FUNC-125 import side;
 * aligned in Cycle 9 to SRC-ERP-CSV-01 comma-delimited 21-column extract and SRC-LAB-JSON-01
 * with MAP-IMP-ERP-01 / MAP-IMP-LAB-01 and REC-ALU-24-01 DPPPayload).
 *
 * Retains every Cycle 2/5/8 ingress security & limit guard: bytes/UTF-8/BOM check, strict JSON
 * duplicate-key & non-finite rejection, depth/node/field-length/identifier allow-list caps,
 * cooperative cancellation & job deadline, and deterministic record digesting.
 */
import { canonical } from "./canonical";
import { JsonSyntaxError, parseStrictJson, toPlain, type JsonValue } from "./strictJson";
import { sha256Hex, type CodeList, type ProfilePack } from "./profile";
import { checkBoundedSchema } from "./recordSchemaCheck";
import { importReferencePair, type DppPayloadRecord, type ReferenceImportStatus } from "./referencePipeline";

export const STAGES = ["bytes", "parse", "structure", "semantics", "authorisation", "route"] as const;
export type Stage = (typeof STAGES)[number];

export type IngressCode =
  | "media-type"
  | "byte-order-mark"
  | "wrong-encoding"
  | "control-character"
  | "unsafe-identifier"
  | "field-too-long"
  | "execution-failed"
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
  | "unknown-code"
  | "unknown-evidence"
  | "precision-loss"
  | "duplicate-record"
  | "duplicate-id"
  | "padded-identifier"
  | "subject-mismatch"
  | "not-authorised";

export const ERROR_TEXT: Record<IngressCode, string> = {
  "media-type": "The file is not of the expected type. Use the ERP extract as .csv and the laboratory file as .json.",
  "byte-order-mark": "The file starts with a byte order mark. Save it as UTF-8 without BOM.",
  "unsafe-identifier": "An identifier or code contains a character that is not plain printable ASCII (a control, direction, invisible, combining or look-alike character), or is longer than the declared limit.",
  "execution-failed": "The import could not be processed and was stopped. Nothing is imported.",
  "field-too-long": "A text in the file is longer than the declared limit for one field, so the file was not read further. Nothing is imported.",
  "control-character": "The file contains a control character (for example a NUL) inside a value. Remove it and export the file again.",
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
  "out-of-range": "A value is outside its possible range, such as a non-positive dimension or a share over 100 %.",
  "invalid-date": "A date is not a real calendar date in the form YYYY-MM-DD.",
  "missing-unit": "A measured value has no unit. It is not accepted as unitless.",
  "wrong-unit": "A measured value has a unit the contract does not allow for this property. Nothing is converted.",
  "unknown-code": "The company/code-list/material code lookup is unknown or ambiguous.",
  "unknown-evidence": "A value refers to an evidence record that the file does not contain.",
  "precision-loss": "A number has more significant digits than can be kept exactly, or is too small to represent.",
  "duplicate-record": "Two rows describe the same product model and batch. Keep one row per batch.",
  "duplicate-id": "Two entries in the file have the same identifier, so it is unclear which one is meant.",
  "padded-identifier": "An identifier or code has spaces at its ends or invisible characters, so it would not match the same identifier written plainly.",
  "subject-mismatch": "A text is about another product model/revision than the one this record reports on.",
  "not-authorised": "This role may not import source files.",
};

export interface IngressIssue {
  stage: Stage;
  code: IngressCode;
  message: string;
  location: string;
}

export type Flag =
  | "declared"
  | "measured"
  | "calculated-externally"
  | "unit-from-contract"
  | "unit-stated"
  | "wrong-unit"
  | "uncertainty-stated"
  | "evidence-linked"
  | "evidence-digest-missing"
  | "source-assurance-unaccepted"
  | "code-mapped"
  | "unknown-code"
  | "several-results"
  | "draft-text"
  | "challenged"
  | "corrected"
  | "source-changed"
  | "shape-issue";

export const FLAG_TEXT: Record<Flag, string> = {
  declared: "Declared in the ERP extract",
  measured: "Measured by the laboratory",
  "calculated-externally": "Calculated outside this tool and imported as is",
  "unit-from-contract": "Unit given by the ERP contract column",
  "unit-stated": "Unit stated in the source",
  "wrong-unit": "Measurement unit incompatible with the target route contract",
  "uncertainty-stated": "Measurement uncertainty stated",
  "evidence-linked": "Linked to an evidence record",
  "evidence-digest-missing": "Evidence record has no digest",
  "source-assurance-unaccepted": "Source assurance state does not satisfy the pinned profile policy",
  "code-mapped": "Company code mapped through the pinned code list",
  "unknown-code": "Code not in the pinned code list: kept as given",
  "several-results": "Several results and no rule to select one",
  "draft-text": "Text not authorised for release",
  challenged: "The sources disagree or a challenge is open: both assertions are kept",
  corrected: "Corrected by the operator: the earlier value stays visible",
  "source-changed": "The source now says something else than the value the operator corrected: both are kept until the operator decides",
  "shape-issue": "Selected-record structural shape issue detected against record.schema.json",
};

export const flagTextFor = (flag: Flag, role: SourceRole): string =>
  flag === "declared" && role === "lab"
    ? "Declared in the laboratory file"
    : flag === "declared" && role === "correction"
      ? "Stated by the operator"
      : FLAG_TEXT[flag];

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
  qualifier?: string;
  raw: string;
  value: string | number | null;
  unit: string | null;
  details?: Record<string, string>;
  source: { file: string; role: SourceFile["role"]; sha256: string; location: string; row?: number };
  flags: Flag[];
  correction?: { version: number; actor: string; reason: string };
}

export type ImportResult =
  | {
      ok: true;
      importStatus: ReferenceImportStatus;
      file: SourceFile;
      assertions: Assertion[];
      records: Array<{ model: string; batch: string; revision?: string }>;
      /** Raw UTF-8 text preserved for REC-ALU-24-01 DPPPayload construction (not serialised into public logs). */
      rawText?: string;
      /** Parsed plain JSON object for lab imports (used to construct REC-ALU-24-01 DPPPayload). */
      parsedLab?: Record<string, unknown>;
    }
  | { ok: false; importStatus: "REJECT"; file: SourceFile; stage: Stage; errors: IngressIssue[]; rawText?: string };

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

class Deadline {
  private readonly start: number;
  constructor(
    private readonly limitMs: number,
    private readonly clock: () => number,
    private readonly name: string,
    startedAt?: number,
    private readonly budget?: IngressBudget,
  ) {
    this.start = startedAt ?? clock();
  }
  check(stage: Stage) {
    this.budget?.check(stage);
    if (this.clock() - this.start > this.limitMs) {
      throw new StageFailure(stage, [issue(stage, "deadline", this.name, `The limit is ${this.limitMs / 1000} s.`)]);
    }
  }
}

export interface IngressBudget {
  check(stage: string): void;
}

export interface IngressLimits {
  maxFileBytes?: number;
  maxJsonDepth?: number;
  maxRows?: number;
  maxParserNodes?: number;
  deadlineMs?: number;
}

export interface ImportInput {
  bytes: Uint8Array;
  name: string;
  type: string;
  now?: () => number;
  startedAt?: number;
  budget?: IngressBudget;
  limits?: IngressLimits;
}

function effectiveLimits(pinned: ProfilePack["policy"]["limits"], over: IngressLimits | undefined) {
  return {
    ...pinned,
    ...(over?.maxFileBytes !== undefined ? { max_file_bytes: over.maxFileBytes } : {}),
    ...(over?.maxJsonDepth !== undefined ? { max_json_depth: over.maxJsonDepth } : {}),
    ...(over?.maxRows !== undefined ? { max_erp_data_rows: over.maxRows } : {}),
    ...(over?.deadlineMs !== undefined ? { job_deadline_ms: over.deadlineMs } : {}),
  };
}

export const ingressIssue = (stage: Stage, code: IngressCode, location: string, detail?: string): IngressIssue => issue(stage, code, location, detail);

export function firstInvalidUtf8(b: Uint8Array): number {
  let i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i]!;
    if (c < 0x80) {
      i++;
      continue;
    }
    let need: number;
    let min: number;
    let cp: number;
    if (c >= 0xc2 && c <= 0xdf) [need, min, cp] = [1, 0x80, c & 0x1f];
    else if (c >= 0xe0 && c <= 0xef) [need, min, cp] = [2, 0x800, c & 0x0f];
    else if (c >= 0xf0 && c <= 0xf4) [need, min, cp] = [3, 0x10000, c & 0x07];
    else return i;
    for (let k = 1; k <= need; k++) {
      const x = b[i + k];
      if (x === undefined || (x & 0xc0) !== 0x80) return i;
      cp = (cp << 6) | (x & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i;
    i += need + 1;
  }
  return n;
}

async function bytesStage(bytes: Uint8Array, name: string, declaredType: string, role: SourceFile["role"], maxBytes: number) {
  const expected = role === "erp" ? { type: "text/csv", ext: ".csv" } : { type: "application/json", ext: ".json" };
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
    const at = firstInvalidUtf8(bytes);
    throw new StageFailure("bytes", [issue("bytes", "wrong-encoding", `${name}, byte ${at}`)]);
  }
  const file: SourceFile = { name, role, mediaType: expected.type, sha256: await sha256Hex(text), size: bytes.length };
  return { text, file };
}

function authorise(actor: string, name: string) {
  failIf("authorisation", (IMPORT_ROLES as readonly string[]).includes(actor) ? [] : [issue("authorisation", "not-authorised", name, `Role ${actor}.`)]);
}

function csvRows(text: string, delimiter: string, name: string, tick: () => void): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let runStart = -1;
  const flush = (end: number) => {
    if (runStart >= 0) {
      field += text.slice(runStart, end);
      runStart = -1;
    }
  };
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    if (i % 4096 === 0) tick();
    const c = text[i]!;
    if (c < " " && c !== delimiter && c !== "\n" && c !== "\r") {
      throw new StageFailure("parse", [issue("parse", "control-character", `${name}, line ${line}`)]);
    }
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        flush(i);
        field += '"';
        i++;
      } else if (c === '"') {
        flush(i);
        quoted = false;
        const next = text[i + 1];
        if (next !== undefined && next !== delimiter && next !== "\n" && next !== "\r") {
          throw new StageFailure("parse", [issue("parse", "csv-syntax", `${name}, line ${line}`, "Text after a closing quote.")]);
        }
      } else {
        if (c === "\n") line++;
        if (runStart < 0) runStart = i;
      }
    } else if (c === '"') {
      if (field !== "" || runStart >= 0) throw new StageFailure("parse", [issue("parse", "csv-syntax", `${name}, line ${line}`, "Quote inside an unquoted field.")]);
      quoted = true;
      wasQuoted = true;
    } else if (c === delimiter) {
      flush(i);
      row.push(field);
      field = "";
      wasQuoted = false;
    } else if (c === "\n" || c === "\r") {
      flush(i);
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      wasQuoted = false;
      line++;
    } else if (runStart < 0) {
      runStart = i;
    }
  }
  flush(text.length);
  if (quoted) throw new StageFailure("parse", [issue("parse", "csv-syntax", `${name}, line ${line}`, "A quote is never closed.")]);
  if (field !== "" || wasQuoted || row.length) {
    row.push(field);
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1]!.length === 1 && rows[rows.length - 1]![0] === "") rows.pop();
  return rows;
}

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const HAS_INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/;
const MAX_NUMBER_LITERAL = 64;
export const MAX_IDENTIFIER_LENGTH = 128;
export const MAX_TEXT_FIELD_CHARS = 2000;
const SAFE_IDENTIFIER = /^[\u0020-\u007e]+$/;
const unsafeIdentifier = (raw: string) => raw.length > MAX_IDENTIFIER_LENGTH || (raw !== "" && (!SAFE_IDENTIFIER.test(raw) || raw !== raw.normalize("NFKC")));

function exact(raw: string) {
  if (raw.length > MAX_NUMBER_LITERAL) return false;
  const mantissa = raw.replace(/^-/, "").split(/[eE]/)[0]!.replace(".", "").replace(/^0+/, "");
  const digits = mantissa.replace(/0+$/, "").length;
  return digits <= 15 && !(Number(raw) === 0 && /[1-9]/.test(mantissa));
}

function inRange(value: number, unit: string) {
  if (unit === "%") return value >= 0 && value <= 100;
  if (unit === "mm" || unit === "m" || unit === "kg") return value > 0;
  return value >= 0;
}

const DECIMAL_COMMA = /^-?\d+,\d+$/;

function isCalendarDate(s: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

const codeListOf = (pack: ProfilePack, ref?: string): CodeList | undefined => (ref ? pack.codeLists.find((c) => c.ref === ref) : undefined);

// ---------- Roles resolved by semantic URI suffix (never hard-coded property IDs) ----------

const ROLE_SUFFIXES = {
  model: "productModelIdentifier",
  revision: "productDefinitionRevision",
  name: "commercialProductDesignation",
  batch: "batchIdentifier",
  manufacturer: "manufacturerParty",
  site: "manufacturingSite",
  productionDate: "batchProductionDate",
  alloy: "alloyDesignation",
  temper: "temperDesignation",
  nominalThickness: "nominalSheetThickness",
  measuredThickness: "measuredSheetThickness",
  nominalWidth: "nominalSheetWidth",
  nominalLength: "nominalSheetLength",
  magnesium: "measuredMagnesiumMassFraction",
  recycledTotal: "declaredTotalRecycledContent",
  recycledPre: "preConsumerRecycledContent",
  recycledPost: "postConsumerRecycledContent",
  recycledBasis: "recycledContentMassBasis",
  evidence: "recycledContentEvidenceReferences",
  footprint: "productCarbonFootprintResult",
  narrative: "authorisedProductDescriptions",
  customerCode: "customerMaterialCode",
  lead: "measuredLeadMassFraction",
  conversionCost: "internalUnitConversionCost",
} as const;
export type Role = keyof typeof ROLE_SUFFIXES;

export function byRole(pack: ProfilePack, role: Role): string {
  const suffix = ROLE_SUFFIXES[role];
  const found = pack.properties.find((p) => p.definitionRef.endsWith(`/${suffix}`));
  if (!found) throw new Error(`The profile has no ${role} property (/${suffix})`);
  return found.id;
}

// ---------- ERP CSV (SRC-ERP-CSV-01, comma-delimited, 21 columns) ----------

export async function importErpCsv(pack: ProfilePack, input: ImportInput, actor = "ACT-01"): Promise<ImportResult> {
  const contract = pack.inputs.erp;
  const limits = effectiveLimits(pack.policy.limits, input.limits);
  const deadline = new Deadline(limits.job_deadline_ms, input.now ?? (() => performance.now()), input.name, input.startedAt, input.budget);
  let file: SourceFile = { name: input.name, role: "erp", mediaType: input.type, sha256: "", size: input.bytes.length };
  let rawText: string | undefined;
  try {
    deadline.check("bytes");
    const decoded = await bytesStage(input.bytes, input.name, input.type, "erp", limits.max_file_bytes);
    file = decoded.file;
    rawText = decoded.text;
    const name = input.name;

    deadline.check("parse");
    const rows = csvRows(decoded.text, contract.delimiter, name, () => deadline.check("parse"));
    const [header = [], ...body] = rows;
    for (let r = 0; r < rows.length; r++) {
      const long = rows[r]!.findIndex((cell) => cell.length > MAX_TEXT_FIELD_CHARS);
      if (long !== -1) throw new StageFailure("parse", [issue("parse", "field-too-long", `${name}, row ${r + 1}, column ${long + 1}`)]);
    }
    failIf(
      "parse",
      body.flatMap((r, i) =>
        r.length === header.length ? [] : [issue("parse", "ragged-row", `${name}, row ${i + 2}`, `${r.length} fields, header has ${header.length}.`)],
      ),
    );

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

    deadline.check("semantics");
    const at = (row: number, col: string) => `${name}, row ${row}, column ${col}`;
    const assertions: Assertion[] = [];
    const errors: IngressIssue[] = [];
    const records: Array<{ model: string; batch: string; revision?: string }> = [];
    const seenRecords = new Map<string, number>();

    body.forEach((r, i) => {
      const rowNo = i + 2;
      const cell = Object.fromEntries(header.map((h, j) => [h, r[j]!]));

      // Check identifiers on lookup keys first so padded/unsafe identifiers give clear errors
      for (const keyCol of ["source_company", "code_list_version", "material_code", "product_revision", "batch_id", "manufacturer_id", "site_id", "customer_material_code"]) {
        const val = cell[keyCol];
        if (!val) continue;
        if (val !== val.trim() || HAS_INVISIBLE.test(val)) {
          errors.push(issue("semantics", "padded-identifier", at(rowNo, keyCol), JSON.stringify(val)));
        } else if (unsafeIdentifier(val)) {
          errors.push(issue("semantics", "unsafe-identifier", at(rowNo, keyCol)));
        }
      }

      // Company/code-list/material lookup (MAP-IMP-ERP-01 MI-E01, REF-02, REF-03)
      const lookupMatches = pack.contracts.codeList.entries.filter(
        (x) => x.source_company === cell.source_company && x.code_list_version === cell.code_list_version && x.material_code === cell.material_code,
      );
      if (lookupMatches.length !== 1 && !errors.some((e) => e.location.includes("material_code") || e.location.includes("source_company"))) {
        errors.push(issue("semantics", "unknown-code", at(rowNo, "material_code"), `No unique code-list match for "${cell.source_company}/${cell.code_list_version}/${cell.material_code}".`));
      }
      const modelId = lookupMatches.length === 1 ? lookupMatches[0]!.model_id : cell.material_code ?? "";
      const key = `${modelId}|${cell.batch_id}`;
      if (seenRecords.has(key)) {
        errors.push(issue("semantics", "duplicate-record", `${name}, row ${rowNo}`, `Same model and batch as row ${seenRecords.get(key)}.`));
      }
      seenRecords.set(key, rowNo);
      records.push({ model: modelId, batch: cell.batch_id ?? "", revision: cell.product_revision });

      // Emit the mapped model identifier assertion (from lookup_model)
      if (lookupMatches.length === 1) {
        assertions.push({
          property: byRole(pack, "model"),
          raw: cell.material_code!,
          value: modelId,
          unit: null,
          details: {
            scheme_id: `${pack.contracts.profilePolicy.customer.recipient.split("-")[0] ?? "ST"}-PRODUCT-MODEL`,
            scheme_version: cell.code_list_version!,
            issuer_ref: cell.manufacturer_id!,
          },
          source: { file: name, role: "erp", sha256: file.sha256, location: at(rowNo, "material_code"), row: i + 1 },
          flags: ["declared", "code-mapped"],
        });
      }

      for (const c of contract.columns) {
        const raw = cell[c.name]!;
        const loc = at(rowNo, c.name);
        if (raw.replace(INVISIBLE, "").trim() === "") {
          if (c.required) errors.push(issue("semantics", "missing-value", loc, raw === "" ? undefined : "The cell holds only spaces."));
          continue;
        }
        const [property, member] = c.maps_to.split("/");
        if ((c.code_list || member?.startsWith("FLD-Identifier-")) && (raw !== raw.trim() || HAS_INVISIBLE.test(raw))) {
          if (!errors.some((e) => e.location === loc)) errors.push(issue("semantics", "padded-identifier", loc, JSON.stringify(raw)));
          continue;
        }
        if ((c.code_list || member?.startsWith("FLD-Identifier-")) && unsafeIdentifier(raw)) {
          if (!errors.some((e) => e.location === loc)) errors.push(issue("semantics", "unsafe-identifier", loc));
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
        }
        assertions.push({
          property: property!,
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
    return { ok: true, importStatus: "IMPORTED", file, assertions, records, rawText };
  } catch (e) {
    if (e instanceof StageFailure) return { ok: false, importStatus: "REJECT", file, stage: e.stage, errors: e.errors };
    throw e;
  }
}

// ---------- Laboratory and assessment JSON (SRC-LAB-JSON-01) ----------

const get = (v: JsonValue, key: string): JsonValue => (v.kind === "object" ? (v.entries.get(key) ?? { kind: "null" }) : { kind: "null" });
const str = (v: JsonValue) => (v.kind === "string" ? v.value : v.kind === "number" ? v.raw : v.kind === "boolean" ? String(v.value) : "");
const list = (v: JsonValue) => (v.kind === "array" ? v.items : []);

export async function importLabJson(pack: ProfilePack, input: ImportInput, actor = "ACT-01"): Promise<ImportResult> {
  const contract = pack.inputs.lab;
  const limits = effectiveLimits(pack.policy.limits, input.limits);
  const deadline = new Deadline(limits.job_deadline_ms, input.now ?? (() => performance.now()), input.name, input.startedAt, input.budget);
  let file: SourceFile = { name: input.name, role: "lab", mediaType: input.type, sha256: "", size: input.bytes.length };
  let rawText: string | undefined;
  try {
    deadline.check("bytes");
    const decoded = await bytesStage(input.bytes, input.name, input.type, "lab", limits.max_file_bytes);
    file = decoded.file;
    rawText = decoded.text;
    const name = input.name;

    let doc: JsonValue;
    try {
      deadline.check("parse");
      doc = parseStrictJson(decoded.text, {
        maxDepth: limits.max_json_depth,
        ...(input.limits?.maxParserNodes !== undefined ? { maxNodes: input.limits.maxParserNodes } : {}),
        tick: () => deadline.check("parse"),
      });
    } catch (e) {
      if (!(e instanceof JsonSyntaxError)) throw e;
      const code: IngressCode =
        e.code === "duplicate-key"
          ? "duplicate-key"
          : e.code === "non-finite-number"
            ? "non-finite-number"
            : e.code === "too-deep"
              ? "too-deep"
              : e.code === "too-many-nodes"
                ? "too-many-nodes"
                : "json-syntax";
      throw new StageFailure("parse", [
        issue("parse", code, code === "too-many-nodes" ? name : `${name}, ${e.path || "/"}`, code === "too-many-nodes" ? undefined : e.message),
      ]);
    }

    const hasControl = (v: JsonValue): boolean =>
      v.kind === "string"
        ? /[\u0000-\u001f]/.test(v.value)
        : v.kind === "array"
          ? v.items.some(hasControl)
          : v.kind === "object"
            ? [...v.entries].some(([k, x]) => /[\u0000-\u001f]/.test(k) || hasControl(x))
            : false;
    if (hasControl(doc)) throw new StageFailure("parse", [issue("parse", "control-character", name)]);

    const longText = (v: JsonValue): boolean =>
      v.kind === "string"
        ? v.value.length > MAX_TEXT_FIELD_CHARS
        : v.kind === "array"
          ? v.items.some(longText)
          : v.kind === "object"
            ? [...v.entries].some(([k, x]) => k.length > MAX_TEXT_FIELD_CHARS || longText(x))
            : false;
    if (longText(doc)) throw new StageFailure("parse", [issue("parse", "field-too-long", name)]);

    deadline.check("structure");
    const structure: IngressIssue[] = [];
    if (doc.kind !== "object") {
      structure.push(issue("structure", "schema", `${name}, /`, "Root must be a JSON object."));
    } else {
      for (const reqKey of ["synthetic", "batch_id", "source_assurance", "lab_tests", "recycled_content", "assessment", "authorised_texts", "methods", "cost_context"]) {
        if (!doc.entries.has(reqKey)) structure.push(issue("structure", "schema", `${name}, /`, `"${reqKey}" is required.`));
      }
      const syn = get(doc, "synthetic");
      if (syn.kind !== "boolean" || syn.value !== true) {
        structure.push(issue("structure", "schema", `${name}, /synthetic`, "Must be boolean true."));
      }
      const lt = get(doc, "lab_tests");
      if (lt.kind !== "object") structure.push(issue("structure", "schema", `${name}, /lab_tests`, "Must be an object."));
      else {
        for (const k of ["thickness", "magnesium", "lead"]) {
          if (!lt.entries.has(k)) structure.push(issue("structure", "schema", `${name}, /lab_tests`, `"${k}" is required.`));
        }
      }
    }
    failIf("structure", structure);

    deadline.check("semantics");
    const errors: IngressIssue[] = [];
    const assertions: Assertion[] = [];
    const src = (location: string) => ({ file: name, role: "lab" as const, sha256: file.sha256, location: `${name}, ${location}` });
    const batch = str(get(doc, "batch_id"));
    if (batch !== batch.trim() || HAS_INVISIBLE.test(batch)) {
      errors.push(issue("semantics", "padded-identifier", `${name}, /batch_id`, JSON.stringify(batch)));
    } else if (unsafeIdentifier(batch)) {
      errors.push(issue("semantics", "unsafe-identifier", `${name}, /batch_id`));
    }

    const sourceAssurance = str(get(doc, "source_assurance"));
    const requiredAssurance = pack.contracts.profilePolicy.source_assurance_required;

    // Validate state_overrides keys against the 24 profile properties
    const allowedProps = new Set(pack.properties.map((p) => p.id));
    const overridesObj = get(doc, "state_overrides");
    const overrides = new Map<string, { challenge_status?: string; source_assurance?: string }>();
    if (overridesObj.kind === "object") {
      for (const [propId, val] of overridesObj.entries) {
        if (!allowedProps.has(propId)) {
          errors.push(issue("semantics", "schema", `${name}, /state_overrides/${propId}`, `Unknown property state override "${propId}".`));
          continue;
        }
        if (val.kind === "object") {
          const cs = get(val, "challenge_status");
          const sa = get(val, "source_assurance");
          overrides.set(propId, {
            ...(cs.kind === "string" ? { challenge_status: cs.value } : {}),
            ...(sa.kind === "string" ? { source_assurance: sa.value } : {}),
          });
        }
      }
    }

    const applyOverrideFlags = (propId: string, flags: Flag[]) => {
      const ov = overrides.get(propId);
      if (ov?.challenge_status && ov.challenge_status !== "none") flags.push("challenged");
      const effAssurance = ov?.source_assurance ?? sourceAssurance;
      if (effAssurance !== requiredAssurance) flags.push("source-assurance-unaccepted");
    };

    // Unique observation IDs across lab_tests
    const lt = get(doc, "lab_tests");
    const seenObs = new Map<string, string>();
    const obsSpecs: Array<{ key: "thickness" | "magnesium" | "lead"; role: Role }> = [
      { key: "thickness", role: "measuredThickness" },
      { key: "magnesium", role: "magnesium" },
      { key: "lead", role: "lead" },
    ];
    let hasShapeIssue = false;

    for (const { key, role } of obsSpecs) {
      const o = get(lt, key);
      const path = `/lab_tests/${key}`;
      if (o.kind !== "object") continue;
      const obsId = str(get(o, "observation_id"));
      if (unsafeIdentifier(obsId)) errors.push(issue("semantics", "unsafe-identifier", `${name}, ${path}/observation_id`));
      if (seenObs.has(obsId)) errors.push(issue("semantics", "duplicate-id", `${name}, ${path}/observation_id`, `"${obsId}" also at ${seenObs.get(obsId)}.`));
      seenObs.set(obsId, `${path}/observation_id`);

      const property = byRole(pack, role);
      const unitNode = get(o, "unit_id");
      const flags: Flag[] = ["measured", "unit-stated"];
      if (unitNode.kind === "null") {
        errors.push(issue("semantics", "missing-unit", `${name}, ${path}/unit_id`, `${property}.`));
        continue;
      }
      const unit = str(unitNode);
      const allowedUnits = contract.allowed_units[property] ?? [];
      if (!allowedUnits.includes(unit)) {
        flags.push("wrong-unit");
      }

      const v = get(o, "value");
      const u = get(o, "uncertainty");
      if (v.kind === "number") {
        if (!exact(v.raw)) {
          errors.push(issue("semantics", "precision-loss", `${name}, ${path}/value`, `"${v.raw}".`));
          continue;
        }
        if (allowedUnits.includes(unit) && !inRange(v.value, unit)) {
          errors.push(issue("semantics", "out-of-range", `${name}, ${path}/value`, `${v.raw} ${unit}.`));
          continue;
        }
      } else {
        // Non-numeric value on measurement -> record shape issue (REF-20)
        hasShapeIssue = true;
        flags.push("shape-issue");
      }
      if (u.kind === "object") flags.push("uncertainty-stated");
      else {
        hasShapeIssue = true;
        flags.push("shape-issue");
      }
      const evRefs = list(get(o, "evidence_refs"));
      if (evRefs.length > 0) flags.push("evidence-linked");
      applyOverrideFlags(property, flags);

      assertions.push({
        property,
        raw: str(v),
        value: v.kind === "number" ? v.value : null,
        unit,
        details: {
          observation_id: obsId,
          property_ref: str(get(o, "property_ref")),
          specimen_ref: str(get(o, "specimen_ref")),
          method_ref: str(get(o, "method_ref")),
          qualifier: str(get(o, "qualifier")),
          mass_basis: str(get(o, "mass_basis")),
          uncertainty_value: u.kind === "object" ? str(get(u, "value")) : "",
          uncertainty_unit: u.kind === "object" ? str(get(u, "unit_id")) : "",
          coverage_factor: u.kind === "object" ? str(get(u, "coverage_factor")) : "",
          uncertainty_kind: u.kind === "object" ? str(get(u, "uncertainty_kind")) : "",
          evidence_refs: evRefs.map(str).join(","),
        },
        source: src(`${path}/value`),
        flags,
      });
    }

    // Recycled content basis, evidence, and optional conflicting_pre_percent (REF-07)
    const rc = get(doc, "recycled_content");
    const basis = get(rc, "basis");
    if (basis.kind === "object") {
      const basisId = str(get(basis, "basis_id"));
      const prop = byRole(pack, "recycledBasis");
      const flags: Flag[] = ["declared"];
      applyOverrideFlags(prop, flags);
      assertions.push({
        property: prop,
        raw: basisId,
        value: basisId,
        unit: null,
        details: {
          basis_id: basisId,
          numerator: str(get(basis, "numerator")),
          denominator: str(get(basis, "denominator")),
          includes: str(get(basis, "includes")),
          excludes: list(get(basis, "excludes")).map(str).join(","),
          mass_unit: str(get(basis, "mass_unit")),
          method_id: str(get(rc, "method_id")),
          scope_id: str(get(rc, "scope_id")),
          eligibility: str(get(rc, "eligibility")),
        },
        source: src("/recycled_content/basis"),
        flags,
      });
    }

    const conflictPre = get(rc, "conflicting_pre_percent");
    if (conflictPre.kind !== "null") {
      const prop = byRole(pack, "recycledPre");
      assertions.push({
        property: prop,
        raw: str(conflictPre),
        value: conflictPre.kind === "number" ? conflictPre.value : null,
        unit: "%",
        source: src("/recycled_content/conflicting_pre_percent"),
        flags: ["declared", "challenged"],
      });
    }

    const evList = list(get(rc, "evidence"));
    const evProp = byRole(pack, "evidence");
    const seenEv = new Map<string, number>();
    evList.forEach((e, i) => {
      const id = str(get(e, "evidence_id"));
      if (unsafeIdentifier(id)) errors.push(issue("semantics", "unsafe-identifier", `${name}, /recycled_content/evidence/${i}/evidence_id`));
      if (seenEv.has(id)) errors.push(issue("semantics", "duplicate-id", `${name}, /recycled_content/evidence/${i}/evidence_id`, `"${id}".`));
      seenEv.set(id, i);
      const flags: Flag[] = ["declared"];
      applyOverrideFlags(evProp, flags);
      assertions.push({
        property: evProp,
        qualifier: id,
        raw: id,
        value: id,
        unit: null,
        details: Object.fromEntries(
          ["issuer", "revision", "record_kind", "scope", "digest", "access_policy_ref", "external_verification"].map((k) => [k, str(get(e, k))]),
        ),
        source: src(`/recycled_content/evidence/${i}`),
        flags,
      });
    });

    // Assessment / carbon footprint
    const assessObj = get(doc, "assessment");
    const fpResult = get(assessObj, "result");
    const fpCtx = get(assessObj, "context");
    if (fpResult.kind === "object") {
      const fpProp = byRole(pack, "footprint");
      const v = get(fpResult, "result");
      const unit = str(get(fpResult, "unit_id"));
      const flags: Flag[] = ["calculated-externally", "unit-stated"];
      const allowedFpUnits = contract.allowed_units[fpProp] ?? [];
      if (!allowedFpUnits.includes(unit)) flags.push("wrong-unit");
      applyOverrideFlags(fpProp, flags);
      assertions.push({
        property: fpProp,
        qualifier: str(get(fpResult, "indicator_id")),
        raw: str(v),
        value: v.kind === "number" ? v.value : null,
        unit,
        details: {
          indicator_id: str(get(fpResult, "indicator_id")),
          method_ref: str(get(fpResult, "method_ref")),
          reference_unit: str(get(fpResult, "reference_unit")),
          system_boundary: str(get(fpResult, "system_boundary")),
          allocation: str(get(fpResult, "allocation")),
          period: str(get(fpResult, "period")),
          geography: str(get(fpResult, "geography")),
          reference_product: str(get(get(fpCtx, "reference_unit"), "reference_product")),
        },
        source: src("/assessment/result/result"),
        flags,
      });
    }

    // Approved product texts (LocalizedTextSet[], read from authorised_texts)
    const texts = list(get(doc, "authorised_texts"));
    const narrativeProp = byRole(pack, "narrative");
    const expectedSubject = str(get(get(fpCtx, "reference_unit"), "reference_product"));
    const seenTxt = new Map<string, number>();
    texts.forEach((t, i) => {
      const tid = str(get(t, "text_id"));
      if (unsafeIdentifier(tid)) errors.push(issue("semantics", "unsafe-identifier", `${name}, /authorised_texts/${i}/text_id`));
      if (seenTxt.has(tid)) errors.push(issue("semantics", "duplicate-id", `${name}, /authorised_texts/${i}/text_id`, `"${tid}".`));
      seenTxt.set(tid, i);
      const subjectRef = str(get(t, "subject_ref"));
      if (expectedSubject && subjectRef && subjectRef !== expectedSubject) {
        errors.push(issue("semantics", "subject-mismatch", `${name}, /authorised_texts/${i}/subject_ref`, `"${subjectRef}" does not match "${expectedSubject}".`));
      }
      const flags: Flag[] = ["declared"];
      if (str(get(t, "approval_state")) !== "authorised_in_synthetic_fixture") flags.push("draft-text");
      applyOverrideFlags(narrativeProp, flags);
      assertions.push({
        property: narrativeProp,
        qualifier: `${str(get(t, "language"))}/${str(get(t, "sector"))}/${str(get(t, "market"))}`,
        raw: str(get(t, "text")),
        value: str(get(t, "text")),
        unit: null,
        details: Object.fromEntries(["text_id", "subject_ref", "language", "sector", "market", "approval_state", "revision"].map((k) => [k, str(get(t, k))])),
        source: src(`/authorised_texts/${i}/text`),
        flags,
      });
    });

    failIf("semantics", errors);
    authorise(actor, name);
    const plainLab = toPlain(doc) as Record<string, unknown>;
    const refModel = str(get(get(fpCtx, "reference_unit"), "reference_product")).split("/")[0] ?? "";
    return {
      ok: true,
      importStatus: hasShapeIssue ? "IMPORTED_WITH_SHAPE_ISSUES" : "IMPORTED",
      file,
      assertions,
      records: [{ model: refModel, batch }],
      rawText,
      parsedLab: plainLab,
    };
  } catch (e) {
    if (e instanceof StageFailure) return { ok: false, importStatus: "REJECT", file, stage: e.stage, errors: e.errors };
    throw e;
  }
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
  revision?: string;
  importStatus?: ReferenceImportStatus;
  sources: SourceFile[];
  values: RecordValue[];
  /** sha256 of the canonical record state: the same files always give the same digest (C2-07). */
  digest: string;
  /** Pinned REC-ALU-24-01 DPPPayload constructed via MAP-IMP-ERP-01 + MAP-IMP-LAB-01 (C9-04). */
  dppPayload?: DppPayloadRecord;
}

export interface RecordState {
  records: ProductRecord[];
  unattached: Assertion[];
}

const keyOf = (a: { property: string; member?: string; qualifier?: string }) => `${a.property}|${a.member ?? ""}|${a.qualifier ?? ""}`;

export const sameAssertion = (a: Assertion, b: Assertion) =>
  typeof a.value === "number" && typeof b.value === "number" ? a.value === b.value : a.raw === b.raw;

export const valueStatus = (assertions: Assertion[]): ValueStatus =>
  assertions.some((a) => a.flags.includes("source-changed"))
    ? "challenged"
    : assertions.some((a) => a.flags.includes("corrected"))
      ? "corrected"
      : assertions.some((a) => a.flags.includes("challenged"))
        ? "challenged"
        : assertions.length === 1
          ? "single"
          : assertions.every((a) => sameAssertion(a, assertions[0]!))
            ? "agreeing"
            : "challenged";

function groupAssertions(assertions: Assertion[]): RecordValue[] {
  const buckets = new Map<string, Assertion[]>();
  for (const a of assertions) {
    const k = keyOf(a);
    let list = buckets.get(k);
    if (!list) {
      list = [];
      buckets.set(k, list);
    }
    list.push(a);
  }
  const values: RecordValue[] = [];
  for (const [, list] of [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const first = list[0]!;
    const status = valueStatus(list);
    const finalAssertions = status === "challenged" ? list.map((a) => (a.flags.includes("challenged") ? a : { ...a, flags: [...a.flags, "challenged" as Flag] })) : list;
    values.push({
      property: first.property,
      ...(first.member ? { member: first.member } : {}),
      ...(first.qualifier ? { qualifier: first.qualifier } : {}),
      status,
      assertions: finalAssertions,
    });
  }
  return values;
}

export async function recordDigest(record: Omit<ProductRecord, "digest">): Promise<string> {
  const { digest: _d, ...state } = record as ProductRecord;
  return sha256Hex(canonical(state));
}

export async function buildRecords(
  results: ImportResult[],
  packOrDigest?: ProfilePack | ((state: object) => string | Promise<string>),
  maybeDigest?: (state: object) => string | Promise<string>,
): Promise<RecordState>;
export async function buildRecords(pack: ProfilePack, erp?: ImportResult, lab?: ImportResult): Promise<RecordState>;
export async function buildRecords(
  first: ProfilePack | ImportResult[],
  second?: ImportResult | ProfilePack | ((state: object) => string | Promise<string>),
  third?: ImportResult | ((state: object) => string | Promise<string>),
): Promise<RecordState> {
  let pack: ProfilePack | undefined;
  let results: ImportResult[];
  let customDigest: ((state: object) => string | Promise<string>) | undefined;
  if (Array.isArray(first)) {
    results = first;
    if (typeof second === "function") customDigest = second;
    else if (second && typeof second === "object" && "contracts" in second) {
      pack = second;
      if (typeof third === "function") customDigest = third;
    }
  } else {
    pack = first;
    results = [second as ImportResult | undefined, third as ImportResult | undefined].filter((x): x is ImportResult => x !== undefined);
  }

  const accepted = results.filter((r): r is Extract<ImportResult, { ok: true }> => r.ok);
  const erps = accepted.filter((r) => r.file.role === "erp");
  const labs = accepted.filter((r) => r.file.role === "lab");
  const records: ProductRecord[] = [];
  const unattached: Assertion[] = [];
  const attachedLab = new Set<Extract<ImportResult, { ok: true }>>();

  for (const e of erps) {
    for (let i = 0; i < e.records.length; i++) {
      const id = e.records[i]!;
      const erpAssertions = e.assertions.filter((a) => a.source.row === i + 1);
      const matchedLabs = labs.filter((l) => l.records[0]?.batch === id.batch);
      matchedLabs.forEach((l) => attachedLab.add(l));
      const sources: SourceFile[] = [e.file, ...matchedLabs.map((l) => l.file)];
      const combined: Assertion[] = [...erpAssertions, ...matchedLabs.flatMap((l) => l.assertions)];
      const values = groupAssertions(combined);
      let dppPayload: DppPayloadRecord | undefined;
      let importStatus: ReferenceImportStatus = matchedLabs.some((l) => l.importStatus === "IMPORTED_WITH_SHAPE_ISSUES")
        ? "IMPORTED_WITH_SHAPE_ISSUES"
        : e.importStatus;

      const lab0 = matchedLabs[0];
      if (pack && e.rawText && lab0?.parsedLab) {
        const refRes = await importReferencePair(e.rawText, lab0.parsedLab, pack.contracts, {
          standIn: pack.standIn,
          labRawText: lab0.rawText,
        });
        importStatus = refRes.status;
        if (refRes.record) dppPayload = refRes.record;
      }

      const base: Omit<ProductRecord, "digest"> = {
        model: id.model,
        batch: id.batch,
        ...(id.revision ? { revision: id.revision } : {}),
        importStatus,
        sources,
        values,
        ...(dppPayload ? { dppPayload } : {}),
      };
      const digest = customDigest ? await customDigest(base) : await recordDigest(base);
      records.push({ ...base, digest });
    }
  }
  for (const l of labs) if (!attachedLab.has(l)) unattached.push(...l.assertions);
  return { records, unattached };
}

/** Re-checks a stored or imported record against the pinned contract pack (centralRecord.ts). */
export function recheckRecord(pack: ProfilePack, record: ProductRecord): string[] {
  const problems: string[] = [];
  const knownProps = new Map(pack.properties.map((p) => [p.id, new Set(p.members.map((m) => m.id))]));
  const listedSources = new Set(record.sources.map((s) => `${s.role}|${s.sha256}`));
  const erpCols = new Map(pack.inputs.erp.columns.map((c) => [c.name, c]));
  const modelProp = byRole(pack, "model");

  for (const v of record.values) {
    const at = `${v.property}${v.member ? `/${v.member}` : ""}`;
    if (!knownProps.has(v.property)) {
      problems.push(`${v.property}: not a property of the profile`);
      continue;
    }
    if (v.member && !knownProps.get(v.property)!.has(v.member)) {
      problems.push(`${at}: member not in profile`);
    }

    // Re-derive status from assertions and verify challenged flag agreement
    const expectedStatus: ValueStatus = v.assertions.some((a) => a.flags.includes("source-changed"))
      ? "challenged"
      : v.assertions.some((a) => a.flags.includes("corrected"))
        ? "corrected"
        : v.assertions.length === 1
          ? v.assertions[0]!.flags.includes("challenged")
            ? "challenged"
            : "single"
          : v.assertions.every((a) => sameAssertion(a, v.assertions[0]!)) && !v.assertions.some((a) => a.flags.includes("challenged"))
            ? "agreeing"
            : "challenged";
    if (v.status !== expectedStatus) {
      problems.push(`${at}: status is ${v.status}, the assertions make it ${expectedStatus}`);
    }
    if (
      v.status === "challenged" &&
      !v.assertions.some((a) => a.flags.includes("source-changed")) &&
      v.assertions.some((a) => a.source.role !== "correction" && !a.flags.includes("challenged"))
    ) {
      problems.push(`${at}: challenged value has an assertion without the challenged flag`);
    }

    for (const a of v.assertions) {
      if (a.source.role === "correction") {
        problems.push(...recheckCorrection(pack, v, a, at));
        continue;
      }
      if (!listedSources.has(`${a.source.role}|${a.source.sha256}`)) {
        problems.push(`${at}: source sha256 ${a.source.sha256} is not listed in the record`);
      }

      if (a.source.role === "erp") {
        const colMatch = /, row \d+, column (.+)$/.exec(a.source.location);
        const col = colMatch ? erpCols.get(colMatch[1]!) : undefined;
        if (col) {
          const [colProp, colMember] = col.maps_to.split("/");
          const isModelLookup = col.name === "material_code" && v.property === modelProp && !v.member;
          if (!isModelLookup && (colProp !== v.property || (colMember ?? undefined) !== v.member)) {
            problems.push(`${at}: column "${col.name}" maps to ${col.maps_to}, not ${at}`);
          }
          if (!isModelLookup) {
            if (col.unit !== null) {
              if (a.unit !== col.unit) problems.push(`${at}: the unit is ${a.unit}, the contract states ${col.unit}`);
              if (!DECIMAL.test(a.raw) || !exact(a.raw)) problems.push(`${at}: "${a.raw}" is not a valid decimal number`);
              else {
                const n = Number(a.raw);
                if (a.value !== n) problems.push(`${at}: the value is ${JSON.stringify(a.value)}, "${a.raw}" gives ${n}`);
                if (!inRange(n, col.unit)) problems.push(`${at}: ${a.raw} ${col.unit} is out of range`);
              }
            }
            const list = codeListOf(pack, col.code_list);
            if (list) {
              const known = list.codes.find((x) => x.code === a.raw);
              if (!known) {
                if (!a.flags.includes("unknown-code")) problems.push(`${at}: flags are [${a.flags.join(", ")}], expected unknown-code for "${a.raw}"`);
              } else {
                if (a.flags.includes("unknown-code")) problems.push(`${at}: flags are [${a.flags.join(", ")}], "${a.raw}" is in ${list.ref}`);
                const expectedVal = known.mapsTo ?? a.raw;
                if (a.value !== expectedVal) problems.push(`${at}: the value is ${JSON.stringify(a.value)}, code list gives ${JSON.stringify(expectedVal)}`);
              }
            } else if (a.flags.includes("unknown-code")) {
              problems.push(`${at}: flags are [${a.flags.join(", ")}], column "${col.name}" has no code list`);
            }
          }
        }
      } else if (a.source.role === "lab") {
        const allowed = pack.inputs.lab.allowed_units[v.property];
        if (allowed && a.unit !== null && !a.flags.includes("wrong-unit") && !allowed.includes(a.unit)) {
          problems.push(`${at}: unit "${a.unit}" is not allowed by laboratory contract (${allowed.join(", ")})`);
        }
        if (a.unit && typeof a.value === "number" && !a.flags.includes("wrong-unit") && !inRange(a.value, a.unit)) {
          problems.push(`${at}: ${a.raw} ${a.unit} is out of range`);
        }
        if (a.details) {
          if (a.details.digest && a.details.digest !== "null" && !/^sha256:[0-9a-f]{64}$/.test(a.details.digest)) {
            problems.push(`${at}: laboratory contract: digest Does not match pattern sha256:<64 hex>`);
          }
          if (a.details.language && !["en", "de"].includes(a.details.language)) {
            problems.push(`${at}: laboratory contract: language Must be one of en, de`);
          }
          if (a.details.uncertainty_value && a.details.uncertainty_value !== "") {
            const uv = Number(a.details.uncertainty_value);
            if (!Number.isFinite(uv) || uv < 0) problems.push(`${at}: laboratory contract: uncertainty_value Must be at least 0`);
          }
          if (a.details.coverage_factor && a.details.coverage_factor !== "") {
            const cf = Number(a.details.coverage_factor);
            if (!Number.isFinite(cf) || cf <= 0) problems.push(`${at}: laboratory contract: coverage_factor Must be more than 0`);
          }
        }
      }
    }
  }
  if (record.dppPayload) {
    const schemaErrs = checkBoundedSchema(record.dppPayload, pack.contracts.recordSchema);
    if (record.importStatus === "IMPORTED" && schemaErrs.length > 0) {
      problems.push(`dppPayload has shape errors while importStatus is IMPORTED: ${schemaErrs[0]}`);
    }
  }
  return problems;
}

// ---------- Operator correction (Cycle 5) ----------

export const baseAssertion = (v: RecordValue): Assertion | undefined => v.assertions.find((a) => a.source.role !== "correction");

export function checkCorrectedValue(pack: ProfilePack, base: Assertion, raw: string): { ok: true; value: string | number | null } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (raw.length > MAX_TEXT_FIELD_CHARS) return no(`The corrected value is longer than ${MAX_TEXT_FIELD_CHARS} characters.`);
  if (raw.replace(INVISIBLE, "").trim() === "") return no("The corrected value is empty.");
  if (raw !== raw.trim() || HAS_INVISIBLE.test(raw)) return no("The corrected value has spaces at its ends or invisible characters.");
  if (/[\u0000-\u001f\u007f]/.test(raw)) return no("The corrected value has a control character or a line break.");
  let value: string | number | null = raw;
  const unit = base.unit;
  const rest = base.source.location.slice(base.source.file.length + 2);
  const column = base.source.role === "erp" ? pack.inputs.erp.columns.find((c) => c.name === /^row \d+, column (.+)$/.exec(rest)?.[1]) : undefined;
  const isIdentifier =
    Boolean(base.member?.startsWith("FLD-Identifier-")) ||
    Boolean(column?.maps_to.includes("FLD-Identifier-")) ||
    Boolean(column?.code_list) ||
    base.property === byRole(pack, "alloy");
  if (isIdentifier && unsafeIdentifier(raw)) {
    return no("The corrected identifier contains characters that are not allowed or is too long.");
  }
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

function recheckCorrection(pack: ProfilePack, v: RecordValue, a: Assertion, at: string): string[] {
  const problems: string[] = [];
  const c = a.correction;
  if (!c || !Number.isInteger(c.version) || c.version < 2 || c.actor !== "ACT-01" || c.reason.trim() === "") {
    return [`${at}: a correction needs its version, its actor and a reason`];
  }
  if (a.source.file !== `Operator correction v${c.version}`) problems.push(`${at}: the correction is named for another version`);
  if (a.flags.length !== 1 || a.flags[0] !== "corrected") problems.push(`${at}: a correction carries exactly the corrected flag`);
  if (v.assertions[0] !== a && v.assertions.findIndex((x) => x.source.role !== "correction") < v.assertions.indexOf(a)) {
    problems.push(`${at}: a correction comes before the values it replaces`);
  }
  const base = baseAssertion(v);
  if (!base) return [...problems, `${at}: a correction with nothing to correct`];
  const checked = checkCorrectedValue(pack, base, a.raw);
  if (!checked.ok) problems.push(`${at}: ${checked.reason}`);
  else if (a.value !== checked.value) problems.push(`${at}: the value is ${JSON.stringify(a.value)}, the corrected text gives ${JSON.stringify(checked.value)}`);
  if (a.unit !== base.unit) problems.push(`${at}: the unit differs from the value it corrects`);
  if (JSON.stringify(a.details ?? null) !== JSON.stringify(base.details ?? null)) problems.push(`${at}: the details differ from the value it corrects`);
  return problems;
}
