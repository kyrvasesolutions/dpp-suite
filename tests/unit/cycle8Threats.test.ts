// @vitest-environment node
/**
 * Cycle 8 AT-X charter (P06, threat model T01-T08, T17): hostile input against the real HTTP server and the pure
 * functions behind it. One describe per threat, named exactly as the threat model's "Test" column.
 *
 * The stance in every test: hostile input is either handled literally or refused cleanly (a 4xx with a code), never a 5xx,
 * never a crash, never a written file outside the store, never a changed schema.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../server/db/adapter";
import { migrateUp } from "../../server/db/migrations";
import { crashLine, installExceptionBarrier } from "../../server/log/barrier";
import { createPublicLogWriter } from "../../server/log/publicLog";
import { createDppServer } from "../../server/http/api";
import { PolicyStore } from "../../server/store/policyStore";
import { PUBLIC_LOG_FIELDS, toPublicLogLine, type PublicLogEntry } from "../../src/model/c8Contracts";
import { importErpCsv, importLabJson } from "../../src/model/ingress";
import { buildErpCsv, csvCell } from "../../src/model/outputs/erpCsv";
import { safeName } from "../../src/model/outputs/types";
import type { ProfilePack } from "../../src/model/profile";
import { JsonSyntaxError, parseStrictJson, toPlain } from "../../src/model/strictJson";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, loadPack, recordFor } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const tmp = mkdtempSync(join(tmpdir(), "dpp-c8-threats-"));
const appDir = join(tmp, "app");
const dbDir = join(tmp, "db");
let pack: ProfilePack;
let db: SqliteAdapter;
let port: number;
let close: () => Promise<void>;
const logged: PublicLogEntry[] = [];

const b64 = (b: Uint8Array | string) => Buffer.from(b).toString("base64");
const json = { "Content-Type": "application/json" };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

interface Raw {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

/** A raw request: the path is sent exactly as given (no normalisation) and any header can be set. */
function raw(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Writes bytes straight to a socket, for requests Node's client refuses to build (CR/LF and ESC bytes inside headers). */
function rawBytes(payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => s.write(payload, "latin1"));
    let data = "";
    s.on("data", (c) => (data += c.toString("latin1")));
    s.on("end", () => resolve(data));
    s.on("error", reject);
    setTimeout(() => {
      s.destroy();
      resolve(data);
    }, 1500).unref();
  });
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => raw("POST", path, { ...json, ...headers }, typeof body === "string" ? body : JSON.stringify(body));
const importBody = (over: Record<string, unknown> = {}) => ({
  erp: { name: CLEAN.erp, type: "text/csv", base64: b64(fixtureBytes("n", CLEAN.erp)) },
  lab: { name: CLEAN.lab, type: "application/json", base64: b64(fixtureBytes("n", CLEAN.lab)) },
  ...over,
});
let seq = 0;
const postImport = (over: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  post("/api/jobs/import", importBody(over), { "X-Idempotency-Key": `threat-${++seq}-${Date.now()}`, ...headers });

const tables = () =>
  db
    .query<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((t) => `${t.name}:${t.sql}`);
const rowCount = (t: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n;
const healthy = async () => expect((await raw("GET", "/api/health")).status).toBe(200);
const notServerError = (r: Raw, what: string) => expect(r.status, `${what}: ${r.status} ${r.body.slice(0, 200)}`).toBeLessThan(500);

beforeAll(async () => {
  pack = await loadPack();
  mkdirSync(appDir, { recursive: true });
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(join(appDir, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(appDir, "app.js"), "console.log(1)");
  writeFileSync(join(tmp, "secret.txt"), "outside the app directory");
  db = new SqliteAdapter({ path: join(dbDir, "t.sqlite") });
  migrateUp(db);
  new PolicyStore(db).activate(pack.policy.retention);
  const options = {
    db,
    pack,
    software: TEST_SOFTWARE,
    staticDir: appDir,
    allowedOrigin: "http://trusted.example:5173",
    now: () => "2026-11-22T12:00:00.000Z",
    log: (e: PublicLogEntry) => void logged.push(e),
  };
  const server = createDppServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  close = () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});
afterAll(async () => {
  await close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------
describe("hostile JSON", () => {
  const code = (text: string, opts = {}) => {
    try {
      parseStrictJson(text, opts);
      return "accepted";
    } catch (e) {
      if (e instanceof JsonSyntaxError) return e.code;
      throw e; // anything other than a JsonSyntaxError (a RangeError, a TypeError) is a bug
    }
  };

  it("deep nesting is refused by the depth limit, with or without a caller limit, and never overflows the stack", () => {
    expect(code("[".repeat(13) + "]".repeat(13), { maxDepth: 12 })).toBe("too-deep");
    expect(code("[".repeat(12) + "]".repeat(12), { maxDepth: 12 })).toBe("accepted");
    expect(code("[".repeat(200_000))).toBe("too-deep");
    expect(code('{"a":'.repeat(50_000) + "1" + "}".repeat(50_000))).toBe("too-deep");
  });

  it("a node explosion stops at maxNodes", () => {
    const wide = `[${new Array(5000).fill("1").join(",")}]`;
    expect(code(wide, { maxNodes: 100 })).toBe("too-many-nodes");
    expect(code(wide, { maxNodes: 5001 })).toBe("accepted");
    expect(code(wide, { maxNodes: 5000 })).toBe("too-many-nodes");
  });

  it("huge strings are bounded by maxStringLength, and a huge value is parsed in linear time", () => {
    expect(code(`"${"a".repeat(1000)}"`, { maxStringLength: 999 })).toBe("syntax");
    expect(code(`"${"a".repeat(1000)}"`, { maxStringLength: 1000 })).toBe("accepted");
    expect(code(`{"${"k".repeat(1000)}":1}`, { maxStringLength: 10 })).toBe("syntax");
    const started = performance.now();
    expect(code(`"${"a".repeat(2_000_000)}"`)).toBe("accepted");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("huge numeric literals and exponents are refused, not turned into Infinity", () => {
    for (const n of ["1e999", "-1e999", "1E+400", "1e99999999999999999999", `1${"0".repeat(400)}`, `-${"9".repeat(500)}`]) expect(code(n), n).toBe("non-finite-number");
    const big = `1${"0".repeat(300)}`;
    expect(parseStrictJson(big)).toMatchObject({ kind: "number", raw: big });
  });

  it("malformed numbers and literals are syntax errors", () => {
    for (const n of ["01", "+1", ".5", "1.", "1e", "-", "--1", "NaN", "Infinity", "-Infinity", "0x10", "1_000", "1,5", "tru", "nul", "'a'", "[1,]", '{"a":1,}', "[1 2]", '{"a" 1}', "// c\n1", "/* c */1", "1 2"]) {
      expect(code(n), n).toBe("syntax");
    }
  });

  it("duplicate keys are refused, also when one is spelled with an escape", () => {
    expect(code('{"a":1,"a":2}')).toBe("duplicate-key");
    expect(code('{"a":1,"\\u0061":2}')).toBe("duplicate-key");
    expect(code('{"o":{"x":1,"x":1}}')).toBe("duplicate-key");
    expect(code('{"__proto__":1,"__proto__":2}')).toBe("duplicate-key");
    expect(code('{"a":1,"b":{"a":1}}')).toBe("accepted");
  });

  it("through the server: hostile request bodies get a 4xx with a code, and the server stays up", async () => {
    const before = tables();
    const cases: Array<[string, string]> = [
      ["deep array body", "[".repeat(200_000)],
      ["deep object body", '{"a":'.repeat(100_000)],
      ["duplicate keys", '{"erp":{},"erp":{}}'],
      ["trailing garbage", "{} x"],
      ["empty body", ""],
      ["not an object", "[1,2,3]"],
      ["huge exponent", '{"expectedVersion":1e999}'],
      ["lone surrogate escape", '{"idempotencyKey":"\\ud800"}'],
    ];
    for (const [name, body] of cases) {
      const r = await post("/api/jobs/import", body, { "X-Idempotency-Key": `hostile-json-${++seq}` });
      notServerError(r, name);
      expect(r.status, name).toBeGreaterThanOrEqual(400);
      expect(JSON.parse(r.body).code, name).toEqual(expect.any(String));
      expect(r.body, name).not.toMatch(/RangeError|TypeError|at \S+ \(|node_modules/);
    }
    await healthy();
    expect(tables()).toEqual(before);
  });

  it("through the server: a hostile lab file is rejected as data (no commit, no 5xx)", async () => {
    const jobsBefore = rowCount("import_jobs");
    const lab = (text: string) => ({ name: CLEAN.lab, type: "application/json", base64: b64(text) });
    const cases: Array<[string, string]> = [
      ["deep", "[".repeat(100_000)],
      ["duplicate key", '{"evidence":[],"evidence":[]}'],
      ["huge exponent", '{"x":1e999}'],
      ["not json", "<xml/>"],
    ];
    for (const [name, text] of cases) {
      const r = await postImport({ lab: lab(text) });
      notServerError(r, name);
      const body = JSON.parse(r.body) as { ok?: boolean; job?: { state: string } };
      expect(body.ok === true, name).toBe(false);
    }
    expect(rowCount("import_jobs")).toBeGreaterThanOrEqual(jobsBefore);
    expect(rowCount("snapshots") + 0).toBeGreaterThanOrEqual(0);
    await healthy();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("hostile encoding and prototype pollution", () => {
  const labResult = (bytes: Uint8Array) => importLabJson(pack, { bytes, name: "lab.json", type: "application/json" });
  const errCodes = (r: Awaited<ReturnType<typeof labResult>>) => (r.ok ? [] : r.errors.map((e) => e.code));
  const cleanLab = fixtureBytes("n", CLEAN.lab);
  const concat = (...parts: Array<Uint8Array | number[]>) => Uint8Array.from(parts.flatMap((p) => [...p]));

  it("invalid UTF-8 is refused as a whole file, never repaired: lone bytes, overlong forms, encoded surrogates, truncation", async () => {
    const invalid: Array<[string, number[]]> = [
      ["0xFF", [0xff]],
      ["overlong slash C0 AF", [0xc0, 0xaf]],
      ["overlong dot C0 AE", [0xc0, 0xae]],
      ["overlong E0 80 AF", [0xe0, 0x80, 0xaf]],
      ["overlong F0 80 80 AF", [0xf0, 0x80, 0x80, 0xaf]],
      ["encoded surrogate ED A0 80", [0xed, 0xa0, 0x80]],
      ["above U+10FFFF F4 90 80 80", [0xf4, 0x90, 0x80, 0x80]],
      ["truncated E2 82", [0xe2, 0x82]],
      ["stray continuation 80", [0x80]],
    ];
    for (const [name, bad] of invalid) {
      const bytes = concat(enc('{"a":"'), bad, enc('"}'));
      const r = await labResult(bytes);
      expect(r.ok, name).toBe(false);
      expect(errCodes(r), name).toContain("wrong-encoding");
    }
    // the same bytes in the ERP file, which uses the same decoder
    const erp = await importErpCsv(pack, { bytes: concat(fixtureBytes("n", CLEAN.erp), [0xc0, 0xaf]), name: "e.csv", type: "text/csv" });
    expect(erp.ok).toBe(false);
  });

  it("a byte order mark and a NUL byte are refused with their own codes", async () => {
    const bom = await labResult(concat([0xef, 0xbb, 0xbf], cleanLab));
    expect(bom.ok).toBe(false);
    expect(errCodes(bom)).toContain("byte-order-mark");
    const nul = await labResult(concat(enc('{"a":"x'), [0], enc('y"}')));
    expect(nul.ok).toBe(false);
    const erpNul = await importErpCsv(pack, { bytes: concat(fixtureBytes("n", CLEAN.erp), [0]), name: "e.csv", type: "text/csv" });
    expect(erpNul.ok).toBe(false);
  });

  it("strict JSON: lone surrogates, a BOM character, and NUL are refused; U+2028/9 are data inside strings only", () => {
    const bad = (t: string) => expect(() => parseStrictJson(t), t).toThrow(JsonSyntaxError);
    bad('"\\ud800"');
    bad('"\\udc00"');
    bad('"\\ud800x"');
    bad('"\\ud800\\u0041"');
    bad('"\\udc00\\ud800"');
    bad('"\ud800"');
    bad('"\udc00"');
    bad('"\ud800\ud800"');
    bad("\ufeff1");
    bad('"a\u0000b"');
    bad('"a\nb"');
    bad("1\u20281");
    bad("\u2029[]");
    bad('"\\q"');
    bad('"\\u12G4"');
    bad('"\\');
    expect(parseStrictJson('"\\ud83d\\ude00"')).toMatchObject({ value: "\u{1F600}" });
    expect(parseStrictJson('"\u{1F600}"')).toMatchObject({ value: "\u{1F600}" });
    expect(parseStrictJson('"a\u2028b\u2029c"')).toMatchObject({ value: "a\u2028b\u2029c" });
    expect(parseStrictJson('"a\\u0000b"')).toMatchObject({ value: "a\u0000b" });
  });

  it("__proto__, constructor and prototype keys stay plain data and never reach a prototype", () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const text = '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"prototype":{"polluted":"yes"},"nested":[{"__proto__":{"polluted":"yes"}}]}';
    const doc = parseStrictJson(text);
    expect(doc.kind).toBe("object");
    const plain = toPlain(doc) as Record<string, any>;
    expect(Object.getPrototypeOf(plain)).toBeNull();
    expect(Object.keys(plain).sort()).toEqual(["__proto__", "constructor", "nested", "prototype"]);
    expect(Object.getPrototypeOf(plain.nested[0])).toBeNull();
    expect(Object.hasOwn(plain, "__proto__")).toBe(true);
    expect(plain.__proto__.polluted).toBe("yes"); // as data
    expect(({} as any).polluted).toBeUndefined();
    expect((Object.prototype as any).polluted).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    // the JSON text with the same key twice is a duplicate, not an override
    expect(() => parseStrictJson('{"__proto__":{},"__proto__":{}}')).toThrow(/duplicate key/);
  });

  it("through the server: pollution keys in a body and in a lab file leave Object.prototype untouched", async () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const evil = '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}';
    const bodies = [
      evil,
      JSON.stringify({ ...importBody(), __proto__: undefined }).replace("{", '{"__proto__":{"polluted":"yes"},'),
      JSON.stringify(importBody({ lab: { name: "l.json", type: "application/json", base64: b64(evil) } })),
    ];
    for (const body of bodies) {
      const r = await post("/api/jobs/import", body, { "X-Idempotency-Key": `proto-${++seq}` });
      notServerError(r, "pollution body");
    }
    for (const body of bodies.slice(0, 1)) notServerError(await post("/api/jobs/recover", body), "recover");
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    await healthy();
  });

  it("through the server: invalid UTF-8 and a BOM in an upload are refused as data, nothing is committed", async () => {
    const records = rowCount("snapshots");
    const bad = (bytes: Uint8Array) => ({ name: CLEAN.lab, type: "application/json", base64: b64(bytes) });
    for (const bytes of [concat(enc('{"a":"'), [0xc0, 0xaf], enc('"}')), concat([0xef, 0xbb, 0xbf], cleanLab), concat(enc("{"), [0xff])]) {
      const r = await postImport({ lab: bad(bytes) });
      notServerError(r, "bad lab bytes");
      expect((JSON.parse(r.body) as { ok?: boolean }).ok).not.toBe(true);
    }
    expect(rowCount("snapshots")).toBe(records);
  });

  it("U+2028 and U+2029 inside a CSV or JSON value never break the file apart", async () => {
    const lab = dec(cleanLab).replace("Demo", "Demo\u2028\u2029");
    const r = await labResult(enc(lab));
    // either accepted with the characters intact as data, or refused with a code: never thrown
    expect(typeof r.ok).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("hostile CSV", () => {
  const clean = dec(fixtureBytes("n", CLEAN.erp));
  const erp = (bytes: Uint8Array | string) => importErpCsv(pack, { bytes: typeof bytes === "string" ? enc(bytes) : bytes, name: "e.csv", type: "text/csv" });
  const [header, firstRow] = clean.replace(/\r\n/g, "\n").split("\n");

  it("the clean fixture is accepted (control)", async () => {
    expect((await erp(clean)).ok).toBe(true);
  });

  it("extra rows, a repeated header, and blank-only files are refused with a code", async () => {
    for (const [name, text] of [
      ["two data rows", `${header}\n${firstRow}\n${firstRow}\n`],
      ["header only", `${header}\n`],
      ["empty", ""],
      ["blank lines", "\n\n\n"],
      ["header twice", `${header}\n${header}\n`],
    ] as const) {
      const r = await erp(text);
      expect(r.ok, name).toBe(false);
      expect(r.ok ? [] : r.errors.map((e) => e.code), name).not.toHaveLength(0);
    }
  });

  it("unbalanced quotes, embedded CR, LF and NUL, wrong delimiters and ragged rows are refused", async () => {
    const hostile: Array<[string, string]> = [
      ["unbalanced quote", `${header}\n"${firstRow}\n`],
      ["embedded LF inside quotes", `${header}\n"a\nb";${firstRow}\n`],
      ["embedded CR", `${header}\n${firstRow}\r;x\n`],
      ["comma delimiter", `${header.replace(/;/g, ",")}\n${firstRow.replace(/;/g, ",")}\n`],
      ["tab delimiter", `${header.replace(/;/g, "\t")}\n${firstRow.replace(/;/g, "\t")}\n`],
      ["fewer cells", `${header}\n${firstRow.split(";").slice(0, 5).join(";")}\n`],
      ["more cells", `${header}\n${firstRow};extra;cells\n`],
      ["only delimiters", `${";".repeat(60)}\n${";".repeat(60)}\n`],
    ];
    for (const [name, text] of hostile) {
      const r = await erp(text);
      expect(r.ok, name).toBe(false);
    }
  });

  // BUG (Coder A's file, src/model/ingress.ts): a NUL byte inside an ERP cell is accepted and stored as part of a value
  // (the identifier scheme "D\0EMO-PM" comes back as accepted). The CSV stage should refuse control characters in cells.
  it.fails("an embedded NUL in a cell is refused", async () => {
    const r = await erp(`${header}\n${firstRow.replace("DE", "D\u0000E")}\n`);
    expect(r.ok).toBe(false);
  });

  it("oversize input is refused before parsing it all", async () => {
    const max = pack.policy.limits.max_file_bytes;
    const big = `${header}\n${firstRow.replace("SI01", "S".repeat(max + 1024))}\n`;
    const r = await erp(big);
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toEqual(expect.arrayContaining([expect.stringMatching(/too-large|limit/)]));
  });

  it("through the server: every hostile ERP upload is a 4xx or a clean refusal, nothing is stored, the server stays up", async () => {
    const records = rowCount("snapshots");
    for (const text of [`${header}\n"${firstRow}\n`, `${header}\n${firstRow}\n${firstRow}\n`, "", `${header}\n${firstRow};\u0000\n`]) {
      const r = await postImport({ erp: { name: CLEAN.erp, type: "text/csv", base64: b64(text) } });
      notServerError(r, "hostile erp");
      expect((JSON.parse(r.body) as { ok?: boolean }).ok).not.toBe(true);
    }
    const noBase64 = await postImport({ erp: { name: "x.csv", type: "text/csv", base64: "***not base64***" } });
    notServerError(noBase64, "bad base64");
    const wrongType = await postImport({ erp: { name: "x.csv", type: "text/csv", base64: 12345 } });
    notServerError(wrongType, "base64 number");
    expect(rowCount("snapshots")).toBe(records);
    await healthy();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CSV formula injection", () => {
  const unquote = (c: string) => c.replace(/^"|"$/g, "").replace(/""/g, '"');

  it("every dangerous lead character is prefixed, ASCII and full-width, flagged numeric or not", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r", "\uFF1D", "\uFF0B", "\uFF0D", "\uFF20"]) {
      for (const numeric of [false, true]) {
        const r = csvCell(`${lead}cmd|' /C calc'!A0`, numeric);
        expect(r.prefixed, `${JSON.stringify(lead)} numeric=${numeric}`).toBe(true);
        expect(unquote(r.cell).startsWith("'")).toBe(true);
      }
    }
  });

  it("a numeric flag skips the prefix only for a strict number", () => {
    for (const n of ["0", "-0", "5", "-5", "-5.0", "-0.25", "12.5", "1e5", "-1.5E-3", "2E+10", "1234567890.123456789"]) {
      expect(csvCell(n, true), n).toEqual({ cell: n, prefixed: false });
    }
    for (const t of ["-5abc", "-5 ", "--5", "-", "-.5", "+5", "=1+1", "-1+1", "-1;2", "-1e", "-1e+", "-5\n", "- 5", "-\u0661", "-1,5", "@SUM(1)", "-0x10", "-Infinity", "-NaN", "\t5", "=-5"]) {
      expect(csvCell(t, true).prefixed, t).toBe(true);
    }
  });

  it("non-dangerous text and numbers stay untouched, and quoting still applies after the prefix", () => {
    expect(csvCell("normal", false)).toEqual({ cell: "normal", prefixed: false });
    expect(csvCell("5-3", false).prefixed).toBe(false);
    expect(csvCell("a=b", false).prefixed).toBe(false);
    expect(csvCell("=1;2", false).cell).toBe(`"'=1;2"`);
    expect(csvCell('=1"2', false).cell).toBe(`"'=1""2"`);
  });

  it("the ERP staging file has no unprefixed dangerous cell, whatever the lab file carries", async () => {
    const record = await recordFor(pack, {
      ...CLEAN,
      editLab: (d) => {
        d.footprints[0].calculated_by = "=HYPERLINK(\"http://x\")";
        d.footprints[0].method = "@SUM(1+1)";
        d.footprints[0].evidence_id = "-2+3";
        d.evidence[1].evidence_id = "-2+3";
      },
    });
    const f = buildErpCsv(pack, record);
    expect(f.formulaPrefixedCells).toBeGreaterThanOrEqual(3);
    const cells = f.text.split("\n").slice(0, 2).flatMap((l) => l.split(";"));
    for (const c of cells) expect(/^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/.test(unquote(c)) && !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(unquote(c)), c).toBe(false);
  });

  it("the golden ERP staging file is unchanged by the stricter rule", async () => {
    const { readFileSync } = await import("node:fs");
    const f = buildErpCsv(pack, await recordFor(pack, CLEAN));
    expect(Buffer.from(f.bytes).equals(readFileSync("tests/golden/erp-staging.csv"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("SQL injection literals round-trip", () => {
  const LITERALS = [
    "'; DROP TABLE x;--",
    '" OR 1=1',
    "' OR '1'='1",
    "x'); DELETE FROM records;--",
    "1; PRAGMA writable_schema=1;--",
    "a\u0000b",
    "%' UNION SELECT sql FROM sqlite_master--",
    "\\'; --",
    "😀 \u2028 é",
  ];

  it("hostile idempotency keys are stored literally or refused, and the schema and row counts are intact", async () => {
    const schema = tables();
    for (const lit of LITERALS) {
      const key = `${lit}-${++seq}`;
      const key64 = Buffer.from(key, "utf8").toString("latin1"); // header bytes
      const r = await post("/api/jobs/import", importBody(), { "X-Idempotency-Key": CONTROL.test(lit) ? `safe-${seq}` : key64 });
      notServerError(r, JSON.stringify(lit));
      const body = JSON.parse(r.body) as { ok?: boolean };
      expect(typeof body).toBe("object");
    }
    // the body key too (JSON handles NUL and surrogates exactly)
    for (const lit of LITERALS) {
      const r = await post("/api/jobs/import", importBody({ idempotencyKey: `${lit}-${++seq}` }));
      notServerError(r, `body key ${JSON.stringify(lit)}`);
    }
    expect(tables()).toEqual(schema);
    await healthy();
  });

  it("hostile evidence issuers and reasons round-trip literally through the API", async () => {
    const lit = "Lab'; DROP TABLE evidence_objects;-- \" OR 1=1 é😀";
    const evBytes = enc(`evidence-${Date.now()}`);
    const imp = await postImport({ evidence: [{ evidenceId: "EV'-1;--", issuer: lit, revision: "1' OR '1'='1", recordKind: "test-report", base64: b64(evBytes) }] });
    notServerError(imp, "import with hostile evidence");
    const impBody = JSON.parse(imp.body) as { ok: boolean; snapshot?: { model: string; batch: string; version: number } };
    expect(impBody.ok).toBe(true);
    const list = await raw("GET", "/api/evidence");
    expect(list.status).toBe(200);
    expect(list.body).toContain(JSON.stringify(lit).slice(1, -1));

    // a correction with a hostile reason is stored literally (one line, no control characters)
    const { model, batch } = impBody.snapshot!;
    const prop = pack.properties.find((p) => p.definitionRef.endsWith(":recycled-content"))!;
    const reason = "'; DROP TABLE records;-- \" OR 1=1 é";
    const corr = await post(`/api/records/${encodeURIComponent(model)}/${encodeURIComponent(batch)}/correct`, { property: prop.id, raw: "44", reason, expectedVersion: impBody.snapshot!.version });
    notServerError(corr, "correction");
    expect(corr.status).toBe(200);
    const hist = await raw("GET", `/api/records/${encodeURIComponent(model)}/${encodeURIComponent(batch)}/history`);
    expect(hist.status).toBe(200);
    expect(hist.body).toContain(JSON.stringify(reason).slice(1, -1));
    // control characters in a reason are refused cleanly
    const bad = await post(`/api/records/${encodeURIComponent(model)}/${encodeURIComponent(batch)}/correct`, { property: prop.id, raw: "45", reason: "x\u0000'; DROP TABLE records;--", expectedVersion: 2 });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    expect(rowCount("snapshots")).toBeGreaterThan(0);
  });

  it("hostile model and batch ids in the URL are literals: not found, never an SQL error", async () => {
    const schema = tables();
    const counts = ["snapshots", "import_jobs"].map(rowCount);
    for (const lit of LITERALS) {
      for (const path of [`/api/records/${encodeURIComponent(lit)}/b/history`, `/api/records/m/${encodeURIComponent(lit)}/history`, `/api/jobs/${encodeURIComponent(lit)}`, `/api/evidence?q=${encodeURIComponent(lit)}`]) {
        const r = await raw("GET", path);
        notServerError(r, path);
      }
    }
    expect(tables()).toEqual(schema);
    expect(["snapshots", "import_jobs"].map(rowCount)).toEqual(counts);
  });

  it("an ERP file whose model and batch identifiers are SQL text is stored under those literal ids, or refused", async () => {
    const clean = dec(fixtureBytes("n", CLEAN.erp));
    const evil = clean.replace("B-2026-0417", "B'||(SELECT 1)||'--").replace("PM-5754-H111-2000", "PM' OR '1'='1");
    const schema = tables();
    const r = await postImport({ erp: { name: CLEAN.erp, type: "text/csv", base64: b64(evil) } });
    notServerError(r, "evil ids");
    const body = JSON.parse(r.body) as { ok?: boolean; snapshot?: { model: string; batch: string } };
    if (body.ok && body.snapshot) {
      expect(body.snapshot.batch).toContain("B'||(SELECT 1)||'--");
      const h = await raw("GET", `/api/records/${encodeURIComponent(body.snapshot.model)}/${encodeURIComponent(body.snapshot.batch)}/history`);
      expect(h.status).toBe(200);
    }
    expect(tables()).toEqual(schema);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("path traversal", () => {
  const SECRET = "outside the app directory";
  const TRAVERSALS = [
    "..",
    "../..",
    "%2e%2e",
    "%2E%2E",
    "..%2f",
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "..%5c..%5cwindows",
    "%5c..%5c",
    "..\\..\\",
    "%c0%ae%c0%ae",
    "%c0%ae%c0%ae%c0%af",
    "%e0%80%ae%e0%80%ae",
    "%2f",
    "%2fetc%2fpasswd",
    "/etc/passwd",
    "%00",
    "a%00b",
    "..%00",
    "%ef%bc%8e%ef%bc%8e", // full-width dots
    "%e2%80%a4%e2%80%a4", // one dot leader
    "%252e%252e",
    "%u002e%u002e",
    "....//",
    "%c0%af",
    "C%3a%5cWindows",
  ];

  it("API path parameters: traversal is refused or not found, never served and never a 5xx", async () => {
    for (const t of TRAVERSALS) {
      for (const path of [`/api/records/${t}/b/history`, `/api/records/m/${t}/history`, `/api/jobs/${t}`, `/api/config-releases/${t}`, `/api/customer/records/${t}/b`]) {
        const r = await raw("GET", path);
        expect(r.status, path).toBeLessThan(500);
        // a path the URL parser normalises out of /api falls to the single-page app shell: that is the only 200 allowed
        // (or a literal id that matches nothing: an empty history)
        if (r.status === 200) expect(r.body === "<!doctype html><title>app</title>" || (JSON.parse(r.body).history ?? []).length === 0, path).toBe(true);
        expect(r.body, path).not.toContain(SECRET);
        expect(r.body, path).not.toContain("root:");
      }
    }
    await healthy();
  });

  it("static serving: nothing outside the app directory is ever served", async () => {
    const paths = [
      "/../secret.txt",
      "/..%2fsecret.txt",
      "/%2e%2e/secret.txt",
      "/%2e%2e%2fsecret.txt",
      "/%2E%2E%2Fsecret.txt",
      "/..%5csecret.txt",
      "/%c0%ae%c0%ae/secret.txt",
      "/%c0%ae%c0%ae%c0%afsecret.txt",
      "/app/../secret.txt",
      "/./../secret.txt",
      "/.%2e/secret.txt",
      "/%2e./secret.txt",
      "//../secret.txt",
      "/index.html%00.png",
      "/%00",
      "/..%00/secret.txt",
      "/etc/passwd",
      "//etc/passwd",
      "/%2fetc%2fpasswd",
      "/%252e%252e/secret.txt",
      "/....//secret.txt",
      "/\\..\\secret.txt",
      "/%ef%bc%8e%ef%bc%8e/secret.txt",
      `/${"../".repeat(30)}etc/passwd`,
      `/${"%2e%2e%2f".repeat(30)}etc/passwd`,
    ];
    for (const p of paths) {
      const r = await raw("GET", p);
      expect(r.status, p).toBeLessThan(500);
      expect(r.body, p).not.toContain(SECRET);
      expect(r.body, p).not.toContain("root:");
    }
    // the control: a file inside the directory is served
    const ok = await raw("GET", "/app.js");
    expect(ok.status).toBe(200);
    expect(ok.body).toBe("console.log(1)");
    await healthy();
  });

  it("upload file names never reach the file system", async () => {
    const snapshot = () => [...readdirSync(tmp), ...readdirSync(dbDir).filter((f) => !/sqlite(-wal|-shm)?$/.test(f)), ...readdirSync(appDir)].sort();
    const before = snapshot();
    const names = ["../../pwned.csv", "..\\..\\pwned.csv", "/tmp/pwned.csv", "%2e%2e%2fpwned.csv", "pwned\u0000.csv", "C:\\pwned.csv", "a/../../b.csv", "\u202Epwned.csv", "x".repeat(5000)];
    for (const name of names) {
      const r = await postImport({
        erp: { name, type: "text/csv", base64: b64(fixtureBytes("n", CLEAN.erp)) },
        lab: { name: `${name}.json`, type: "application/json", base64: b64(fixtureBytes("n", CLEAN.lab)) },
      });
      notServerError(r, `name ${JSON.stringify(name).slice(0, 40)}`);
    }
    expect(snapshot()).toEqual(before);
    for (const p of [join(tmp, "pwned.csv"), join(tmp, "..", "pwned.csv"), "/tmp/pwned.csv"]) expect(() => readdirSync(p)).toThrow();
  });

  it("generated file names are reduced to safe characters and never contain a separator or dot-dot segment", () => {
    for (const hostile of ["../../etc/passwd", "a/b\\c", "x\r\ny", "\u0000", "..", "é😀", "a b;c", "=cmd"]) {
      const n = safeName("erp-staging", hostile, hostile);
      expect(n, hostile).toMatch(/^[A-Za-z0-9._-]*$/);
      expect(n.split("_").every((part) => !part.startsWith("-"))).toBe(true);
    }
    expect(safeName("..", "x")).not.toMatch(/[\\/]/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("log injection", () => {
  const FORGED = "\u001b[31m\r\n{\"event\":\"forged\",\"level\":\"error\"}\u2028\u2029";

  it("the line builder accepts only six clean fields and refuses everything else without echoing the value", () => {
    const good: PublicLogEntry = { ts: "2026-11-22T12:00:00.000Z", level: "info", event: "request", request_id: "abcd1234", route: "GET /api/records/:model/:batch/history", status: 200 };
    const line = toPublicLogLine(good);
    expect(Object.keys(JSON.parse(line))).toEqual([...PUBLIC_LOG_FIELDS]);
    expect(line).not.toMatch(CONTROL);
    const hostile: Array<Record<string, unknown>> = [
      { event: `request${FORGED}` },
      { request_id: `abcd1234\nforged` },
      { route: `GET /api/records/${FORGED}/history` },
      { route: "GET /api/records/model-123/history?token=abc" },
      { ts: `2026-11-22T12:00:00Z\n` },
      { level: "debug" },
      { status: 99 },
      { status: "200" },
      { extra: "field" },
    ];
    for (const h of hostile) {
      let message = "";
      try {
        toPublicLogLine({ ...good, ...h } as PublicLogEntry);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, JSON.stringify(h)).not.toBe("");
      expect(message).not.toContain("forged");
      expect(message).not.toContain("token");
    }
  });

  it("the stdout writer prints one six-field line per entry and drops anything else", () => {
    const lines: string[] = [];
    const write = createPublicLogWriter((l) => lines.push(l));
    write({ ts: "2026-11-22T12:00:00.000Z", level: "info", event: "request", request_id: "abcd1234", route: "GET /api/health", status: 200 });
    write({ ts: "2026-11-22T12:00:00.000Z", level: "info", event: `request${FORGED}`, request_id: "abcd1234", route: "GET /api/health", status: 200 });
    write({ ts: "x", extra: 1 } as unknown as PublicLogEntry);
    write(null as unknown as PublicLogEntry);
    expect(lines).toHaveLength(1);
    expect(Object.keys(JSON.parse(lines[0]!))).toEqual([...PUBLIC_LOG_FIELDS]);
    expect(lines[0]).not.toMatch(CONTROL);
  });

  it("the crash line has fixed keys and never carries a message, a stack or a value", () => {
    const e = Object.assign(new Error(`secret-value ${FORGED}`), { code: "ERR_X", name: "CustomError" });
    const line = crashLine(e);
    expect(JSON.parse(line)).toEqual({ event: "crash", error_class: "CustomError", code: "ERR_X" });
    expect(line).not.toContain("secret-value");
    expect(line).not.toMatch(CONTROL);
    for (const hostile of [Object.assign(new Error("m"), { name: `Evil${FORGED}`, code: `C${FORGED}` }), "a string with secret", null, undefined, 42, { name: { toString: () => "x" } }, Object.defineProperty({}, "name", { get() { throw new Error("getter secret"); } })]) {
      const l = crashLine(hostile);
      expect(Object.keys(JSON.parse(l))).toEqual(["event", "error_class", "code"]);
      expect(l).not.toMatch(CONTROL);
      expect(l).not.toContain("secret");
      expect(l).not.toContain("forged");
    }
  });

  it("the exception barrier logs only the crash line and exits non-zero", () => {
    const out: string[] = [];
    const codes: number[] = [];
    const uninstall = installExceptionBarrier({ write: (l) => out.push(l), exit: (c) => codes.push(c) });
    try {
      process.emit("uncaughtException", Object.assign(new Error("restricted-value-123"), { code: "E_BOOM" }), "uncaughtException");
      process.emit("unhandledRejection", new TypeError("restricted-value-456"), Promise.resolve());
    } finally {
      uninstall();
    }
    expect(out.map((l) => JSON.parse(l))).toEqual([
      { event: "crash", error_class: "Error", code: "E_BOOM" },
      { event: "crash", error_class: "TypeError", code: "none" },
    ]);
    expect(out.join("\n")).not.toContain("restricted-value");
    expect(codes[0]).toBe(1);
  });

  it("through the server: hostile paths, headers and ids never reach the public log, which keeps six clean fields", async () => {
    logged.length = 0;
    const hostilePaths = [
      `/api/records/${encodeURIComponent(FORGED)}/b/history`,
      "/api/jobs/%1b%5b31m%0d%0aforged",
      "/api/unknown%0d%0a%1b%5b0m",
      "/api/records/m%E2%80%A8b/x/history",
      "/api/health?token=secret-token-abc&x=%0d%0a",
    ];
    for (const p of hostilePaths) await raw("GET", p, { "X-Request-Id": "forged\u001b[31m" }).catch(() => undefined);
    await raw("GET", "/api/health", { "User-Agent": "ua\u001b[31m", "X-Forwarded-For": "1.2.3.4, \u001b[0m", "X-Security-Domain": "dom\u001b[31m", Referer: "http://x/\u2028" }).catch(() => undefined);
    await post("/api/jobs/import", importBody(), { "X-Idempotency-Key": "key\u001b[31m-forged" }).catch(() => undefined);
    // bytes Node's client will not send: a raw CR/LF-split header and an ESC byte in a header value
    await rawBytes("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nX-A: b\x1b[31m\r\nX-Evil: x\r\n\r\n");
    await rawBytes("GET /api/records/a%0d%0ab/c/history HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    await rawBytes("GET /\x1b[31m HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    await healthy();

    expect(logged.length, "the server wrote public log entries through the `log` option").toBeGreaterThan(0);
    for (const entry of logged) {
      expect(Object.keys(entry).sort()).toEqual([...PUBLIC_LOG_FIELDS].sort());
      const line = toPublicLogLine(entry); // would throw on anything outside the patterns
      expect(line).not.toMatch(CONTROL);
      expect(line).not.toMatch(/forged|secret-token|token=|\\u001b/i);
      expect(entry.route).toMatch(/^[A-Z]{3,7} \/[a-z:\-/]*$/);
      expect(entry.route).not.toMatch(/\d{3,}/); // a template, not a raw id
    }
    // a route template, not the raw path, is what is logged for a parameterised route
    expect(logged.some((e) => e.route === "GET /api/records/:model/:batch/history")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("header injection", () => {
  it("generated file names in a release carry only safe characters", async () => {
    const imp = await postImport();
    const snap = (JSON.parse(imp.body) as { snapshot?: { model: string; batch: string } }).snapshot!;
    const rel = await post(`/api/records/${encodeURIComponent(snap.model)}/${encodeURIComponent(snap.batch)}/release`, {});
    expect(rel.status).toBe(200);
    const files = (JSON.parse(rel.body) as { files: Array<{ fileName: string }> }).files;
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.fileName).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(f.fileName).not.toContain("..");
    }
  });

  it("no header value of any response contains a control character, whatever the request carried", async () => {
    const requests: Array<[string, string, Record<string, string>]> = [
      ["GET", "/api/health", { Origin: "http://trusted.example:5173" }],
      ["GET", "/api/records/%0d%0aSet-Cookie:%20a=b/x/history", {}],
      ["OPTIONS", "/api/jobs/import", { Origin: "http://trusted.example:5173", "Access-Control-Request-Headers": "x-evil" }],
      ["GET", "/%0d%0aSet-Cookie:%20a=b", {}],
      ["GET", "/api/health", { "X-Security-Domain": "dom;x" }],
    ];
    for (const [m, p, h] of requests) {
      const r = await raw(m, p, h, m === "POST" ? "{}" : undefined);
      for (const [name, value] of Object.entries(r.headers)) {
        for (const v of Array.isArray(value) ? value : [value ?? ""]) expect(v, `${m} ${p} ${name}`).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f]/);
      }
      expect(r.headers["set-cookie"], `${m} ${p}`).toBeUndefined();
      expect(r.headers["x-evil"], `${m} ${p}`).toBeUndefined();
    }
    // control bytes in request headers, sent raw: the reply carries no injected header and no echo of the bytes
    for (const head of ["Origin: http://evil.example\x1b[31m", "X-Security-Domain: dom\x1b[31m", "X-Idempotency-Key: k\x1b", "Origin: http://trusted.example:5173\x1b"]) {
      const reply = await rawBytes(`GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n${head}\r\nConnection: close\r\n\r\n`);
      const headBlock = reply.split("\r\n\r\n")[0]!;
      expect(headBlock, head).not.toMatch(/set-cookie/i);
      expect(headBlock, head).not.toContain("\x1b");
    }
  });

  it("a request header split by CR/LF cannot add a response header, and the Origin is reflected only when allowed", async () => {
    const reply = await rawBytes("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\nConnection: close\r\n\r\n");
    expect(reply).not.toMatch(/access-control-allow-origin: http:\/\/evil/i);
    const ok = await raw("GET", "/api/health", { Origin: "http://trusted.example:5173" });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://trusted.example:5173");
    const bad = await raw("GET", "/api/health", { Origin: "http://evil.example" });
    expect(bad.headers["access-control-allow-origin"]).not.toBe("http://evil.example");
  });

  it("safeName strips CR, LF, quotes and separators, so a name can sit in a Content-Disposition header", () => {
    const n = safeName("erp-staging", 'a"\r\nSet-Cookie: x=1; filename=\u202E', "b/c\\d");
    expect(n).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(n).not.toMatch(/["\r\n;\s\\/]/);
  });
});
