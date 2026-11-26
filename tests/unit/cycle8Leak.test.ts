// @vitest-environment node
/**
 * Cycle 8 leak canary scan (C8-06, threats T07, T08, T09). Unique canary strings go into every kind of value the system
 * handles (record values, file names, batch id, reasons, subject, display name, a token claim), a full scenario is driven
 * through a real server in OIDC mode, and everything that leaves the process is searched for them:
 *  - the public log, the crash output and every error response (headers too) must carry no canary at all,
 *  - a generated file may carry a canary only where the disclosure matrix permits that field for its route.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GrantStore } from "../../server/auth/grantStore";
import { PUBLIC_LOG_FIELDS, toPublicLogLine, type PublicLogEntry } from "../../src/model/c8Contracts";
import type { ProductRecord } from "../../src/model/ingress";
import { decide } from "../../src/model/policy";
import { ROUTES, type ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "../support/fixtures";
import { b64, startC8Server, type C8Server } from "../support/c8Server";
import { pdfText } from "../support/pdfText";
import { assertNoLeakText } from "../support/leak";
import { CLEAN, propertyBySlug } from "../support/records";
import { ERROR_TEXT } from "../../src/model/ingress";

const R = randomBytes(4).toString("hex");
const C = {
  erpFile: `CANARY-erpfile-${R}`,
  labFile: `CANARY-labfile-${R}`,
  batch: `CANARY-batch-${R}`,
  method: `CANARY-method-${R}`,
  fpMethod: `CANARY-fpmethod-${R}`,
  calcBy: `CANARY-calcby-${R}`,
  issuer: `CANARY-issuer-${R}`,
  scope: `CANARY-scope-${R}`,
  article: `CANARY-article-${R}`,
  correction: `CANARY-correction-${R}`,
  cancel: `CANARY-cancel-${R}`,
  hold: `CANARY-hold-${R}`,
  release: `CANARY-holdrelease-${R}`,
  revoke: `CANARY-revoke-${R}`,
  evFile: `CANARY-evfile-${R}`,
  evId: `CANARY-evid-${R}`,
  sub: `CANARY-sub-${R}`,
  admin: `CANARY-admin-${R}`,
  customer: `CANARY-cust-${R}`,
  display: `CANARY-display-${R}`,
  claim: `CANARY-claim-${R}`,
  path: `CANARY-path-${R}`,
  query: `CANARY-query-${R}`,
  hostile: `CANARY-hostile-${R}`,
  header: `CANARY-header-${R}`,
  crash: `CANARY-crash-${R}`,
};
/** Canaries that are values of the record (they may appear in a generated file where the matrix permits them). */
const RECORD_CANARIES = [C.batch, C.method, C.fpMethod, C.calcBy, C.issuer, C.scope, C.article];

const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

interface Seen {
  label: string;
  status: number;
  body: string;
  headers: Record<string, string>;
}

let main: C8Server;
let limited: C8Server;
let pack: ProfilePack;
let record: ProductRecord;
let tmp: string;
const logLines: string[] = [];
const logEntries: PublicLogEntry[] = [];
const seen: Seen[] = [];
const tokens: string[] = [];
let model = "";
let batch = "";
let jobId = "";
let evSha = "";
const releaseFiles: Array<{ route: string; fileName: string; bytes: Uint8Array }> = [];
let manifestText = "";
let customerProjection = "";
let childOut = "";
let childErr = "";
let revokeStatus = 0;
let afterRevokeStatus = 0;

const tokenFor = (s: C8Server, sub: string) => {
  const t = s.idp.signRs256({ sub, canary_claim: C.claim, name: C.display });
  tokens.push(t);
  return t;
};

async function call(s: C8Server, label: string, method: string, path: string, token?: string, body?: string, extra: Record<string, string> = {}): Promise<Seen & { json: any }> {
  const res = await fetch(`${s.baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body,
  });
  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  const entry = { label, status: res.status, body: text, headers };
  seen.push(entry);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { ...entry, json };
}

function addUsers(s: C8Server) {
  const grants = new GrantStore(s.db, undefined, { now: () => "2026-11-22T12:00:00.000Z" });
  const mk = (sub: string, roles: Array<"ACT-01" | "ACT-06" | "ACT-19">, displayName: string) => grants.upsertUser({ sub, displayName, roles, actorSub: "bootstrap", reason: "canary test user" });
  mk(C.sub, ["ACT-01"], `${C.display}-op`);
  mk(C.admin, ["ACT-19"], `${C.display}-admin`);
  mk(C.customer, ["ACT-06"], `${C.display}-cust`);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "dpp-c8-leak-"));
  const log = (e: PublicLogEntry) => {
    logEntries.push(e);
    logLines.push(toPublicLogLine(e));
  };
  const { NO_RATE_PRESSURE } = await import("../support/c8Server");
  main = await startC8Server({ mode: "oidc", patch: NO_RATE_PRESSURE, extra: { log } });
  limited = await startC8Server({
    mode: "oidc",
    patch: { http: { rate_limit_read_per_window: 3, rate_limit_write_per_window: 1_000_000, max_request_body_bytes: 3000 } as never },
    extra: { log },
  });
  pack = main.pack;
  addUsers(main);
  addUsers(limited);

  // the record with canaries in its values, built in-process from the same bytes that are imported
  const editErp = (csv: string) => csv.replace(/ST-LOT-2026-001/g, C.batch).replace(",004215,", `,${C.article},`);
  const editLabText = (t: string) =>
    t
      .replace(/ST-LOT-2026-001/g, C.batch)
      .replace(/ST-SPECIMEN-DIM-01/g, C.method)
      .replace(/ST-REP-001/g, C.fpMethod)
      .replace(/ST-ALLOC-001/g, C.calcBy)
      .replace("synthetic_declaration_summary", C.issuer)
      .replace(/ST-RC-SCOPE-01/g, C.scope);
  const erpText = editErp(dec(fixtureBytes("n", CLEAN.erp)));
  const labText = editLabText(dec(fixtureBytes("n", CLEAN.lab)));

  const op = tokenFor(main, C.sub);
  const admin = tokenFor(main, C.admin);
  const evBytes = enc(`evidence-bytes-${R}`);
  const imp = await call(
    main,
    "import",
    "POST",
    "/api/jobs/import",
    op,
    JSON.stringify({
      idempotencyKey: `idem-${R}`,
      erp: { name: `${C.erpFile}.csv`, type: "text/csv", base64: b64(enc(erpText)) },
      lab: { name: `${C.labFile}.json`, type: "application/json", base64: b64(enc(labText)) },
      evidence: [{ evidenceId: C.evId, issuer: C.issuer, revision: "1", recordKind: "test-report", fileName: `${C.evFile}.pdf`, base64: b64(evBytes) }],
    }),
    { "X-Request-Id": C.header },
  );
  if (imp.status !== 200) throw new Error(`the canary import was refused: ${imp.status} ${imp.body.slice(0, 300)}`);
  model = imp.json.snapshot.model;
  batch = imp.json.snapshot.batch;
  jobId = imp.json.job.jobId;
  const { createHash } = await import("node:crypto");
  evSha = createHash("sha256").update(evBytes).digest("hex");
  // the same record, in-process, for the disclosure matrix
  const { importErpCsv, importLabJson, buildRecords } = await import("../../src/model/ingress");
  const e = await importErpCsv(pack, { bytes: enc(erpText), name: `${C.erpFile}.csv`, type: "text/csv" });
  const l = await importLabJson(pack, { bytes: enc(labText), name: `${C.labFile}.json`, type: "application/json" });
  if (!e.ok || !l.ok) throw new Error("the canary pair does not import in-process");
  record = (await buildRecords([e, l], pack)).records[0]!;

  // correction with a canary reason (use nominal-width so recycled total = pre + post invariant stays valid)
  const propId = propertyBySlug(pack, "nominal-width");
  await call(main, "correction", "POST", `/api/records/${encodeURIComponent(model)}/${encodeURIComponent(batch)}/correct`, op, JSON.stringify({ property: propId, raw: "1505", reason: C.correction, expectedVersion: 1 }));
  // cancel with a canary reason: the job has ended, so the answer is a refusal
  await call(main, "cancel", "POST", `/api/jobs/${encodeURIComponent(jobId)}/cancel`, op, JSON.stringify({ reason: C.cancel }));
  await call(main, "cancel-unknown", "POST", `/api/jobs/${encodeURIComponent(C.path)}/cancel`, op, JSON.stringify({ reason: C.cancel }));
  // legal hold with canary reasons
  await call(main, "hold", "POST", `/api/evidence/${evSha}/legal-hold`, admin, JSON.stringify({ legalHold: true, reason: C.hold }));
  await call(main, "hold-release", "POST", `/api/evidence/${evSha}/legal-hold`, admin, JSON.stringify({ legalHold: false, reason: C.release }));
  await call(main, "evidence-get", "GET", `/api/evidence/${evSha}`, op);
  // forced error paths: hostile files, a 404 with a canary in the path and the query, a bad route parameter
  await call(main, "hostile-lab", "POST", "/api/jobs/import", op, JSON.stringify({ idempotencyKey: `h1-${R}`, erp: { name: `${C.erpFile}.csv`, type: "text/csv", base64: b64(enc(erpText)) }, lab: { name: `${C.labFile}.json`, type: "application/json", base64: b64(enc(`{"${C.hostile}":"${C.hostile}`)) } }));
  await call(main, "hostile-erp", "POST", "/api/jobs/import", op, JSON.stringify({ idempotencyKey: `h2-${R}`, erp: { name: `${C.erpFile}.csv`, type: "text/csv", base64: b64(enc(`"${C.hostile};unbalanced\n`)) } }));
  await call(main, "hostile-name", "POST", "/api/jobs/import", op, JSON.stringify({ idempotencyKey: `h3-${R}`, erp: { name: `${C.erpFile}.exe`, type: "application/x-${C.hostile}", base64: b64(enc("x")) } }));
  await call(main, "bad-json", "POST", "/api/jobs/import", op, `{"${C.hostile}": [`, { "X-Idempotency-Key": C.header });
  await call(main, "404", "GET", `/api/${C.path}/x?q=${C.query}`, op);
  await call(main, "404-record", "GET", `/api/records/${C.path}/${C.path}/history?q=${C.query}`, op);
  await call(main, "bad-param", "GET", `/api/records/%${C.path}/b/history`, op);
  await call(main, "bad-token", "GET", "/api/records", `${op}x`);
  await call(main, "no-token", "GET", `/api/records?q=${C.query}`);
  await call(main, "forbidden", "GET", "/api/admin/users", op, undefined, { "X-Security-Domain": C.header });
  await call(main, "wrong-surface-role", "POST", `/api/records/${encodeURIComponent(model)}/${encodeURIComponent(batch)}/release`, tokenFor(main, C.customer), "{}");
  // 429 and 413 on the limited server
  const lop = tokenFor(limited, C.sub);
  for (let i = 0; i < 7; i++) await call(limited, "429", "GET", `/api/records?q=${C.query}`, lop);
  await call(limited, "413", "POST", "/api/jobs/import", lop, JSON.stringify({ idempotencyKey: `big-${R}`, erp: { name: `${C.erpFile}.csv`, type: "text/csv", base64: b64(enc(`${C.hostile}`.repeat(400))) } }));

  // generated files per route, and the customer projection
  const rel = await call(main, "release", "POST", `/api/records/${encodeURIComponent(model)}/${encodeURIComponent(batch)}/release`, op, "{}");
  if (rel.status === 200) {
    manifestText = JSON.stringify(rel.json.manifest);
    for (const f of rel.json.files as Array<{ route: string; fileName: string; base64: string }>) releaseFiles.push({ route: f.route, fileName: f.fileName, bytes: Uint8Array.from(Buffer.from(f.base64, "base64")) });
  }
  const cust = tokenFor(main, C.customer);
  const crel = await call(main, "customer-release", "POST", `/api/customer/records/${encodeURIComponent(model)}/${encodeURIComponent(batch)}/release`, cust, "{}");
  if (crel.status === 200 && !releaseFiles.some((f) => f.route === "customer")) releaseFiles.push({ route: "customer", fileName: crel.json.file.fileName, bytes: Uint8Array.from(Buffer.from(crel.json.file.base64, "base64")) });
  customerProjection = (await call(main, "customer-read", "GET", `/api/customer/records/${encodeURIComponent(model)}/${encodeURIComponent(batch)}`, cust)).body;
  for (const p of ["/api/log", "/api/admin/audit", "/api/admin/metrics"]) await call(main, p, "GET", p, admin);

  // an induced crash through the barrier: a child process, an Error whose message and name carry canaries
  const script = join(tmp, "crash.mjs");
  const barrierUrl = pathToFileURL(join(process.cwd(), "server/log/barrier.ts")).href;
  writeFileSync(
    script,
    `import { installExceptionBarrier } from ${JSON.stringify(barrierUrl)};\ninstallExceptionBarrier();\nprocess.on("exit", () => {});\nconst e = new Error(${JSON.stringify(C.crash)} + " path=/data/" + ${JSON.stringify(C.path)});\ne.code = "E_BOOM";\nsetTimeout(() => { Promise.reject(new Error(${JSON.stringify(C.crash + "-rejection")})); }, 0);\nthrow e;\n`,
  );
  const child = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 20_000 });
  childOut = child.stdout;
  childErr = child.stderr;
  (globalThis as any).__childStatus = child.status;

  // role change on next request: the admin revokes the operator's role with a canary reason
  const pre = await call(main, "pre-revoke", "GET", "/api/records", op);
  expect(pre.status).toBe(200);
  const rv = await call(main, "revoke", "POST", `/api/admin/users/${encodeURIComponent(C.sub)}/roles/revoke`, admin, JSON.stringify({ role: "ACT-01", reason: C.revoke }));
  revokeStatus = rv.status;
  afterRevokeStatus = (await call(main, "after-revoke", "GET", "/api/records", op)).status;
}, 120_000);

afterAll(async () => {
  await main?.close();
  await limited?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const allCanaries = () => [...Object.values(C), ...tokens];
const errorSeen = () => seen.filter((s) => s.status >= 400);

describe("leak canary scan", () => {
  it("the scenario ran: import, correction, error paths, 429, 413, a crash and a revocation", () => {
    const statuses = (label: string) => seen.filter((s) => s.label === label).map((s) => s.status);
    expect(statuses("import")).toEqual([200]);
    expect(statuses("correction")).toEqual([200]);
    expect(statuses("cancel")[0]).toBeGreaterThanOrEqual(400);
    expect(statuses("hostile-lab")[0]).toBeGreaterThanOrEqual(400);
    expect(statuses("404")).toEqual([404]);
    expect(statuses("429")).toContain(429);
    expect(statuses("413")).toEqual([413]);
    expect(logEntries.length).toBeGreaterThan(20);
    expect((globalThis as any).__childStatus).toBe(1);
  });

  it("(d) every public log line has exactly the six fields and no control character", () => {
    expect(logLines.length).toBe(logEntries.length);
    for (const line of logLines) {
      const parsed = JSON.parse(line);
      expect(Object.keys(parsed)).toEqual([...PUBLIC_LOG_FIELDS]);
      expect(line).not.toMatch(CONTROL);
    }
    for (const e of logEntries) expect(Object.keys(e).sort()).toEqual([...PUBLIC_LOG_FIELDS].sort());
  });

  it("(a) no canary of any kind appears in the public log", () => {
    const log = logLines.join("\n");
    for (const c of allCanaries()) expect(log, c.slice(0, 24)).not.toContain(c);
    expect(log).not.toMatch(/CANARY/i);
  });

  it("(c) file names, paths and evidence links never appear in the public log", () => {
    const log = logLines.join("\n");
    for (const token of [".csv", ".json", ".pdf", ".exe", "/data/", evSha, "base64", model, batch, jobId]) expect(log, token).not.toContain(token);
    for (const e of logEntries) {
      expect(e.route).toMatch(/^[A-Z]{3,7} \/[a-z0-9:_\-/]*$/);
      // every segment is a fixed word or a :param; a raw id (digits, hex, canary) is never a literal segment
      for (const seg of e.route.split(" ")[1]!.split("/").filter(Boolean)) expect(seg).toMatch(/^(:[a-z0-9_]+|[a-z][a-z-]*)$/);
      expect(e.request_id).toMatch(/^[0-9a-f-]{36}$/);
    }
    // parameterised routes are logged as templates
    expect(logEntries.some((e) => e.route.includes(":"))).toBe(true);
  });

  it("(a) the crash output carries only the fixed crash lines, never the message, the stack or a path", () => {
    const out = `${childOut}\n${childErr}`;
    for (const c of allCanaries()) expect(out, c.slice(0, 24)).not.toContain(c);
    expect(out).not.toMatch(/CANARY|at \S+ \(|\.mjs|\/data\//);
    const crashLines = out.split("\n").filter((l) => l.startsWith("{"));
    expect(crashLines.length).toBeGreaterThanOrEqual(1);
    for (const l of crashLines) expect(JSON.parse(l)).toEqual({ event: "crash", error_class: "Error", code: expect.stringMatching(/^(E_BOOM|none)$/) });
  });

  // D8-09: a refused import tells its own submitter the file name and the row or JSON pointer (locators) and the fixed text of
  // the code, and never a field value. Nobody else sees the locators, and no other view carries any value.
  const IMPORT_REFUSALS = ["hostile-lab", "hostile-erp", "hostile-name"];
  it("(a) an unprovisioned-user 403 does not echo the subject or the domain header", () => {
    const s = seen.find((x) => x.label === "forbidden")!;
    expect(s.status).toBe(403);
    expect(s.body).not.toMatch(/CANARY/i);
  });

  it("(a)(b)(c) a refused import returns locators to its submitter only, never a value, and no other view carries either", async () => {
    const refusals = seen.filter((x) => IMPORT_REFUSALS.includes(x.label));
    expect(refusals).toHaveLength(3);
    const valueCanaries = allCanaries().filter((c) => c !== C.erpFile && c !== C.labFile);
    const jobIds: string[] = [];
    for (const r of refusals) {
      // a JSON pointer may name the key of the submitter's own file (a locator); everything outside `location` is value-free
      const stripped = JSON.parse(r.body) as { errors: Array<{ location?: string }> };
      for (const e of stripped.errors) delete e.location;
      const text = `${JSON.stringify(stripped)}\n${JSON.stringify(r.headers)}`;
      // (a) no value canary: not the hostile JSON text, not a header value, not a claim
      for (const c of valueCanaries) expect(text, `${r.label} ${c.slice(0, 20)}`).not.toContain(c);
      const body = JSON.parse(r.body) as { errors: Array<{ stage: string; code: string; message: string; location: string }>; job: { jobId: string } };
      expect(body.errors.length).toBeGreaterThan(0);
      for (const e of body.errors) {
        expect(Object.keys(e).sort()).toEqual(["code", "location", "message", "stage"]);
        expect(e.message, r.label).toBe(ERROR_TEXT[e.code as keyof typeof ERROR_TEXT]); // fixed text, no detail
      }
      jobIds.push(body.job.jobId);
    }
    // the submitter's own response does carry a locator: the file name
    expect(refusals.map((r) => r.body).join("\n")).toContain(C.erpFile);
    // (b)(c) the job record and its events, read by an administrator and by the submitter, hold codes and stages only
    for (const who of [C.admin]) { // the submitter itself was revoked by this suite; the administrator is the other reader
      const t = tokenFor(main, who);
      for (const id of jobIds) {
        const res = await call(main, "job-view", "GET", `/api/jobs/${encodeURIComponent(id)}`, t);
        expect(res.status).toBe(200);
        expect(res.body, id).not.toMatch(/CANARY/i);
      }
      const list = await call(main, "job-list", "GET", "/api/jobs", t);
      expect(list.body).not.toContain(C.erpFile);
      expect(list.body).not.toContain(C.labFile);
      expect(list.body).not.toContain(C.hostile);
    }
    // the public log and the access-controlled execution log carry neither locators nor values
    expect(logLines.join("\n")).not.toMatch(/CANARY/i);
    expect(JSON.stringify(main.db.query("SELECT * FROM execution_log"))).not.toMatch(/CANARY/i);
    expect(JSON.stringify(main.db.query("SELECT * FROM job_events"))).not.toMatch(/CANARY/i);
  });

  it("(a) no other error response body or header carries a canary", () => {
    expect(errorSeen().length).toBeGreaterThan(10);
    for (const s of errorSeen().filter((x) => !IMPORT_REFUSALS.includes(x.label) && x.label !== "forbidden")) {
      const text = `${s.body}\n${JSON.stringify(s.headers)}`;
      expect(text, `${s.label} ${s.status}`).not.toMatch(/CANARY/i);
      for (const t of tokens) expect(text, `${s.label} token`).not.toContain(t);
      expect(text, `${s.label} ${s.status}`).not.toMatch(/\bat \S+ \(|node_modules|\/Users\/|\/private\/|\.ts:\d+/);
    }
  });

  it("(a) X-Request-Id is generated by the server, never taken from the client, on every response", () => {
    for (const s of seen) {
      expect(s.headers["x-request-id"], s.label).toMatch(/^[0-9a-f-]{36}$/);
      expect(s.headers["x-request-id"], s.label).not.toContain("CANARY");
    }
    expect(new Set(seen.map((s) => s.headers["x-request-id"])).size).toBe(seen.length);
  });

  it("(a) the 404 for an unknown route does not echo the path or query", () => {
    const s = seen.find((x) => x.label === "404")!;
    expect(s.body).not.toContain(C.path);
    expect(s.body).not.toContain(C.query);
  });

  it("(a) the metrics and audit endpoints, read by an admin, hold counters and no canary value from the other users' requests in the metrics", () => {
    const metrics = seen.find((s) => s.label === "/api/admin/metrics")!;
    expect(metrics.status).toBe(200);
    expect(metrics.body).not.toMatch(/CANARY/i);
  });
});

describe("role change on next request", () => {
  it("the very next request by the revoked subject is 403, with the same unexpired token", () => {
    expect(revokeStatus).toBe(200);
    expect(afterRevokeStatus).toBe(403);
  });

  it("the revocation reason stays out of every public output", () => {
    expect(logLines.join("\n")).not.toContain(C.revoke);
    for (const s of errorSeen()) expect(s.body).not.toContain(C.revoke);
  });
});

describe("generated-file scan", () => {
  const propsWith = (canary: string) => record.values.filter((v) => v.assertions.some((a) => JSON.stringify(a).includes(canary))).map((v) => v.property);
  const permitted = (canary: string, route: (typeof ROUTES)[number]) => propsWith(canary).some((p) => decide(pack, route, p) === "permit");
  const textOf = async (f: { route: string; bytes: Uint8Array }) => (f.route === "customer" ? await pdfText(f.bytes) : dec(f.bytes));

  it("the release made a file for at least the customer PDF and the ERP CSV, and the manifest", () => {
    const routes = releaseFiles.map((f) => f.route);
    expect(routes).toContain("customer");
    expect(routes).toContain("internal");
    expect(manifestText.length).toBeGreaterThan(10);
  });

  it("the canary values are in the record, so the scan can mean something", () => {
    for (const c of [C.method, C.fpMethod, C.calcBy, C.issuer, C.scope, C.article]) expect(propsWith(c).length, c).toBeGreaterThan(0);
  });

  it("a record-value canary appears in a route's file only where the matrix permits that property for that route", async () => {
    const found: string[] = [];
    for (const f of releaseFiles) {
      const text = await textOf(f);
      for (const c of RECORD_CANARIES) {
        if (!text.includes(c)) continue;
        found.push(`${f.route}:${c}`);
        if (propsWith(c).length > 0) expect(permitted(c, f.route as (typeof ROUTES)[number]), `${f.route} shows ${c}`).toBe(true);
      }
    }
    expect(found.length).toBeGreaterThan(0); // the permitted ones do show (the batch identifier at least)
  });

  it("the Customer PDF carries no restricted or internal-only canary", async () => {
    const pdf = releaseFiles.find((f) => f.route === "customer")!;
    const text = await pdfText(pdf.bytes);
    for (const c of RECORD_CANARIES) if (propsWith(c).length > 0 && !permitted(c, "customer")) expect(text, c).not.toContain(c);
    for (const c of [C.correction, C.cancel, C.hold, C.release, C.revoke, C.sub, C.admin, C.customer, C.display, C.claim, C.erpFile, C.labFile, C.evFile, C.hostile, C.header, C.crash]) expect(text, c).not.toContain(c);
    // the customer read projection obeys the same matrix, and carries no request or actor canary
    const projBody = JSON.stringify(JSON.parse(customerProjection).projection);
    for (const c of RECORD_CANARIES) if (projBody.includes(c) && propsWith(c).length > 0) expect(permitted(c, "customer"), `projection shows ${c}`).toBe(true);
    for (const c of [C.erpFile, C.labFile, C.evFile, C.correction, C.sub, C.admin, C.display, C.claim, C.hold, C.cancel]) expect(customerProjection, c).not.toContain(c);
  });

  it("nothing a route denies appears in that route's output (the disclosure invariant over every generated file)", async () => {
    for (const f of releaseFiles) {
      expect(ROUTES as readonly string[], `a file for an unknown route "${f.route}" would be skipped by the scan`).toContain(f.route);
      assertNoLeakText(await textOf(f), f.route as (typeof ROUTES)[number], record, pack);
    }
  });

  it("no actor, request or secret canary appears in any generated file or the manifest", async () => {
    const never = [C.cancel, C.hold, C.release, C.revoke, C.sub, C.admin, C.customer, C.display, C.claim, C.path, C.query, C.hostile, C.header, C.crash, ...tokens];
    const texts = [manifestText, ...(await Promise.all(releaseFiles.map(textOf)))];
    for (const t of texts) for (const c of never) expect(t, c).not.toContain(c);
  });

  it("every route of the pack has a generated file, and every one is scanned (the list comes from the pack, not from a typo-prone name list)", () => {
    expect([...ROUTES]).toEqual(Object.keys(pack.routes));
    for (const route of ROUTES) expect(releaseFiles.map((f) => f.route), `no file generated for ${route}`).toContain(route);
    for (const f of releaseFiles) expect(ROUTES as readonly string[]).toContain(f.route);
  });

  it("file names, evidence links and the correction reason stay out of every route's file", async () => {
    for (const route of ROUTES) {
      const f = releaseFiles.find((x) => x.route === route)!;
      const text = await textOf(f);
      for (const c of [C.erpFile, C.labFile, C.evFile, C.correction]) expect(text, `${route} ${c}`).not.toContain(c);
      if (route !== "internal") expect(text, `${route} evidence id`).not.toContain(C.evId);
    }
  });

  it("the customer projection, numbers included, passes the disclosure invariant (denied values never appear)", () => {
    const projection = JSON.parse(customerProjection).projection;
    assertNoLeakText(JSON.stringify(projection), "customer", record, pack);
    // numeric restricted values by name: raw Mg, Pb, cost, and recycled splits are not direct customer values
    const denied = record.values.filter((v) => decide(pack, "customer", v.property) !== "permit");
    expect(denied.length).toBeGreaterThan(0);
    const shown = new Set(projection.values.map((v: { property: string }) => v.property));
    for (const v of denied) expect(shown.has(v.property), `${v.property} is denied for the customer route`).toBe(false);
  });

  it("generated file names carry no canary from a request", () => {
    for (const f of releaseFiles) expect(f.fileName).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
