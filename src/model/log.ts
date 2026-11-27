/**
 * The local execution and error log (Cycle 5: FUNC-132; criterion C5-03).
 *
 * The log is append-only, kept in this browser (IndexedDB, or memory where the browser has none), viewable and
 * downloadable on the screen. It is traceable bookkeeping, not a tamper-evident certification.
 *
 * Public-log field set, fixed: `seq`, `event`, `stage`, `code`, `route`, `ruleId`, `stepId`, `record` (the model and
 * batch as digests only), `version`, `fileRole`, `fileSha256`, `outcome`.
 *
 * What is never logged: a value, a code value, a file name, or free text. Every field has a confidentiality class
 * (`classify`); a field that is not in the set has none, so it is restricted and dropped, and a field whose content
 * does not have the fixed shape of its kind is dropped too. Error messages on the screen may show the operator's own
 * values; the log carries only the stage and the error code.
 */
import { idbLogAdd, idbLogAll } from "../db/idb";
import { classify, type Classification } from "./classification";
import { ERROR_TEXT, STAGES, type ImportResult, type Stage } from "./ingress";
import { ROUTES, sha256Hex, type Route } from "./profile";
import type { RouteReadiness } from "./readiness";

export const LOG_FIELDS = ["seq", "event", "stage", "code", "route", "ruleId", "stepId", "record", "version", "fileRole", "fileSha256", "outcome"] as const;
export type LogField = (typeof LOG_FIELDS)[number];

/** The class of each field of the public log. Anything else gets the default class, restricted, and is not kept. */
export const FIELD_CLASS: Record<LogField, Classification> = Object.fromEntries(LOG_FIELDS.map((f) => [f, "public"])) as Record<LogField, Classification>;

export const LOG_EVENTS = [
  "import-accepted",
  "import-rejected",
  "readiness-assessed",
  "output-made",
  "output-refused",
  "release",
  "record-export",
  "record-import",
  "correction",
] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

export const LOG_OUTCOMES = [
  "accepted",
  "rejected",
  "IMPORTED",
  "IMPORTED_WITH_SHAPE_ISSUES",
  "REJECT",
  "RELEASED",
  "HOLD",
  "made",
  "refused",
  "released",
  "exported",
  "imported",
  "corrected",
] as const;
export type LogOutcome = (typeof LOG_OUTCOMES)[number];

/** Codes that are not import errors: a central-record file that is refused, and an output that could not be made. */
export const EXTRA_CODES = ["central-record-invalid", "output-failed"] as const;
export const LOG_CODES: readonly string[] = [...Object.keys(ERROR_TEXT), ...EXTRA_CODES];

export interface LogEntry {
  seq: number;
  event: LogEvent;
  stage?: Stage;
  code?: string;
  route?: Route;
  ruleId?: string;
  stepId?: string;
  /** The model and the batch, each as the sha256 of its identifier: never the identifiers themselves. */
  record?: { model: string; batch: string };
  /** The version of the record in the central record. */
  version?: number;
  fileRole?: "erp" | "lab";
  fileSha256?: string;
  outcome: LogOutcome;
}

/** What a caller offers: the fields except `seq`, which the log assigns. Anything extra is dropped. */
export type LogInput = Record<string, unknown>;

const HEX64 = /^[0-9a-f]{64}$/;
const RULE_ID = /^(?:RR|CK|DR)-[A-Z]+(?:-[A-Z]+)*$/;
const STEP_ID = /^MAP-[A-Z]+-\d{3}$/;

/** The fixed shape of each field's content; anything else is not logged. */
const SHAPES: Record<Exclude<LogField, "seq">, (v: unknown) => boolean> = {
  event: (v) => (LOG_EVENTS as readonly unknown[]).includes(v),
  stage: (v) => (STAGES as readonly unknown[]).includes(v),
  code: (v) => LOG_CODES.includes(v as string),
  route: (v) => (ROUTES as readonly unknown[]).includes(v),
  ruleId: (v) => typeof v === "string" && RULE_ID.test(v),
  stepId: (v) => typeof v === "string" && STEP_ID.test(v),
  record: (v) => {
    const r = v as { model?: unknown; batch?: unknown } | null;
    return !!r && typeof r === "object" && Object.keys(r).sort().join() === "batch,model" && HEX64.test(String(r.model)) && HEX64.test(String(r.batch));
  },
  version: (v) => Number.isInteger(v) && (v as number) >= 1,
  fileRole: (v) => v === "erp" || v === "lab",
  fileSha256: (v) => typeof v === "string" && HEX64.test(v),
  outcome: (v) => (LOG_OUTCOMES as readonly unknown[]).includes(v),
};

export class LogError extends Error {
  override name = "LogError";
}

/**
 * Keeps only what the public log may hold: fields of the fixed set whose class is public and whose content has the fixed
 * shape of its kind. `event` and `outcome` are required. Other content is dropped, not rewritten.
 */
export function sanitise(input: LogInput): Omit<LogEntry, "seq"> {
  const kept: Record<string, unknown> = {};
  for (const field of Object.keys(input)) {
    if (field === "seq") continue; // assigned by the log
    const stated = Object.hasOwn(FIELD_CLASS, field) ? FIELD_CLASS[field as LogField] : undefined;
    if (classify(stated) !== "public") continue;
    const value = input[field];
    if (!SHAPES[field as Exclude<LogField, "seq">](value)) continue;
    kept[field] = field === "record" ? { model: (value as { model: string }).model, batch: (value as { batch: string }).batch } : value;
  }
  if (!("event" in kept) || !("outcome" in kept)) throw new LogError("A log entry needs a valid event and outcome");
  return kept as Omit<LogEntry, "seq">;
}

/** Where entries are kept. `add` assigns the next sequence number; there is no way to change or remove an entry. */
export interface LogStore {
  add(entry: Omit<LogEntry, "seq">): Promise<number>;
  all(): Promise<LogEntry[]>;
}

export class MemoryLogStore implements LogStore {
  private readonly rows: LogEntry[] = [];
  async add(entry: Omit<LogEntry, "seq">) {
    const seq = this.rows.length + 1;
    this.rows.push(structuredClone({ seq, ...entry }));
    return seq;
  }
  async all() {
    return this.rows.map((r) => structuredClone(r));
  }
}

/** The log kept in this browser's IndexedDB (object store `log`, added by the version 3 upgrade). */
export class IdbLogStore implements LogStore {
  add(entry: Omit<LogEntry, "seq">) {
    return idbLogAdd(entry);
  }
  async all() {
    return (await idbLogAll()) as LogEntry[];
  }
}

export class ExecutionLog {
  constructor(private readonly store: LogStore) {}

  async append(input: LogInput): Promise<LogEntry> {
    const entry = sanitise(input);
    return { seq: await this.store.add(entry), ...entry };
  }

  /** Every entry in sequence order, each with its fields in the documented order. */
  async entries(): Promise<LogEntry[]> {
    const rows = [...(await this.store.all())].sort((a, b) => a.seq - b.seq);
    return rows.map((r) => Object.fromEntries(LOG_FIELDS.filter((f) => r[f] !== undefined).map((f) => [f, r[f]])) as unknown as LogEntry);
  }
}

/** The log as a downloadable JSON file, with the field set it follows. */
export async function exportLog(log: ExecutionLog): Promise<{ fileName: string; mediaType: string; bytes: Uint8Array }> {
  const text = `${JSON.stringify({ fields: LOG_FIELDS, entries: await log.entries() }, null, 2)}\n`;
  return { fileName: "execution-log.json", mediaType: "application/json", bytes: new TextEncoder().encode(text) };
}

// ---------- Events: what each step of the work records ----------

/** The record as digests of its identifiers. */
export const recordRef = async (model: string, batch: string) => ({ model: await sha256Hex(model), batch: await sha256Hex(batch) });

const unique = <T>(items: T[], key: (t: T) => string) => [...new Map(items.map((i) => [key(i), i])).values()];

/** One entry for an accepted file, or one per distinct stage and error code of a rejected one. */
export function importEvents(result: ImportResult): LogInput[] {
  const file = { fileRole: result.file.role, ...(result.file.sha256 ? { fileSha256: result.file.sha256 } : {}) };
  if (result.ok) return [{ event: "import-accepted", outcome: "accepted", ...file }];
  return unique(result.errors, (e) => `${e.stage}|${e.code}`).map((e) => ({ event: "import-rejected", outcome: "rejected", stage: e.stage, code: e.code, ...file }));
}

/** One entry per route with its verdict, and one per distinct rule that holds it. */
export async function readinessEvents(model: string, batch: string, readiness: RouteReadiness[], version?: number): Promise<LogInput[]> {
  const record = await recordRef(model, batch);
  const at = version === undefined ? {} : { version };
  return readiness.flatMap((r) => [
    { event: "readiness-assessed", route: r.route, outcome: r.status, record, ...at },
    ...unique(r.holds, (h) => h.ruleId).map((h) => ({ event: "readiness-assessed", route: r.route, ruleId: h.ruleId, outcome: "HOLD", record, ...at })),
  ]);
}

/** What a generated release contained, per route, then the release itself. */
export async function releaseEvents(
  model: string,
  batch: string,
  version: number,
  outcomes: Array<{ route: Route; file?: { status: "RELEASED" | "HOLD" }; refused?: { holds: Array<{ ruleId: string }> } }>,
): Promise<LogInput[]> {
  const record = await recordRef(model, batch);
  const per = outcomes.flatMap((o): LogInput[] =>
    o.refused
      ? o.refused.holds.length
        ? unique(o.refused.holds, (h) => h.ruleId).map((h) => ({ event: "output-refused", route: o.route, ruleId: h.ruleId, outcome: "refused", record, version }))
        : [{ event: "output-refused", route: o.route, outcome: "refused", record, version }]
      : [{ event: "output-made", route: o.route, outcome: o.file?.status === "HOLD" ? "HOLD" : "made", record, version }],
  );
  return [...per, { event: "release", outcome: "released", record, version }];
}

export async function recordExportEvent(model: string, batch: string, version: number): Promise<LogInput> {
  return { event: "record-export", outcome: "exported", record: await recordRef(model, batch), version };
}

export async function recordImportEvent(model: string, batch: string, version: number): Promise<LogInput> {
  return { event: "record-import", outcome: "imported", record: await recordRef(model, batch), version };
}

/** A central-record file that was refused: the code only, because the reason may quote the file. */
export const recordImportRefusedEvent = (): LogInput => ({ event: "record-import", outcome: "rejected", code: "central-record-invalid" });

export async function correctionEvent(model: string, batch: string, version: number): Promise<LogInput> {
  return { event: "correction", outcome: "corrected", record: await recordRef(model, batch), version };
}
