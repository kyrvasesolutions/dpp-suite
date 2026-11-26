// @vitest-environment node
/**
 * Codified repeatable adversarial & boundary mutation tests (C5-T2 / ADR-0002; aligned in Cycle 9):
 * 1. Canary redaction across execution logs, customer PDF and RegistryRequest JSON (filenames, reasons, denied & raw derived values).
 * 2. Formula-injection and control-character attempts introduced through operator corrections.
 * 3. Impossibility of silent or unauthorized corrections, or re-sealed central-record tampering.
 * 4. Hostile input limits: over-size bytes, deep stack-safe JSON nesting, multi-row ERP extracts with zero partial success, and deadlines.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { exportCentralRecord, importCentralRecord } from "../../src/model/centralRecord";
import { CorrectionError, correctRecord, storeImport } from "../../src/model/correction";
import { buildRecords, byRole, importErpCsv, importLabJson } from "../../src/model/ingress";
import {
  ExecutionLog,
  MemoryLogStore,
  correctionEvent,
  exportLog,
  importEvents,
  readinessEvents,
  recordExportEvent,
  recordImportEvent,
  releaseEvents,
  sanitise,
} from "../../src/model/log";
import { generateRelease } from "../../src/model/outputs/release";
import type { ProfilePack } from "../../src/model/profile";
import { assess } from "../../src/model/readiness";
import { MemoryRepository } from "../../src/model/recordRepository";
import { assertNoLeakText } from "../support/leak";
import { pdfText } from "../support/pdfText";
import { CLEAN, loadPack, propertyBySlug, recordFor, text } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const enc = (s: string) => new TextEncoder().encode(s);

let pack: ProfilePack;

beforeAll(async () => {
  pack = await loadPack();
});

describe("adversarial canary scan: restricted content never enters logs or unauthorized outputs", () => {
  it("strips canary values, filenames, reasons and arbitrary extra fields from the execution log", async () => {
    const ERP_FILENAME_CANARY = "SECRET-ERP-FILE-CANARY-991.csv";
    const LAB_FILENAME_CANARY = "SECRET-LAB-FILE-CANARY-992.json";
    const REASON_CANARY = "CONFIDENTIAL-CORRECTION-REASON-993";
    const NARRATIVE_CANARY = "LIVE-NARRATIVE-CANARY-994";
    const EXTRA_SECRET_CANARY = "INJECTED-LOG-PAYLOAD-995";

    const erpRes = await importErpCsv(pack, { bytes: enc(text(CLEAN.erp)), name: ERP_FILENAME_CANARY, type: "text/csv" });
    const labRes = await importLabJson(pack, { bytes: enc(text(CLEAN.lab)), name: LAB_FILENAME_CANARY, type: "application/json" });
    expect(erpRes.ok && labRes.ok).toBe(true);
    const built = await buildRecords([erpRes, labRes], pack);
    const rec = built.records[0]!;

    const log = new ExecutionLog(new MemoryLogStore());
    for (const e of [...importEvents(erpRes), ...importEvents(labRes)]) await log.append(e);

    const repo = new MemoryRepository();
    const v1 = (await storeImport(repo, rec)).snapshot;
    const narrativeId = propertyBySlug(pack, "product-narrative");
    const narrativeVal = v1.record.values.find((v) => v.property === narrativeId && v.assertions[0]?.details?.language === "en")!;
    const v2 = await correctRecord(pack, repo, {
      model: v1.model,
      batch: v1.batch,
      property: narrativeId,
      qualifier: narrativeVal.qualifier,
      raw: NARRATIVE_CANARY,
      reason: REASON_CANARY,
    });
    await log.append(await correctionEvent(v2.model, v2.batch, v2.version));

    const rReadiness = assess(pack, v2.record);
    for (const e of await readinessEvents(v2.model, v2.batch, rReadiness, v2.version)) await log.append(e);

    const release = await generateRelease(pack, v2, { software: TEST_SOFTWARE });
    for (const e of await releaseEvents(v2.model, v2.batch, v2.version, release.outcomes)) await log.append(e);

    const exported = await exportCentralRecord(repo, pack, v2.model, v2.batch);
    await log.append(await recordExportEvent(v2.model, v2.batch, v2.version));
    await importCentralRecord(exported.bytes, pack);
    await log.append(await recordImportEvent(v2.model, v2.batch, v2.version));

    const hostile = sanitise({
      event: "correction",
      outcome: "corrected",
      raw: NARRATIVE_CANARY,
      reason: REASON_CANARY,
      fileName: ERP_FILENAME_CANARY,
      freeText: EXTRA_SECRET_CANARY,
      code: EXTRA_SECRET_CANARY,
      ruleId: "NOT-A-RULE-SECRET",
      record: { model: v2.model, batch: v2.batch },
    });
    await log.append(hostile);

    const logText = new TextDecoder().decode((await exportLog(log)).bytes);
    for (const canary of [ERP_FILENAME_CANARY, LAB_FILENAME_CANARY, REASON_CANARY, NARRATIVE_CANARY, EXTRA_SECRET_CANARY, v2.model, v2.batch]) {
      expect(logText, `canary ${canary} must not appear in log`).not.toContain(canary);
    }

    const pdf = await pdfText(release.files.find((f) => f.route === "customer")!.bytes);
    assertNoLeakText(pdf, "customer", v2.record, pack);
    expect(pdf).not.toContain(REASON_CANARY);
    expect(pdf).not.toContain(ERP_FILENAME_CANARY);
    expect(pdf).not.toContain(LAB_FILENAME_CANARY);

    const reg = new TextDecoder().decode(release.files.find((f) => f.route === "registry")!.bytes);
    assertNoLeakText(reg, "registry", v2.record, pack);
    expect(reg).not.toContain(REASON_CANARY);
  });
});

describe("adversarial corrections: formula injection and control characters stay neutralized", () => {
  const formulaPayloads = ["=CMD", "+1+1", "-2+3", "@SUM"];

  const parseCsvRow = (line: string) => {
    const cells: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') inQuotes = false;
        else cur += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    return cells;
  };

  it.each(formulaPayloads)("neutralizes %s in internal ERP CSV customer_material_code and counts it in the manifest", async (payload) => {
    const repo = new MemoryRepository();
    const rec = await recordFor(pack, {
      ...CLEAN,
      editErp: (csv) => csv.replace(",004215,", `,${payload},`),
    });
    const v1 = (await storeImport(repo, rec)).snapshot;
    const release = await generateRelease(pack, v1, { software: TEST_SOFTWARE });
    const csv = new TextDecoder().decode(release.files.find((f) => f.route === "internal")!.bytes);
    const [headerLine, dataLine] = csv.trimEnd().split("\n");
    const colIdx = headerLine.split(",").indexOf("customer_material_code");
    expect(colIdx).toBeGreaterThanOrEqual(0);

    const cells = parseCsvRow(dataLine);
    expect(cells).toHaveLength(headerLine.split(",").length);
    const cell = cells[colIdx];
    expect(cell.startsWith("'"), `formula payload ${payload} must be apostrophe-prefixed (got ${cell})`).toBe(true);
    expect(release.manifest.formulaPrefixedCells).toBeGreaterThanOrEqual(1);
  });

  it.each(["=CMD|' /C calc'!A0", "+1+1", "-2+3", "@SUM(A1:A10)"])("neutralizes %s when introduced via an operator correction on customer material code", async (payload) => {
    const repo = new MemoryRepository();
    const rec = await recordFor(pack, CLEAN);
    const v1 = (await storeImport(repo, rec)).snapshot;
    const custArtId = propertyBySlug(pack, "customer-article-number");
    const target = v1.record.values.find((v) => v.property === custArtId && v.member === "FLD-Identifier-value")!;

    const v2 = await correctRecord(pack, repo, {
      model: v1.model,
      batch: v1.batch,
      property: custArtId,
      member: target.member,
      raw: payload,
      reason: "Testing formula neutralization via correction",
    });
    const release = await generateRelease(pack, v2, { software: TEST_SOFTWARE });
    const csv = new TextDecoder().decode(release.files.find((f) => f.route === "internal")!.bytes);
    const [headerLine, dataLine] = csv.trimEnd().split("\n");
    const colIdx = headerLine.split(",").indexOf("customer_material_code");
    const cell = parseCsvRow(dataLine)[colIdx]!;
    expect(/^[=+\-@\t\r]/.test(cell), `cell ${cell} must not begin with a formula trigger`).toBe(false);
    expect(cell.startsWith("'")).toBe(true);
    expect(release.manifest.formulaPrefixedCells).toBeGreaterThanOrEqual(1);
  });

  it("refuses control characters (CR, LF, TAB, NUL) in both corrected values and correction reasons", async () => {
    const repo = new MemoryRepository();
    const rec = await recordFor(pack, CLEAN);
    const v1 = (await storeImport(repo, rec)).snapshot;
    const productNameId = propertyBySlug(pack, "product-name");
    const target = v1.record.values.find((v) => v.property === productNameId)!;

    for (const bad of ["=1\r2", "line1\nline2", "bad\tvalue", "null\u0000byte"]) {
      await expect(
        correctRecord(pack, repo, { model: v1.model, batch: v1.batch, property: productNameId, member: target.member, qualifier: target.qualifier, raw: bad, reason: "valid reason" }),
      ).rejects.toThrow(CorrectionError);
      await expect(
        correctRecord(pack, repo, { model: v1.model, batch: v1.batch, property: productNameId, member: target.member, qualifier: target.qualifier, raw: "Valid Name", reason: bad }),
      ).rejects.toThrow(CorrectionError);
    }
    expect(await repo.history(v1.model, v1.batch)).toHaveLength(1);
  });
});

describe("adversarial input limits: over-limit and hostile inputs fail cleanly with zero partial output", () => {
  it("refuses 1 byte over max_file_bytes before decoding, for both ERP and Lab inputs", async () => {
    const over = new Uint8Array(pack.policy.limits.max_file_bytes + 1);
    over.fill(0x41);
    const erpRes = await importErpCsv(pack, { bytes: over, name: "huge.csv", type: "text/csv" });
    expect(erpRes.ok).toBe(false);
    if (!erpRes.ok) {
      expect(erpRes.stage).toBe("bytes");
      expect(erpRes.errors[0].code).toBe("too-large");
    }
    const labRes = await importLabJson(pack, { bytes: over, name: "huge.json", type: "application/json" });
    expect(labRes.ok).toBe(false);
    if (!labRes.ok) {
      expect(labRes.stage).toBe("bytes");
      expect(labRes.errors[0].code).toBe("too-large");
    }
  });

  it("rejects extreme 10,000-level JSON nesting at parse stage with too-deep and zero stack overflow", async () => {
    const depth = 10_000;
    const payload = `${"[".repeat(depth)}0${"]".repeat(depth)}`;
    const res = await importLabJson(pack, { bytes: enc(payload), name: "deep-10000.json", type: "application/json" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.stage).toBe("parse");
      expect(res.errors[0].code).toBe("too-deep");
    }
  });

  it("rejects multi-row ERP extracts (2 and 5 rows) with multiple-records and produces zero records", async () => {
    const [header, row] = text(CLEAN.erp).trimEnd().split(/\r?\n/);
    for (const count of [2, 5]) {
      const rows = Array.from({ length: count }, (_, i) => row.replace("ST-LOT-2026-001", `ST-LOT-2026-04${i}`));
      const csv = `${header}\n${rows.join("\n")}\n`;
      const res = await importErpCsv(pack, { bytes: enc(csv), name: `multi-${count}.csv`, type: "text/csv" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.stage).toBe("structure");
        expect(res.errors[0].code).toBe("multiple-records");
      }
      const built = await buildRecords([res], pack);
      expect(built.records).toHaveLength(0);
    }
  });

  it("enforces the shared job deadline across the two-file pair and during central-record import", async () => {
    let clock = 0;
    const now = () => clock;
    const startedAt = 0;

    const erpRes = await importErpCsv(pack, { bytes: enc(text(CLEAN.erp)), name: CLEAN.erp, type: "text/csv", now, startedAt });
    expect(erpRes.ok).toBe(true);
    clock = pack.policy.limits.job_deadline_ms + 5;
    const labRes = await importLabJson(pack, { bytes: enc(text(CLEAN.lab)), name: CLEAN.lab, type: "application/json", now, startedAt });
    expect(labRes.ok).toBe(false);
    if (!labRes.ok) expect(labRes.errors[0].code).toBe("deadline");

    const repo = new MemoryRepository();
    const rec = await recordFor(pack, CLEAN);
    await storeImport(repo, rec);
    const exported = await exportCentralRecord(repo, pack, rec.model, rec.batch);
    let ticks = 0;
    await expect(
      importCentralRecord(exported.bytes, pack, "ACT-01", () => (ticks++ === 0 ? 0 : pack.policy.limits.job_deadline_ms + 10)),
    ).rejects.toThrow(/time limit|deadline/i);
  });

  it("refuses unauthorized roles and forbidden identity/evidence targets on correction", async () => {
    const repo = new MemoryRepository();
    const rec = await recordFor(pack, CLEAN);
    const v1 = (await storeImport(repo, rec)).snapshot;
    const thicknessId = propertyBySlug(pack, "nominal-thickness");

    for (const actor of ["", "ACT-06", "ACT-17", "ACT-19", "ACT-20", "admin"]) {
      await expect(
        correctRecord(pack, repo, { model: v1.model, batch: v1.batch, property: thicknessId, raw: "2.5", reason: "Unauthorized attempt" }, actor),
      ).rejects.toThrow(/Only the operator/);
    }
    for (const role of ["model", "batch", "evidence"] as const) {
      const target = v1.record.values.find((v) => v.property === byRole(pack, role))!;
      await expect(
        correctRecord(pack, repo, { model: v1.model, batch: v1.batch, property: target.property, member: target.member, qualifier: target.qualifier, raw: "FORGED-1", reason: "Attempt" }),
      ).rejects.toThrow(/cannot be corrected by hand/);
    }
    expect(await repo.history(v1.model, v1.batch)).toHaveLength(1);
  });
});
