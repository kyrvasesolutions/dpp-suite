/**
 * Thin Node 24 HTTP API service for durable relational storage, staged recoverable import jobs,
 * transactional corrections, evidence retention, and deterministic releases (ADR-0004).
 *
 * Binds to `127.0.0.1` by default, makes zero outbound network calls, sets strict security headers,
 * and exposes an OIDC-ready request principal boundary prepared for Cycle 7 authentication/RBAC.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CorrectionError, type CorrectionRequest } from "../../src/model/correction";
import { releaseEvents } from "../../src/model/log";
import { generateRelease } from "../../src/model/outputs/release";
import type { SoftwareInfo } from "../../src/model/outputs/software";
import {
  ConcurrencyConflictError,
  DEFAULT_SECURITY_DOMAIN,
  RetentionViolationError,
  TimeEnvelopeError,
  type Ev5TimeEnvelope,
} from "../../src/model/pContracts";
import type { ProfilePack } from "../../src/model/profile";
import { OPERATOR, RepositoryError } from "../../src/model/recordRepository";
import type { DbAdapter } from "../db/adapter";
import { currentMigrationVersion } from "../db/migrations";
import { ImportJobRunner, type ImportEvidenceUpload } from "../jobs/importJobRunner";
import { sha256Sync } from "../store/sqlRepository";

export interface RequestPrincipal {
  actor: typeof OPERATOR;
  securityDomain: string;
  authMode: "local-trusted";
}

export type PrincipalExtractor = (req: IncomingMessage) => RequestPrincipal;

export interface DppServerOptions {
  db: DbAdapter;
  pack: ProfilePack;
  securityDomain?: string;
  software?: SoftwareInfo;
  /** Optional explicit CORS origin for local Vite dev client (never wildcard). */
  allowedOrigin?: string;
  /** OIDC-ready request context extractor (wired to IdP JWT verification in Cycle 7). */
  extractPrincipal?: PrincipalExtractor;
}

const DEFAULT_SOFTWARE: SoftwareInfo = {
  name: "dpp-traceability",
  version: "0.1.0",
  commit: "local",
};

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function sendJson(res: ServerResponse, status: number, body: unknown, allowedOrigin?: string): void {
  const payload = `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(payload)),
    "Content-Security-Policy": "default-src 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
  };
  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, X-Idempotency-Key, X-Security-Domain";
    headers["Vary"] = "Origin";
  }
  res.writeHead(status, headers);
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      throw Object.assign(new Error("Request body exceeds declared maximum size"), { statusCode: 413, code: "too-large" });
    }
    chunks.push(buf);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON"), { statusCode: 400, code: "json-syntax" });
  }
}

function decodeParam(raw: string): string {
  const decoded = decodeURIComponent(raw);
  if (!decoded || CONTROL_CHARS.test(decoded) || decoded.includes("..") || decoded.includes("/") || decoded.includes("\\")) {
    throw Object.assign(new Error("Invalid path parameter"), { statusCode: 400, code: "invalid-param" });
  }
  return decoded;
}

function toBytes(input: { base64?: string; text?: string }, field: string): Uint8Array {
  if (typeof input.base64 === "string") return new Uint8Array(Buffer.from(input.base64, "base64"));
  if (typeof input.text === "string") return new TextEncoder().encode(input.text);
  throw Object.assign(new Error(`${field} must provide base64 or text content`), { statusCode: 400, code: "invalid-payload" });
}

function mapError(err: unknown): { status: number; code: string; message: string } {
  if (err && typeof err === "object" && "statusCode" in err && typeof (err as { statusCode: unknown }).statusCode === "number") {
    const e = err as { statusCode: number; code?: string; message?: string };
    return { status: e.statusCode, code: e.code ?? "bad-request", message: e.message ?? "Bad request" };
  }
  if (err instanceof RetentionViolationError) {
    const status = err.code === "retention-active" || err.code === "legal-hold-active" ? 409 : err.code === "policy-missing" ? 412 : 400;
    return { status, code: err.code, message: err.message };
  }
  if (err instanceof ConcurrencyConflictError) {
    return { status: 409, code: err.code, message: err.message };
  }
  if (err instanceof TimeEnvelopeError) {
    return { status: 400, code: err.code, message: err.message };
  }
  if (err instanceof CorrectionError) {
    return { status: 400, code: "correction-invalid", message: err.message };
  }
  if (err instanceof RepositoryError) {
    return { status: 409, code: "repository-error", message: err.message };
  }
  return { status: 500, code: "internal-error", message: "Internal server error" };
}

export function createDppServer(options: DppServerOptions): Server {
  const defaultDomain = options.securityDomain ?? DEFAULT_SECURITY_DOMAIN;
  const software = options.software ?? DEFAULT_SOFTWARE;
  const maxBodyBytes = Math.max(options.pack.policy.limits.max_file_bytes * 3, 1_048_576);
  const extractPrincipal: PrincipalExtractor =
    options.extractPrincipal ??
    ((req) => {
      const headerDomain = typeof req.headers["x-security-domain"] === "string" ? req.headers["x-security-domain"].trim() : "";
      const securityDomain =
        headerDomain && /^[A-Za-z0-9._-]{1,64}$/.test(headerDomain) ? headerDomain : defaultDomain;
      return { actor: OPERATOR, securityDomain, authMode: "local-trusted" };
    });

  const runnerFor = (domain: string) => new ImportJobRunner(options.db, options.pack, domain);

  return createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const allowedOrigin = options.allowedOrigin;

    if (method === "OPTIONS" && allowedOrigin) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Idempotency-Key, X-Security-Domain",
        Vary: "Origin",
      });
      res.end();
      return;
    }

    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;
      const principal = extractPrincipal(req);
      const runner = runnerFor(principal.securityDomain);

      // GET /api/health
      if (method === "GET" && pathname === "/api/health") {
        const activePolicy = runner.policies.getActive();
        sendJson(
          res,
          200,
          {
            status: "ok",
            securityDomain: principal.securityDomain,
            authMode: principal.authMode,
            schemaVersion: currentMigrationVersion(options.db),
            packProfile: `${options.pack.id}@${options.pack.version}`,
            packManifestDigest: options.pack.manifestDigest,
            activeRetentionPolicy: activePolicy?.policyPin ?? null,
          },
          allowedOrigin,
        );
        return;
      }

      // GET /api/policy/retention
      if (method === "GET" && pathname === "/api/policy/retention") {
        const active = runner.policies.getActive();
        sendJson(res, 200, { active }, allowedOrigin);
        return;
      }

      // GET /api/policy/exceptions
      if (method === "GET" && pathname === "/api/policy/exceptions") {
        sendJson(res, 200, { catalogue: options.pack.policy.exceptions }, allowedOrigin);
        return;
      }

      // POST /api/jobs/import
      if (method === "POST" && pathname === "/api/jobs/import") {
        const body = (await readJsonBody(req, maxBodyBytes)) as {
          idempotencyKey?: string;
          dataset?: string;
          statedClassification?: string | null;
          expectedVersion?: number | null;
          reason?: string;
          timeEnvelope?: Ev5TimeEnvelope;
          erp?: { name?: string; type?: string; base64?: string; text?: string };
          lab?: { name?: string; type?: string; base64?: string; text?: string };
          evidence?: Array<{
            evidenceId: string;
            issuer: string;
            revision: string;
            recordKind: string;
            dataset?: string;
            statedClassification?: string | null;
            declaredSha256?: string;
            mediaType?: string;
            base64?: string;
            text?: string;
            legalHold?: boolean;
          }>;
        };

        const idemHeader = typeof req.headers["x-idempotency-key"] === "string" ? req.headers["x-idempotency-key"].trim() : "";
        const idempotencyKey = (body.idempotencyKey ?? idemHeader).trim();
        if (!idempotencyKey) {
          sendJson(res, 400, { code: "idempotency-key-missing", message: "idempotencyKey (or X-Idempotency-Key header) is required" }, allowedOrigin);
          return;
        }
        if (!body.erp) {
          sendJson(res, 400, { code: "missing-erp", message: "erp payload is required" }, allowedOrigin);
          return;
        }

        const erpBytes = toBytes(body.erp, "erp");
        const labPayload = body.lab
          ? { bytes: toBytes(body.lab, "lab"), name: body.lab.name ?? "lab-assessment.json", type: body.lab.type ?? "application/json" }
          : undefined;

        const evidence: ImportEvidenceUpload[] | undefined = body.evidence?.map((e) => ({
          evidenceId: e.evidenceId,
          issuer: e.issuer,
          revision: e.revision,
          recordKind: e.recordKind,
          dataset: e.dataset,
          statedClassification: e.statedClassification,
          declaredSha256: e.declaredSha256,
          mediaType: e.mediaType,
          contentBytes: toBytes(e, `evidence[${e.evidenceId}]`),
          legalHold: e.legalHold,
        }));

        const outcome = await runner.runImportJob({
          idempotencyKey,
          actor: principal.actor,
          dataset: body.dataset,
          statedClassification: body.statedClassification,
          expectedVersion: body.expectedVersion,
          reason: body.reason,
          timeEnvelope: body.timeEnvelope,
          erp: { bytes: erpBytes, name: body.erp.name ?? "erp-extract.csv", type: body.erp.type ?? "text/csv" },
          lab: labPayload,
          evidence,
        });

        sendJson(res, outcome.ok ? 200 : 422, outcome, allowedOrigin);
        return;
      }

      // POST /api/jobs/recover
      if (method === "POST" && pathname === "/api/jobs/recover") {
        const report = runner.recoverPendingJobs();
        sendJson(res, 200, report, allowedOrigin);
        return;
      }

      // GET /api/jobs
      if (method === "GET" && pathname === "/api/jobs") {
        sendJson(res, 200, { jobs: runner.listJobs() }, allowedOrigin);
        return;
      }

      // GET /api/jobs/:jobId
      const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (method === "GET" && jobMatch) {
        const jobId = decodeParam(jobMatch[1]!);
        const job = runner.getJob(jobId);
        if (!job) {
          sendJson(res, 404, { code: "not-found", message: "Job not found" }, allowedOrigin);
          return;
        }
        sendJson(
          res,
          200,
          { job, events: runner.getJobEvents(jobId), receipt: runner.getReceiptForJob(jobId) ?? null },
          allowedOrigin,
        );
        return;
      }

      // GET /api/records
      if (method === "GET" && pathname === "/api/records") {
        sendJson(res, 200, { records: runner.repository.recordsSync() }, allowedOrigin);
        return;
      }

      // GET /api/records/:model/:batch/history
      const histMatch = pathname.match(/^\/api\/records\/([^/]+)\/([^/]+)\/history$/);
      if (method === "GET" && histMatch) {
        const model = decodeParam(histMatch[1]!);
        const batch = decodeParam(histMatch[2]!);
        const history = runner.repository.historySync(model, batch);
        const metadata = history.map((s) => runner.repository.getSnapshotMeta(model, batch, s.version)!);
        sendJson(res, 200, { model, batch, history, metadata }, allowedOrigin);
        return;
      }

      // POST /api/records/:model/:batch/snapshots (RecordRepository.put endpoint for RemoteRecordRepository)
      const snapPutMatch = pathname.match(/^\/api\/records\/([^/]+)\/([^/]+)\/snapshots$/);
      if (method === "POST" && snapPutMatch) {
        const model = decodeParam(snapPutMatch[1]!);
        const batch = decodeParam(snapPutMatch[2]!);
        const body = (await readJsonBody(req, maxBodyBytes)) as { snapshot?: unknown; timeEnvelope?: Ev5TimeEnvelope };
        if (!body.snapshot || typeof body.snapshot !== "object") {
          sendJson(res, 400, { code: "invalid-payload", message: "snapshot object is required" }, allowedOrigin);
          return;
        }
        const snap = body.snapshot as Parameters<typeof runner.repository.putSync>[0];
        if (snap.model !== model || snap.batch !== batch) {
          sendJson(res, 400, { code: "mismatch", message: "Snapshot model/batch does not match URL" }, allowedOrigin);
          return;
        }
        const metadata = runner.repository.putSync(snap, { timeEnvelope: body.timeEnvelope });
        sendJson(res, 201, { stored: true, metadata }, allowedOrigin);
        return;
      }

      // POST /api/records/:model/:batch/correct
      const correctMatch = pathname.match(/^\/api\/records\/([^/]+)\/([^/]+)\/correct$/);
      if (method === "POST" && correctMatch) {
        const model = decodeParam(correctMatch[1]!);
        const batch = decodeParam(correctMatch[2]!);
        const body = (await readJsonBody(req, maxBodyBytes)) as {
          property?: string;
          member?: string;
          qualifier?: string;
          raw?: string;
          reason?: string;
          expectedVersion?: number | null;
          timeEnvelope?: Ev5TimeEnvelope;
        };
        if (!body.property || typeof body.raw !== "string" || typeof body.reason !== "string") {
          sendJson(res, 400, { code: "invalid-payload", message: "property, raw, and reason are required" }, allowedOrigin);
          return;
        }
        const reqData: CorrectionRequest = {
          model,
          batch,
          property: body.property,
          ...(body.member ? { member: body.member } : {}),
          ...(body.qualifier ? { qualifier: body.qualifier } : {}),
          raw: body.raw,
          reason: body.reason,
        };
        const { snapshot, metadata } = runner.repository.correctRecordAtomic(options.pack, reqData, {
          actor: principal.actor,
          expectedVersion: body.expectedVersion,
          timeEnvelope: body.timeEnvelope,
        });
        await runner.logCorrection(model, batch, snapshot.version);
        sendJson(res, 200, { snapshot, metadata }, allowedOrigin);
        return;
      }

      // POST /api/records/:model/:batch/release
      const relMatch = pathname.match(/^\/api\/records\/([^/]+)\/([^/]+)\/release$/);
      if (method === "POST" && relMatch) {
        const model = decodeParam(relMatch[1]!);
        const batch = decodeParam(relMatch[2]!);
        const body = (await readJsonBody(req, maxBodyBytes)) as { version?: number };
        const snapshot =
          typeof body.version === "number"
            ? runner.repository.getSync(model, batch, body.version)
            : runner.repository.latestSync(model, batch);
        if (!snapshot) {
          sendJson(res, 404, { code: "not-found", message: "Record snapshot not found" }, allowedOrigin);
          return;
        }
        const release = await generateRelease(options.pack, snapshot, { software, by: principal.actor });
        const events = await releaseEvents(model, batch, snapshot.version, release.outcomes);
        for (const ev of events) runner.logStore.addSync(ev);
        sendJson(
          res,
          200,
          {
            manifest: release.manifest,
            substantiveDigest: release.manifestFile.substantiveDigest,
            files: release.files.map((f) => ({
              route: f.route,
              fileName: f.fileName,
              mediaType: f.mediaType,
              status: f.status,
              sha256: sha256Sync(f.bytes),
              base64: Buffer.from(f.bytes).toString("base64"),
            })),
            refused: release.outcomes
              .filter((o): o is Extract<typeof o, { refused: unknown }> => "refused" in o)
              .map((o) => ({ route: o.route, holds: o.refused.holds })),
          },
          allowedOrigin,
        );
        return;
      }

      // GET /api/evidence
      if (method === "GET" && pathname === "/api/evidence") {
        sendJson(res, 200, { evidence: runner.evidenceStore.list() }, allowedOrigin);
        return;
      }

      // GET /api/evidence/:sha256
      const evGetMatch = pathname.match(/^\/api\/evidence\/([0-9a-fA-F]{64})$/);
      if (method === "GET" && evGetMatch) {
        const found = runner.evidenceStore.get(evGetMatch[1]!);
        if (!found) {
          sendJson(res, 404, { code: "not-found", message: "Evidence object not found" }, allowedOrigin);
          return;
        }
        const { contentBytes, ...metadata } = found;
        sendJson(res, 200, { metadata, contentBase64: Buffer.from(contentBytes).toString("base64") }, allowedOrigin);
        return;
      }

      // POST /api/evidence/:sha256/legal-hold
      const evHoldMatch = pathname.match(/^\/api\/evidence\/([0-9a-fA-F]{64})\/legal-hold$/);
      if (method === "POST" && evHoldMatch) {
        const body = (await readJsonBody(req, maxBodyBytes)) as { legalHold?: boolean };
        if (typeof body.legalHold !== "boolean") {
          sendJson(res, 400, { code: "invalid-payload", message: "legalHold boolean is required" }, allowedOrigin);
          return;
        }
        const updated = runner.evidenceStore.setLegalHold(evHoldMatch[1]!, body.legalHold);
        if (!updated) {
          sendJson(res, 404, { code: "not-found", message: "Evidence object not found" }, allowedOrigin);
          return;
        }
        sendJson(res, 200, { metadata: updated }, allowedOrigin);
        return;
      }

      // DELETE /api/evidence/:sha256
      const evDelMatch = pathname.match(/^\/api\/evidence\/([0-9a-fA-F]{64})$/);
      if (method === "DELETE" && evDelMatch) {
        const asOf = url.searchParams.get("asOf") ?? new Date().toISOString();
        const deleted = runner.evidenceStore.delete(evDelMatch[1]!, asOf);
        sendJson(res, deleted ? 200 : 404, { deleted }, allowedOrigin);
        return;
      }

      // GET /api/log & POST /api/log
      if (method === "GET" && pathname === "/api/log") {
        sendJson(res, 200, { entries: runner.logStore.allSync() }, allowedOrigin);
        return;
      }
      if (method === "POST" && pathname === "/api/log") {
        const body = (await readJsonBody(req, maxBodyBytes)) as { entry?: Record<string, unknown> };
        if (!body.entry || typeof body.entry !== "object") {
          sendJson(res, 400, { code: "invalid-payload", message: "entry object is required" }, allowedOrigin);
          return;
        }
        const seq = runner.logStore.addSync(body.entry);
        sendJson(res, 201, { seq }, allowedOrigin);
        return;
      }

      sendJson(res, 404, { code: "not-found", message: `Unknown route ${method} ${pathname}` }, allowedOrigin);
    } catch (err) {
      const mapped = mapError(err);
      sendJson(res, mapped.status, { code: mapped.code, message: mapped.message }, allowedOrigin);
    }
  });
}
