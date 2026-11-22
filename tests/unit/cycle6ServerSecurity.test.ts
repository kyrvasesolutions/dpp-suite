// @vitest-environment node
/**
 * Cycle 6: the HTTP boundary of the durable server. Evidence retention cannot be shortened by a caller, raw write
 * endpoints are gone, only same-origin (or explicitly allowed) browsers with the right Host and body type can write,
 * and the server assigns recordedAt (C6-02, C6-03, C6-05).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../server/db/adapter";
import { migrateUp } from "../../server/db/migrations";
import { createDppServer } from "../../server/http/api";
import { PolicyStore } from "../../server/store/policyStore";
import type { ProfilePack } from "../../src/model/profile";
import { probeServer, submitImportJob } from "../../src/model/remoteStore";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, loadPack } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const tmp = mkdtempSync(join(tmpdir(), "dpp-c6-sec-"));
const staticDir = join(tmp, "app");
let pack: ProfilePack;
let db: SqliteAdapter;
let base: string;
let port: number;
let close: () => Promise<void>;

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const json = { "Content-Type": "application/json" };
const evBytes = new TextEncoder().encode("repro-evidence-object");
const evSha = createHash("sha256").update(evBytes).digest("hex");

/** A raw request, so a test can send any Host or Origin header (fetch forbids setting Host). */
function raw(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

beforeAll(async () => {
  pack = await loadPack();
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(staticDir, "app.js"), "console.log(1)");
  writeFileSync(join(tmp, "secret.txt"), "outside the app directory");
  db = new SqliteAdapter({ path: join(tmp, "sec.sqlite") });
  migrateUp(db);
  new PolicyStore(db).activate(pack.policy.retention);
  const server = createDppServer({
    db,
    pack,
    software: TEST_SOFTWARE,
    staticDir,
    allowedOrigin: "http://trusted.example:5173",
    now: () => "2026-11-22T12:00:00.000Z",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  close = () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});
afterAll(async () => {
  await close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const importBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    erp: { name: CLEAN.erp, type: "text/csv", base64: b64(fixtureBytes("n", CLEAN.erp)) },
    lab: { name: CLEAN.lab, type: "application/json", base64: b64(fixtureBytes("n", CLEAN.lab)) },
    ...extra,
  });
const postJob = (key: string, extra: Record<string, unknown> = {}) =>
  fetch(`${base}/api/jobs/import`, { method: "POST", headers: { ...json, "X-Idempotency-Key": key }, body: importBody(extra) });

describe("evidence cannot be deleted during retention (C6-05)", () => {
  it("survives the full bypass sequence: delete, hold on, hold off, delete with a forged clock", async () => {
    const imp = await postJob("sec-evidence", {
      evidence: [{ evidenceId: "EV-REPRO", issuer: "Demo Lab", revision: "1", recordKind: "test-report", base64: b64(evBytes) }],
    });
    expect(imp.status).toBe(200);
    const url = `${base}/api/evidence/${evSha}`;

    expect((await fetch(url, { method: "DELETE" })).status).toBe(409);
    const hold = (legalHold: boolean, headers: Record<string, string> = json) =>
      fetch(`${url}/legal-hold`, { method: "POST", headers, body: JSON.stringify({ legalHold }) });
    expect((await hold(true)).status).toBe(200);
    // releasing needs identity: refused over the API whatever the body type
    const releaseText = await hold(false, { "Content-Type": "text/plain" });
    expect(releaseText.status).toBe(415);
    const releaseJson = await hold(false);
    expect(releaseJson.status).toBe(403);
    expect(((await releaseJson.json()) as { code: string }).code).toBe("legal-hold-release-refused");

    // the caller's clock is not accepted
    const forged = await fetch(`${url}?asOf=2099-01-01T00:00:00Z`, { method: "DELETE" });
    expect(forged.status).toBe(400);
    expect(((await forged.json()) as { code: string }).code).toBe("as-of-not-accepted");
    const plain = await fetch(url, { method: "DELETE" });
    expect(plain.status).toBe(409);
    expect(((await plain.json()) as { code: string }).code).toBe("legal-hold-active");
    expect((await fetch(url)).status).toBe(200);
  });
});

describe("no raw write endpoints, and writes only from the right place", () => {
  it("has no raw snapshot write and no log write", async () => {
    const forged = await fetch(`${base}/api/records/anything/anything/snapshots`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ snapshot: { model: "anything", batch: "anything", version: 1, record: { values: [{ value: 999999 }] } } }),
    });
    expect(forged.status).toBe(405);
    const log = await fetch(`${base}/api/log`, { method: "POST", headers: json, body: JSON.stringify({ entry: { event: "import", outcome: "ok" } }) });
    expect(log.status).toBe(405);
    expect((await fetch(`${base}/api/log`)).status).toBe(200);
    const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM execution_log")!.n;
    await fetch(`${base}/api/log`, { method: "POST", headers: json, body: "{}" });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM execution_log")!.n).toBe(before);
  });

  it("requires Content-Type application/json on every POST", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
      const res = await raw("POST", "/api/jobs/recover", type ? { "Content-Type": type } : {}, "{}");
      expect(res.status, `type "${type}"`).toBe(415);
    }
    const ok = await raw("POST", "/api/jobs/recover", { "Content-Type": "application/json; charset=utf-8" }, "{}");
    expect(ok.status).toBe(200);
  });

  it("answers only to its own Host names (DNS rebinding)", async () => {
    for (const host of ["evil.example", "evil.example:80", "127.0.0.1.evil.example", "localhost.evil.example"]) {
      const res = await raw("GET", "/api/health", { Host: host });
      expect(res.status, host).toBe(403);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, "[::1]:4174"]) {
      expect((await raw("GET", "/api/health", { Host: host })).status, host).toBe(200);
    }
  });

  it("refuses cross-origin requests unless the origin is allowed, and sends CORS headers only to that one", async () => {
    for (const origin of ["http://evil.example", "null", "https://trusted.example:5173", "http://127.0.0.1:9999"]) {
      const res = await raw("POST", "/api/jobs/recover", { ...json, Origin: origin }, "{}");
      expect(res.status, origin).toBe(403);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
    const evilPreflight = await raw("OPTIONS", "/api/jobs/import", { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" });
    expect(evilPreflight.status).toBe(403);

    // same origin (what the served SPA sends) and a configured origin work
    const same = await raw("POST", "/api/jobs/recover", { ...json, Origin: `http://127.0.0.1:${port}` }, "{}");
    expect(same.status).toBe(200);
    expect(same.headers["access-control-allow-origin"]).toBeUndefined();
    const trusted = await raw("POST", "/api/jobs/recover", { ...json, Origin: "http://trusted.example:5173" }, "{}");
    expect(trusted.status).toBe(200);
    expect(trusted.headers["access-control-allow-origin"]).toBe("http://trusted.example:5173");
    const preflight = await raw("OPTIONS", "/api/jobs/import", { Origin: "http://trusted.example:5173", "Access-Control-Request-Method": "POST" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("http://trusted.example:5173");

    // a cross-site write that sends no Origin is also refused
    expect((await raw("POST", "/api/jobs/recover", { ...json, "Sec-Fetch-Site": "cross-site" }, "{}")).status).toBe(403);
  });

  it("binds to 127.0.0.1 by default in the entry point", async () => {
    const { readFileSync } = await import("node:fs");
    const entry = readFileSync("server/index.ts", "utf8");
    expect(entry).toContain('process.env.DPP_SERVER_HOST?.trim() || "127.0.0.1"');
  });
});

describe("the server decides time and datasets (C6-02, C6-05)", () => {
  it("ignores a caller's recordedAt: retention runs from the server clock", async () => {
    const res = await postJob("sec-recorded-at", {
      timeEnvelope: { recordedAt: "1990-01-01T00:00:00Z", publishedAt: "1990-01-01T00:00:00Z", observedAt: "2026-11-20T09:00:00Z" },
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { receipt: { recordedAt: string; retentionUntil: string } };
    expect(out.receipt.recordedAt).toBe("2026-11-22T12:00:00.000Z");
    expect(out.receipt.retentionUntil).toBe("2036-11-19T12:00:00.000Z");
  });

  it("refuses a time in the future or before the earliest allowed, and any dataset but the two inputs", async () => {
    for (const timeEnvelope of [{ observedAt: "2030-01-01T00:00:00Z" }, { declaredAt: "1969-01-01T00:00:00Z" }, { validFrom: "2099-01-01T00:00:00Z" }]) {
      const res = await postJob(`sec-time-${JSON.stringify(timeEnvelope)}`, { timeEnvelope });
      expect(res.status).toBe(400);
    }
    for (const dataset of ["execution-log", "central-record-snapshot", "evidence-object", "unlisted"]) {
      const res = await postJob(`sec-dataset-${dataset}`, { dataset });
      expect(res.status, dataset).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("dataset-not-allowed");
    }
    expect((await postJob("sec-dataset-ok", { dataset: "lab-assessment" })).status).toBe(200);
  });
});

describe("the server also serves the built app on its own origin", () => {
  it("serves index.html, assets and the app shell for client routes, and never a file outside the directory", async () => {
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(index.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`${base}/app.js`)).headers.get("content-type")).toContain("text/javascript");
    expect(await (await fetch(`${base}/some/client/route`)).text()).toContain("<title>app</title>");
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    for (const path of ["/..%2Fsecret.txt", "/%2e%2e/secret.txt", "/..\\secret.txt"]) {
      const res = await raw("GET", path, {});
      expect(res.body, path).not.toContain("outside the app directory");
    }
    expect((await fetch(`${base}/api/unknown`)).status).toBe(404);
  });
});

describe("the browser client finds the server and submits imports as jobs", () => {
  it("probes the same-origin health answer, and takes anything else for no server", async () => {
    expect(await probeServer(base)).toMatchObject({ status: "ok", activeRetentionPolicy: "RETENTION@1.0.0" });
    expect(await probeServer("http://127.0.0.1:1")).toBeNull(); // nothing listens
    // a static host or a dev server that answers every path with the app shell is not the DPP server
    const shell = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>shell</title>");
    });
    await new Promise<void>((resolve) => shell.listen(0, "127.0.0.1", resolve));
    try {
      expect(await probeServer(`http://127.0.0.1:${(shell.address() as AddressInfo).port}`)).toBeNull();
    } finally {
      await new Promise((resolve) => shell.close(resolve));
    }
  });

  it("submits the two files as a durable job, and the same key again replays instead of storing twice", async () => {
    const files = {
      erp: { bytes: fixtureBytes("n", CLEAN.erp), name: CLEAN.erp, type: "text/csv" },
      lab: { bytes: fixtureBytes("n", CLEAN.lab), name: CLEAN.lab, type: "application/json" },
    };
    const first = await submitImportJob(base, files, "client-job-1");
    expect(first.ok, JSON.stringify(first.errors)).toBe(true);
    expect(first.receipt?.version).toBeGreaterThanOrEqual(1); // earlier tests of this file stored the same record
    const again = await submitImportJob(base, files, "client-job-1");
    expect(again.receipt?.stored).toBe(false);
    expect(again.snapshot?.version).toBe(first.snapshot?.version);
    // a file the contract rejects comes back as a typed error, not a thrown fault
    const bad = await submitImportJob(base, { erp: { bytes: new TextEncoder().encode("not,a,contract"), name: "x.csv", type: "text/csv" } }, "client-job-bad");
    expect(bad.ok).toBe(false);
    expect(bad.errors?.[0]?.code).toBeTruthy();
  });
});
