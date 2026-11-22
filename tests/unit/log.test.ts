// @vitest-environment node
/**
 * The execution and error log (Cycle 5): a fixed public field set, no values, no file names, no free text, and a scan of
 * everything the log holds after every fixture has been run through import, readiness, outputs and export.
 */
import { readdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { classify } from "../../src/model/classification";
import { ERROR_TEXT, importErpCsv, importLabJson, type ImportResult } from "../../src/model/ingress";
import {
  correctionEvent,
  ExecutionLog,
  exportLog,
  importEvents,
  LOG_FIELDS,
  MemoryLogStore,
  readinessEvents,
  recordExportEvent,
  recordImportEvent,
  recordImportRefusedEvent,
  releaseEvents,
  sanitise,
} from "../../src/model/log";
import { assess } from "../../src/model/readiness";
import { generateRelease } from "../../src/model/outputs/release";
import { MemoryRepository, storeRecord } from "../../src/model/recordRepository";
import { ROUTES, sha256Hex, type ProfilePack } from "../../src/model/profile";
import { assertNoLeakText } from "../support/leak";
import { fixtureBytes } from "../support/fixtures";
import { COMBINATIONS, loadPack, recordFor, text } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});

const HEX = "a".repeat(64);

describe("the public-log field set", () => {
  it("is fixed", () => {
    expect([...LOG_FIELDS]).toEqual(["seq", "event", "stage", "code", "route", "ruleId", "stepId", "record", "version", "fileRole", "fileSha256", "outcome"]);
  });

  it("keeps a well-formed entry as it is", () => {
    const entry = {
      event: "import-rejected",
      stage: "structure",
      code: "multiple-records",
      route: "customer-pdf",
      ruleId: "RR-MISSING",
      stepId: "MAP-PDF-001",
      record: { model: HEX, batch: HEX },
      version: 2,
      fileRole: "erp",
      fileSha256: HEX,
      outcome: "rejected",
    };
    expect(sanitise(entry)).toEqual(entry);
  });

  it("drops every field that is not in the set, whatever it is called", () => {
    const kept = sanitise({
      event: "import-accepted",
      outcome: "accepted",
      value: "2412.5",
      fileName: "customer-secret.csv",
      message: "A numeric value uses a comma: 2,5",
      raw: "PM-5754-H111-2000",
      __proto__: { polluted: true },
      constructor: "x",
      detail: { a: 1 },
    });
    expect(Object.keys(kept).sort()).toEqual(["event", "outcome"]);
  });

  it("treats a field without a class as restricted, and keeps only public ones", () => {
    expect(classify(undefined)).toBe("restricted");
    expect(Object.keys(sanitise({ event: "release", outcome: "released", comment: "free text" }))).not.toContain("comment");
  });

  it("drops content that does not have the shape of its field, so free text cannot ride in an allowed field", () => {
    const kept = sanitise({
      event: "import-rejected",
      outcome: "rejected",
      stage: "2412.5 kg",
      code: "PM-5754 is wrong",
      route: "someone@example.com",
      ruleId: "the value was 7",
      stepId: "free text",
      record: { model: "PM-5754-H111-2000", batch: "B-2026-0417" },
      version: "two",
      fileRole: "customer-secret.csv",
      fileSha256: "not a digest",
    });
    expect(kept).toEqual({ event: "import-rejected", outcome: "rejected" });
    expect(sanitise({ event: "import-rejected", outcome: "rejected", record: { model: HEX, batch: HEX, name: "x" } })).not.toHaveProperty("record");
  });

  it("refuses an entry with no valid event or outcome", () => {
    expect(() => sanitise({ event: "something-else", outcome: "accepted" })).toThrow();
    expect(() => sanitise({ event: "release", outcome: "fine" })).toThrow();
  });

  it("is append-only: sequence numbers increase and there is no way to change or remove an entry", async () => {
    const log = new ExecutionLog(new MemoryLogStore());
    const a = await log.append({ event: "release", outcome: "released" });
    const b = await log.append({ event: "release", outcome: "released" });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect((await log.entries()).map((e) => e.seq)).toEqual([1, 2]);
    const surface = Object.getOwnPropertyNames(ExecutionLog.prototype).filter((n) => n !== "constructor");
    expect(surface.sort()).toEqual(["append", "entries"]);
  });

  it("downloads as one JSON file that names its field set", async () => {
    const log = new ExecutionLog(new MemoryLogStore());
    await log.append({ event: "correction", outcome: "corrected", version: 3, extra: "dropped" });
    const file = await exportLog(log);
    expect(file.mediaType).toBe("application/json");
    const doc = JSON.parse(new TextDecoder().decode(file.bytes));
    expect(doc.fields).toEqual([...LOG_FIELDS]);
    expect(doc.entries).toEqual([{ seq: 1, event: "correction", version: 3, outcome: "corrected" }]);
  });
});

/** Every leaf of a JSON document that is a string or a number, as text. */
const leaves = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(leaves) : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : v === null || v === undefined || typeof v === "boolean" ? [] : [String(v)]);
const cells = (csv: string) => csv.split(/\r?\n/).flatMap((l) => l.split(";")).map((c) => c.replace(/^"|"$/g, "")).filter(Boolean);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const FILES = readdirSync("fixtures/n").filter((f) => /\.(csv|json)$/.test(f) && f !== "MANIFEST.json");
const role = (f: string) => (f.endsWith(".csv") ? "erp" : "lab");

describe("log scan: no source value reaches the log (all fixtures and failure fixtures)", () => {
  it("holds nothing of any fixture's values, names or error texts after every fixture has been run", async () => {
    const log = new ExecutionLog(new MemoryLogStore());
    const results: ImportResult[] = [];

    // every fixture alone: accepted or rejected, whichever it is
    for (const name of FILES) {
      const bytes = fixtureBytes("n", name);
      const r = role(name) === "erp" ? await importErpCsv(pack, { bytes, name, type: "text/csv" }) : await importLabJson(pack, { bytes, name, type: "application/json" });
      results.push(r);
      for (const e of importEvents(r)) await log.append(e);
    }
    expect(results.some((r) => !r.ok)).toBe(true);
    expect(results.some((r) => r.ok)).toBe(true);

    // every accepted combination: readiness, release, export
    let combos = 0;
    for (const c of COMBINATIONS) {
      const record = await recordFor(pack, c);
      if (!record) continue;
      combos++;
      const repo = new MemoryRepository();
      const { snapshot } = await storeRecord(repo, record);
      for (const e of await readinessEvents(record.model, record.batch, assess(pack, record), snapshot.version)) await log.append(e);
      const release = await generateRelease(pack, snapshot, { software: TEST_SOFTWARE });
      for (const e of await releaseEvents(record.model, record.batch, snapshot.version, release.outcomes)) await log.append(e);
      await log.append(await recordExportEvent(record.model, record.batch, snapshot.version));
      await log.append(await recordImportEvent(record.model, record.batch, snapshot.version));
      await log.append(await correctionEvent(record.model, record.batch, snapshot.version + 1));
    }
    await log.append(recordImportRefusedEvent());
    expect(combos).toBeGreaterThan(10);

    const entries = await log.entries();
    const logText = JSON.stringify(entries);
    expect(new TextDecoder().decode((await exportLog(log)).bytes)).toContain(entries[0].event);
    // The sequence number and the record version are counters the log itself keeps, so a source value such as "62" cannot be
    // told from entry 62 by text matching; everything else is scanned.
    const scanned = JSON.stringify(entries.map(({ seq: _seq, version: _version, ...rest }) => rest));

    // 1. the check the outputs use: no value a route may not see, for each route
    for (const c of COMBINATIONS) {
      const record = await recordFor(pack, c);
      for (const route of ROUTES) assertNoLeakText(scanned, route, record, pack);
    }

    // 2. the stricter check: no raw cell or JSON value of any fixture, and no file name, at all
    const legit = new Set<string>(["erp", "lab", ...entries.flatMap((e) => [e.event, e.outcome, e.stage, e.code, e.route, e.ruleId, e.fileRole].filter(Boolean) as string[])]);
    const tokens = new Set<string>();
    for (const name of FILES) {
      const body = text(name);
      tokens.add(name);
      if (name.endsWith(".csv")) cells(body).forEach((c) => tokens.add(c));
      else {
        try {
          leaves(JSON.parse(body)).forEach((c) => tokens.add(c));
        } catch {
          // a fixture that is not valid JSON on purpose: its words still must not appear
          body.split(/[^\w.-]+/).forEach((c) => tokens.add(c));
        }
      }
    }
    for (const r of results) if (!r.ok) for (const e of r.errors) (tokens.add(e.message), tokens.add(e.location));
    const checked = [...tokens].filter((t) => t.length >= 3 && !legit.has(t));
    expect(checked.length).toBeGreaterThan(100);
    for (const t of checked) {
      expect(new RegExp(`(?<![\\w-])${escape(t)}(?![\\w-])`).test(scanned), `"${t}" is in the log`).toBe(false);
      expect(scanned.includes(t) && t.length > 12, `"${t}" is in the log as text`).toBe(false);
    }

    // 3. only fixed fields, and only digests for the record
    for (const e of entries) {
      for (const key of Object.keys(e)) expect(LOG_FIELDS as readonly string[]).toContain(key);
      if (e.record) expect([e.record.model, e.record.batch].every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    }
    expect(logText).not.toMatch(/PM-|B-2026|H111|ALU|kg|MPa/);
  });

  it("logs the error code of a rejection but not the operator's own value, which the screen message may show", async () => {
    const r = await importErpCsv(pack, { bytes: fixtureBytes("n", "erp-decimal-comma.csv"), name: "erp-decimal-comma.csv", type: "text/csv" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const shown = r.errors.map((e) => e.message).join(" ");
    expect(shown).toMatch(/\d+,\d+/); // the screen names the value so the operator can fix it
    const log = new ExecutionLog(new MemoryLogStore());
    for (const e of importEvents(r)) await log.append(e);
    const logged = JSON.stringify(await log.entries());
    expect(logged).not.toMatch(/\d+,\d+/);
    expect(logged).toContain("decimal-comma");
    expect(logged).toContain(r.file.sha256);
    expect(logged).not.toContain("erp-decimal-comma.csv");
  });

  it("logs a file that was rejected before it was decoded without a digest", async () => {
    const r = await importErpCsv(pack, { bytes: new Uint8Array(10 * 1024 * 1024 + 1), name: "big.csv", type: "text/csv" });
    const [e] = importEvents(r);
    expect(e).toMatchObject({ event: "import-rejected", stage: "bytes", code: "too-large", fileRole: "erp" });
    expect(e).not.toHaveProperty("fileSha256");
  });

  it("has a code in the log's own list for every error the import can raise", async () => {
    const { LOG_CODES } = await import("../../src/model/log");
    for (const code of Object.keys(ERROR_TEXT)) expect(LOG_CODES).toContain(code);
    expect(await sha256Hex("x")).toHaveLength(64);
  });
});
