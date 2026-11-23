/**
 * Thin Node 24 HTTP API service for durable relational storage, staged recoverable import jobs,
 * transactional corrections, evidence retention, OIDC + live grant-epoch RBAC, internal/customer
 * deployment surface separation, and controlled configuration package releases (ADR-0004, ADR-0005).
 *
 * Binds to `127.0.0.1` by default, makes zero outbound network calls, sets strict security headers,
 * refuses unauthenticated `local-dev` mode on any non-loopback address, and enforces every role,
 * field, action, and surface rule strictly on the server side.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import {
  CancellationToken,
  JobBudget,
  LIMIT_OUTCOMES,
  LimitError,
  classifyLimitOutcome,
  mayCancelJob,
  type OperationalLimits,
  type PublicLogEntry,
} from "../../src/model/c8Contracts";
import {
  AuthError,
  ConfigReleaseError,
  evaluateRoleAction,
  type AuthContext,
  type AuthMode,
  type DeploymentSurface,
  type ServerAction,
  type ServerRole,
} from "../../src/model/c7Contracts";
import { CorrectionError, type CorrectionRequest } from "../../src/model/correction";
import { project } from "../../src/model/disclosure";
import { LogError, releaseEvents } from "../../src/model/log";
import { buildCustomerPdf } from "../../src/model/outputs/customerPdf";
import { RouteRefusedError } from "../../src/model/outputs/items";
import { generateRelease } from "../../src/model/outputs/release";
import type { SoftwareInfo } from "../../src/model/outputs/software";
import {
  ConcurrencyConflictError,
  DEFAULT_SECURITY_DOMAIN,
  resolveCallerTimeEnvelope,
  type CallerTimeEnvelope,
  RetentionViolationError,
  TimeEnvelopeError,
} from "../../src/model/pContracts";
import type { ProfilePack } from "../../src/model/profile";
import { assess } from "../../src/model/readiness";
import { OPERATOR, RepositoryError } from "../../src/model/recordRepository";
import { authenticateRequest, authorizeRequest, type AuthRuntimeConfig } from "../auth/authorizer";
import { GrantStore } from "../auth/grantStore";
import { OidcVerifier, type OidcConfig } from "../auth/oidc";
import type { DbAdapter } from "../db/adapter";
import { currentMigrationVersion } from "../db/migrations";
import { ImportJobRunner, type ImportEvidenceUpload, type ImportJobControl } from "../jobs/importJobRunner";
import { JobCoordinator, LiveJobs, QueueFullError } from "../jobs/jobControl";
import { RateLimiter, ServerMetrics, routeTemplate } from "./limits";
import { ConfigReleaseStore } from "../releases/configReleaseStore";
import { sha256Sync } from "../store/sqlRepository";

export interface RequestPrincipal {
  actor: typeof OPERATOR;
  securityDomain: string;
  authMode: AuthMode;
  sub?: string;
  roles?: ServerRole[];
}

export type PrincipalExtractor = (req: IncomingMessage) => RequestPrincipal;

export interface DppServerOptions {
  db: DbAdapter;
  pack: ProfilePack;
  securityDomain?: string;
  software?: SoftwareInfo;
  /**
   * Extra browser origins allowed to call the API besides the server's own (never a wildcard). Empty by default:
   * only same-origin requests (the SPA this server serves) and clients that send no Origin (curl, scripts).
   */
  allowedOrigin?: string | string[];
  /** The address the server is bound to; its name is accepted in the Host header besides the loopback names. */
  host?: string;
  /** Directory of the built single-page app (`dist/`) to serve on the same origin; omitted: API only. */
  staticDir?: string;
  /** Test seam: the server clock for retention, OIDC exp/nbf, and time envelopes. Nothing in a request can set it. */
  now?: () => string;
  /** Authentication mode: `local-dev` (loopback-only operator, default) or `oidc` (strict signed Bearer JWT + DB grants). */
  authMode?: AuthMode;
  /** Deployment surface: `all` (default), `internal` (operator/admin/curator only), or `customer` (customer outputs only). */
  surface?: DeploymentSurface;
  /** Required when `authMode === "oidc"`. */
  oidc?: OidcConfig | OidcVerifier;
  /** Optional legacy principal hook (used only in `local-dev` mode when provided). */
  extractPrincipal?: PrincipalExtractor;
  /**
   * Operational limits (Cycle 8, D8-01). Default: the pinned `OPERATIONAL-LIMITS@1.0.0` of `pack`. A test passes a copy with small values
   * so a boundary is reached without large inputs or real waiting; nothing in a request can change them.
   */
  limits?: OperationalLimits;
  /** Test seam: a monotonic millisecond clock for rate windows and job deadlines. Default: `performance.now()`. */
  clock?: () => number;
  /**
   * Public request log hook (D8-04): called exactly once per completed request with the six public fields only. `route` is the matched
   * route template, never the raw path or query. The entry point writes it to stdout; nothing else leaves the process.
   */
  log?: (entry: PublicLogEntry) => void;
  /** Test-only seams (like Cycle 6 crash injection): hold a stage open so a cancel or a deadline lands mid-stage. */
  testHooks?: { stageHook?: ImportJobControl["stageHook"] };
}

const DEFAULT_SOFTWARE: SoftwareInfo = {
  name: "dpp-traceability",
  version: "0.1.0",
  commit: "local",
};

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/** Strict bind-host loopback check used by both `server/index.ts` and `createDppServer`. */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

function isCustomerSurfaceAllowedApiPath(pathname: string): boolean {
  return (
    pathname === "/api/health" ||
    pathname === "/api/auth/me" ||
    pathname === "/api/customer" ||
    pathname.startsWith("/api/customer/")
  );
}

/** Remembers the limit outcome a response carried, so the request metrics can count it without reading the body twice. */
const LIMIT_TAG = Symbol("dpp.limitTag");
const REQUEST_ID = Symbol("dpp.requestId");

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  allowedOrigin?: string,
  extraHeaders?: Record<string, string>,
  allowMethods = "GET, POST, DELETE, OPTIONS",
): void {
  // Every response whose code is a limit code carries the additive `outcome` (and `limit` where known); never an input value.
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const rec = body as Record<string, unknown>;
    const klass = typeof rec.code === "string" ? classifyLimitOutcome(rec.code) : null;
    if (klass && rec.outcome === undefined) body = { ...rec, outcome: klass };
    const outcome = (body as Record<string, unknown>).outcome;
    if (typeof outcome === "string" && (LIMIT_OUTCOMES as readonly string[]).includes(outcome)) {
      const limit = (body as Record<string, unknown>).limit;
      (res as unknown as Record<symbol, unknown>)[LIMIT_TAG] = { outcome, limit: typeof limit === "string" ? limit : "unspecified" };
    }
  }
  const payload = `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(payload)),
    "Content-Security-Policy": "default-src 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
    ...(extraHeaders ?? {}),
  };
  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    headers["Access-Control-Allow-Methods"] = allowMethods;
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Idempotency-Key, X-Security-Domain";
    headers["Vary"] = "Origin";
  }
  res.writeHead(status, headers);
  res.end(payload);
}

/**
 * Reads a JSON object body under a byte cap that is enforced while the body streams (T13): a declared length over the cap is refused
 * before a byte is read, and an undeclared or understated one is refused as soon as the cap is crossed. The rest is discarded, never buffered.
 */
async function readJsonObject(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const tooLarge = () =>
    Object.assign(new Error("Request body exceeds the declared maximum size"), {
      statusCode: 413,
      code: "too-large",
      limit: "max_request_body_bytes",
      closeConnection: true,
    });
  const declared = req.headers["content-length"];
  if (typeof declared === "string" && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    req.resume(); // discard what arrives; nothing is kept
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolveBody, rejectBody) => {
    const onData = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) {
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        chunks.length = 0;
        req.resume(); // discard the rest of the body
        rejectBody(tooLarge());
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => resolveBody();
    const onError = (e: Error) => rejectBody(e);
    const onClose = () => {
      if (!req.complete) rejectBody(Object.assign(new Error("The request was aborted"), { statusCode: 400, code: "request-aborted" }));
    };
    if (req.readableEnded) return resolveBody();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("close", onClose);
  });
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON"), { statusCode: 400, code: "json-syntax" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("Request body must be a JSON object"), { statusCode: 400, code: "invalid-payload" });
  }
  return parsed as Record<string, unknown>;
}

function decodeParam(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw Object.assign(new Error("Invalid path parameter encoding"), { statusCode: 400, code: "invalid-param" });
  }
  if (!decoded || CONTROL_CHARS.test(decoded) || decoded.includes("..") || decoded.includes("/") || decoded.includes("\\")) {
    throw Object.assign(new Error("Invalid path parameter"), { statusCode: 400, code: "invalid-param" });
  }
  return decoded;
}

function toBytes(input: unknown, field: string): Uint8Array {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error(`${field} must be an object with base64 or text content`), { statusCode: 400, code: "invalid-payload" });
  }
  const obj = input as { base64?: unknown; text?: unknown };
  if (typeof obj.base64 === "string") return new Uint8Array(Buffer.from(obj.base64, "base64"));
  if (typeof obj.text === "string") return new TextEncoder().encode(obj.text);
  throw Object.assign(new Error(`${field} must provide base64 or text content`), { statusCode: 400, code: "invalid-payload" });
}

function parseOptionalVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw Object.assign(new Error("version must be a positive safe integer"), { statusCode: 400, code: "invalid-payload" });
  }
  return value;
}

function mapError(err: unknown): { status: number; code: string; message: string; extraHeaders?: Record<string, string>; limit?: string } {
  if (err instanceof QueueFullError) {
    return { status: 429, code: "queue-full", message: err.message, limit: "queue_full", extraHeaders: { "Retry-After": String(err.retryAfterSeconds) } };
  }
  if (err instanceof LimitError) {
    if (err.outcome === "CANCELLED") return { status: 409, code: "cancelled", message: err.message };
    return { status: 422, code: err.code, message: err.message, ...(err.limit !== "cancellation" ? { limit: err.limit } : {}) };
  }
  if (err instanceof AuthError) {
    return {
      status: err.statusCode,
      code: err.code,
      message: err.message,
      ...(err.statusCode === 401 ? { extraHeaders: { "WWW-Authenticate": 'Bearer realm="dpp-suite"' } } : {}),
    };
  }
  if (err instanceof ConfigReleaseError) {
    return { status: err.statusCode, code: err.code, message: err.message };
  }
  if (err && typeof err === "object" && "statusCode" in err && typeof (err as { statusCode: unknown }).statusCode === "number") {
    const e = err as { statusCode: number; code?: string; message?: string; limit?: unknown; closeConnection?: boolean };
    return {
      status: e.statusCode,
      code: e.code ?? "bad-request",
      message: e.message ?? "Bad request",
      ...(typeof e.limit === "string" ? { limit: e.limit } : {}),
      ...(e.closeConnection ? { extraHeaders: { Connection: "close" } } : {}),
    };
  }
  if (err instanceof RetentionViolationError) {
    const status =
      err.code === "retention-active" || err.code === "legal-hold-active" || err.code === "policy-conflict"
        ? 409
        : err.code === "legal-hold-release-refused"
          ? 403
          : err.code === "policy-missing"
            ? 412
            : 400;
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
  if (err instanceof LogError) {
    return { status: 400, code: "log-entry-invalid", message: err.message };
  }
  if (err instanceof Error && /constraint (failed|violation)|UNIQUE|CHECK constraint|FOREIGN KEY/i.test(err.message)) {
    return { status: 409, code: "constraint-conflict", message: "The request conflicts with data already stored" };
  }
  if (err instanceof Error && /append-only|immutable|retention horizon/i.test(err.message)) {
    return { status: 409, code: "retention-active", message: "The stored data is protected and cannot be changed" };
  }
  return { status: 500, code: "internal-error", message: "Internal server error" };
}

/**
 * The host name of a Host header value, or "" when the value is not exactly `name` or `name:port`.
 */
function hostName(header: string | undefined): string {
  const m = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec((header ?? "").trim());
  return m ? m[1]!.toLowerCase() : "";
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Serves a file of the built SPA, falling back to `index.html` for client-side routes. Returns false if there is none. */
function serveStatic(staticDir: string, pathname: string, method: string, res: ServerResponse): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const root = resolve(staticDir);
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  } catch {
    return false;
  }
  let file = join(root, rel);
  if (file !== root && !file.startsWith(root + sep)) return false;
  const isFile = (f: string) => existsSync(f) && statSync(f).isFile();
  if (!isFile(file)) {
    if (extname(rel)) return false;
    file = join(root, "index.html");
    if (!isFile(file)) return false;
  }
  const body = readFileSync(file);
  res.writeHead(200, {
    "Content-Type": STATIC_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": String(body.byteLength),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": file.endsWith("index.html") || file.endsWith("sw.js") ? "no-cache" : "public, max-age=3600",
  });
  res.end(method === "HEAD" ? undefined : body);
  return true;
}

export function createDppServer(options: DppServerOptions): Server {
  const defaultDomain = options.securityDomain ?? DEFAULT_SECURITY_DOMAIN;
  const software = options.software ?? DEFAULT_SOFTWARE;
  const authMode: AuthMode = options.authMode ?? "local-dev";
  const surface: DeploymentSurface = options.surface ?? "all";
  const allowMethods = surface === "customer" ? "GET, POST, OPTIONS" : "GET, POST, DELETE, OPTIONS";
  // Cycle 8: every bound below comes from the pinned OPERATIONAL-LIMITS (D8-01), never from a request.
  const limits: OperationalLimits = options.limits ?? options.pack.operationalLimits;
  const clock = options.clock ?? (() => performance.now());
  const rateLimiter = new RateLimiter({
    windowMs: limits.http.rate_limit_window_ms,
    readPerWindow: limits.http.rate_limit_read_per_window,
    writePerWindow: limits.http.rate_limit_write_per_window,
    maxKeys: 10_000,
    clock,
  });
  const metrics = new ServerMetrics();
  const coordinator = new JobCoordinator(limits);
  const liveJobs = new LiveJobs();
  const REASON_MAX = 500;
  /** A generated output over `max_output_bytes_per_route` is refused before anything is logged or returned (no partial success). */
  const assertOutputWithin = (files: ReadonlyArray<{ bytes: Uint8Array }>): void => {
    if (files.some((f) => f.bytes.byteLength > limits.execution.max_output_bytes_per_route)) {
      throw Object.assign(new Error("A generated output is larger than the declared limit, so nothing was released"), {
        statusCode: 422,
        code: "too-large",
        limit: "max_output_bytes_per_route",
      });
    }
  };

  if (authMode === "local-dev" && options.host !== undefined && !isLoopbackBindHost(options.host)) {
    throw new Error(
      `Refusing to bind unauthenticated local-dev server to non-loopback host "${options.host}". Set DPP_AUTH_MODE=oidc with OIDC JWKS configuration first.`,
    );
  }

  let oidcVerifier: OidcVerifier | undefined;
  if (authMode === "oidc") {
    if (!options.oidc) {
      throw new Error("DPP_AUTH_MODE=oidc requires OIDC configuration (issuer, audience, and JWKS)");
    }
    oidcVerifier = options.oidc instanceof OidcVerifier ? options.oidc : new OidcVerifier(options.oidc);
  }

  const authConfig: AuthRuntimeConfig = {
    mode: authMode,
    surface,
    oidcVerifier,
    now: options.now,
  };

  // Active pack synced atomically by exact releaseId so activations & rollbacks propagate across listeners.
  const cachedPacks = new Map<string, { releaseId: string | null; pack: ProfilePack }>();
  async function resolveActivePack(domain: string): Promise<{ pack: ProfilePack; releaseId: string | null }> {
    const configStore = new ConfigReleaseStore(options.db, domain, { now: options.now });
    const activeRelease = configStore.getActive();
    if (!activeRelease) {
      return { pack: options.pack, releaseId: null };
    }
    const cached = cachedPacks.get(domain);
    if (cached && cached.releaseId === activeRelease.releaseId) {
      return cached;
    }
    const loaded = (await configStore.loadPackByReleaseId(activeRelease.releaseId)) ?? options.pack;
    const entry = { releaseId: activeRelease.releaseId, pack: loaded };
    cachedPacks.set(domain, entry);
    return entry;
  }

  function resolveSecurityDomain(req: IncomingMessage): string {
    if (authMode === "local-dev" && options.extractPrincipal) {
      return options.extractPrincipal(req).securityDomain;
    }
    const headerDomain = typeof req.headers["x-security-domain"] === "string" ? req.headers["x-security-domain"].trim() : "";
    return headerDomain && /^[A-Za-z0-9._-]{1,64}$/.test(headerDomain) ? headerDomain : defaultDomain;
  }

  const extraOrigins = (Array.isArray(options.allowedOrigin) ? options.allowedOrigin : options.allowedOrigin ? [options.allowedOrigin] : []).map((o) =>
    o.replace(/\/+$/, "").toLowerCase(),
  );
  const allowedHosts = new Set([...LOOPBACK_HOSTS, ...(options.host && hostName(options.host) ? [hostName(options.host)] : [])]);

  /** The body cap of a route: its own cap, never above the transport cap (`max_request_body_bytes`). */
  const readBody = (req: IncomingMessage, routeMaxBytes: number) =>
    readJsonObject(req, Math.min(routeMaxBytes, limits.http.max_request_body_bytes));

  const headersTimeout = limits.http.headers_timeout_ms;
  const requestTimeout = limits.http.request_timeout_ms;
  const server = createServer(
    {
      headersTimeout,
      requestTimeout,
      keepAliveTimeout: limits.http.keep_alive_timeout_ms,
      // How often Node looks for sockets past a timeout: often enough that a slow client is cut off close to its limit.
      connectionsCheckingInterval: Math.max(25, Math.min(1000, Math.floor(Math.min(headersTimeout, requestTimeout) / 4))),
    },
    async (req, res) => {
    const method = req.method ?? "GET";

    // Request id (D8-04): generated here, never taken from the client; one public log entry per request, when it completes.
    const requestId = randomUUID();
    (res as unknown as Record<symbol, unknown>)[REQUEST_ID] = requestId;
    res.setHeader("X-Request-Id", requestId);
    res.once("close", () => {
      const status = res.writableFinished ? res.statusCode : 499; // 499: the client left before the answer was sent
      metrics.recordRequest(status);
      const tag = (res as unknown as Record<symbol, unknown>)[LIMIT_TAG] as { outcome: (typeof LIMIT_OUTCOMES)[number]; limit: string } | undefined;
      if (tag) metrics.recordLimit(tag.outcome, tag.limit);
      if (options.log) {
        try {
          options.log({
            ts: new Date().toISOString(),
            level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
            event: "request",
            request_id: requestId,
            route: routeTemplate(method, req.url),
            status,
          });
        } catch {
          // A failing log hook never changes the answer to the request.
        }
      }
    });

    // DNS-rebinding guard: only the loopback names and the bound host are accepted as Host.
    const hostHeaders = req.rawHeaders.filter((_, i) => i % 2 === 0 && _.toLowerCase() === "host").length;
    if (hostHeaders !== 1 || !allowedHosts.has(hostName(req.headers.host))) {
      sendJson(res, 403, { code: "host-not-allowed", message: "The Host header is not one this server answers to" });
      return;
    }
    // Cross-site guard: an Origin must be this server itself or an explicitly allowed origin (default: none).
    const origin = typeof req.headers.origin === "string" ? req.headers.origin.replace(/\/+$/, "").toLowerCase() : undefined;
    const sameOrigin = origin !== undefined && origin === `http://${(req.headers.host ?? "").toLowerCase()}`;
    const crossOriginAllowed = origin !== undefined && extraOrigins.includes(origin);
    if (origin !== undefined && !sameOrigin && !crossOriginAllowed) {
      sendJson(res, 403, { code: "origin-not-allowed", message: "Cross-origin requests are not accepted from this origin" });
      return;
    }
    if (origin === undefined && method !== "GET" && method !== "HEAD" && req.headers["sec-fetch-site"] === "cross-site") {
      sendJson(res, 403, { code: "origin-not-allowed", message: "Cross-site writes are not accepted" });
      return;
    }
    const allowedOrigin = crossOriginAllowed ? origin : undefined;

    // Strict origin-form URL check before surface guard, preflight, or routing.
    const rawUrl = req.url ?? "/";
    if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) {
      sendJson(res, 400, { code: "invalid-url", message: "Request target must be a relative origin-form path" }, allowedOrigin, undefined, allowMethods);
      return;
    }
    let url: URL;
    try {
      url = new URL(rawUrl, "http://127.0.0.1");
    } catch {
      sendJson(res, 400, { code: "invalid-url", message: "Malformed request URL" }, allowedOrigin, undefined, allowMethods);
      return;
    }
    const pathname = url.pathname;

    // Hard deployment-surface allowlist/blocklist enforced BEFORE preflight and BEFORE any route work (C7-03).
    if (surface === "customer" && (pathname === "/api" || pathname.startsWith("/api/")) && !isCustomerSurfaceAllowedApiPath(pathname)) {
      sendJson(
        res,
        403,
        { code: "surface-forbidden", message: `Route "${pathname}" is disabled on the dedicated customer deployment surface` },
        allowedOrigin,
        undefined,
        allowMethods,
      );
      return;
    }
    if (surface === "internal" && (pathname === "/api/customer" || pathname.startsWith("/api/customer/"))) {
      sendJson(
        res,
        403,
        { code: "surface-forbidden", message: `Customer route "${pathname}" is disabled on the internal-only deployment surface` },
        allowedOrigin,
        undefined,
        allowMethods,
      );
      return;
    }

    // Pre-resolved principal of this request, so the rate limiter can key by the authenticated subject (T12). Never carried
    // across requests: the next request is authenticated again from the token and the live grants.
    const isHealth = method === "GET" && pathname === "/api/health";
    let preAuth: AuthContext | undefined;
    let rateSubject = "anon";
    if (pathname.startsWith("/api/") && !isHealth) {
      try {
        preAuth = authenticateRequest(req, options.db, resolveSecurityDomain(req), authConfig);
        rateSubject = preAuth.sub;
      } catch {
        preAuth = undefined; // refused later by the route's own authorization, with its usual answer
      }
    }
    if (!isHealth) {
      const kind = method === "GET" || method === "HEAD" || method === "OPTIONS" ? "read" : "write";
      const verdict = rateLimiter.hit(kind, rateSubject, req.socket.remoteAddress ?? "unknown");
      if (!verdict.allowed) {
        sendJson(
          res,
          429,
          { code: "rate-limited", message: "Too many requests. Retry after the indicated time.", limit: "rate_window" },
          allowedOrigin,
          { "Retry-After": String(verdict.retryAfterSeconds) },
          allowMethods,
        );
        return;
      }
    }

    if (method === "OPTIONS") {
      if (!allowedOrigin) {
        sendJson(res, 403, { code: "origin-not-allowed", message: "No cross-origin access is configured" }, undefined, undefined, allowMethods);
        return;
      }
      res.writeHead(204, {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": allowMethods,
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Idempotency-Key, X-Security-Domain",
        Vary: "Origin",
      });
      res.end();
      return;
    }

    // Every POST names its body type: a form post or a text/plain beacon from another page cannot be a request.
    if (method === "POST") {
      const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (type !== "application/json") {
        sendJson(res, 415, { code: "unsupported-media-type", message: "Writes must be sent as application/json" }, allowedOrigin, undefined, allowMethods);
        return;
      }
    }

    try {
      // Internal operator SPA is never served from a dedicated customer deployment surface (C7-03).
      if (!pathname.startsWith("/api/") && surface !== "customer" && options.staticDir && serveStatic(options.staticDir, pathname, method, res)) {
        return;
      }

      // GET /api/health (unauthenticated liveness probe on all surfaces; ignores caller X-Security-Domain in oidc mode)
      if (method === "GET" && pathname === "/api/health") {
        const healthDomain = authMode === "oidc" ? defaultDomain : resolveSecurityDomain(req);
        const { pack: healthPack, releaseId: healthReleaseId } = await resolveActivePack(healthDomain);
        const healthRunner = new ImportJobRunner(options.db, healthPack, healthDomain, { now: options.now });
        const activePolicy = healthRunner.policies.getActive();
        sendJson(
          res,
          200,
          {
            status: "ok",
            ...(authMode === "local-dev" ? { securityDomain: healthDomain } : {}),
            authMode,
            surface,
            schemaVersion: currentMigrationVersion(options.db),
            packProfile: `${healthPack.id}@${healthPack.version}`,
            packManifestDigest: healthPack.manifestDigest,
            activeRetentionPolicy: activePolicy?.policyPin ?? null,
            activeConfigReleaseId: healthReleaseId,
          },
          allowedOrigin,
          undefined,
          allowMethods,
        );
        return;
      }

      const domain = resolveSecurityDomain(req);
      const requireAuth = (action: ServerAction): AuthContext =>
        authorizeRequest(req, options.db, domain, authConfig, action, preAuth);

      // GET /api/auth/me (authenticated principal introspection on any surface)
      if (method === "GET" && pathname === "/api/auth/me") {
        const ctx = authenticateRequest(req, options.db, domain, authConfig);
        sendJson(
          res,
          200,
          {
            sub: ctx.sub,
            issuer: ctx.issuer,
            roles: ctx.roles,
            grantEpoch: ctx.grantEpoch,
            securityDomain: ctx.securityDomain,
            authMode: ctx.authMode,
            surface: ctx.surface,
          },
          allowedOrigin,
          undefined,
          allowMethods,
        );
        return;
      }

      // Lazy pack/store builder invoked ONLY after authentication/authorization succeeds.
      const loadRuntime = async () => {
        const { pack: activePack } = await resolveActivePack(domain);
        const maxBodyBytes = Math.max(activePack.policy.limits.max_file_bytes * 3, 1_048_576);
        const runner = new ImportJobRunner(options.db, activePack, domain, { now: options.now });
        return { activePack, maxBodyBytes, runner };
      };
      const grants = new GrantStore(options.db, domain, { now: options.now });
      const configReleases = new ConfigReleaseStore(options.db, domain, { now: options.now });
      const defaultMaxBytes = Math.max(options.pack.policy.limits.max_file_bytes * 3, 1_048_576);

      // =========================================================================
      // DEDICATED CUSTOMER OUTPUT SURFACE (/api/customer/*) — C7-03, EV-4
      // =========================================================================

      // GET /api/customer/records
      if (method === "GET" && pathname === "/api/customer/records") {
        requireAuth("record-read-customer");
        const { runner } = await loadRuntime();
        sendJson(res, 200, { records: runner.repository.recordsSync() }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // GET /api/customer/records/:model/:batch (strictly projected through `project(..., "customer-pdf")`)
      const custRecMatch = pathname.match(/^\/api\/customer\/records\/([^/]+)\/([^/]+)$/);
      if (method === "GET" && custRecMatch) {
        requireAuth("record-read-customer");
        const model = decodeParam(custRecMatch[1]!);
        const batch = decodeParam(custRecMatch[2]!);
        const verParam = url.searchParams.get("version");
        let parsedVer: number | undefined;
        if (verParam !== null) {
          if (!/^\d+$/.test(verParam)) {
            sendJson(res, 400, { code: "invalid-payload", message: "version query parameter must be a positive integer" }, allowedOrigin, undefined, allowMethods);
            return;
          }
          parsedVer = parseOptionalVersion(Number(verParam));
        }
        const { activePack, runner } = await loadRuntime();
        const snapshot = parsedVer
          ? runner.repository.getSync(model, batch, parsedVer)
          : runner.repository.latestSync(model, batch);
        if (!snapshot) {
          sendJson(res, 404, { code: "not-found", message: "Record snapshot not found" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        const rawProjection = project(activePack, snapshot.record, "customer-pdf");
        const customerRoute = assess(activePack, snapshot.record).find((r) => r.route === "customer-pdf")!;
        const knownProps = new Set(activePack.properties.map((p) => p.id));
        const isReady = customerRoute.status === "ready";
        const safeProjection = {
          ...rawProjection,
          // Never expose unverified/challenged assertions to customers when the route is on hold.
          values: isReady ? rawProjection.values : [],
          derived: isReady ? rawProjection.derived : [],
          // Never disclose out-of-profile / unknown property names on the customer surface.
          withheld: rawProjection.withheld.filter((w) => knownProps.has(w.property)),
        };
        sendJson(
          res,
          200,
          {
            model,
            batch,
            version: snapshot.version,
            recordDigest: snapshot.record.digest,
            packManifestDigest: activePack.manifestDigest,
            route: "customer-pdf",
            readiness: {
              status: customerRoute.status,
              holds: customerRoute.holds.map((h) => ({
                ruleId: h.ruleId,
                ...(h.property ? { property: h.property } : {}),
                ...(h.field ? { field: h.field } : {}),
                ...(h.detail ? { detail: h.detail } : {}),
              })),
            },
            projection: safeProjection,
          },
          allowedOrigin,
          undefined,
          allowMethods,
        );
        return;
      }

      // POST /api/customer/records/:model/:batch/release (customer PDF only, never ERP CSV or Registry JSON)
      const custRelMatch = pathname.match(/^\/api\/customer\/records\/([^/]+)\/([^/]+)\/release$/);
      if (method === "POST" && custRelMatch) {
        requireAuth("release-customer");
        const model = decodeParam(custRelMatch[1]!);
        const batch = decodeParam(custRelMatch[2]!);
        const { activePack, maxBodyBytes, runner } = await loadRuntime();
        const body = await readBody(req, maxBodyBytes);
        const version = parseOptionalVersion(body.version);
        const snapshot = version
          ? runner.repository.getSync(model, batch, version)
          : runner.repository.latestSync(model, batch);
        if (!snapshot) {
          sendJson(res, 404, { code: "not-found", message: "Record snapshot not found" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        try {
          const pdf = await buildCustomerPdf(activePack, snapshot.record, { version: snapshot.version });
          assertOutputWithin([pdf]);
          const events = await releaseEvents(model, batch, snapshot.version, [{ route: "customer-pdf", file: pdf }]);
          for (const ev of events) runner.logStore.addSync(ev);
          sendJson(
            res,
            200,
            {
              model,
              batch,
              version: snapshot.version,
              recordDigest: snapshot.record.digest,
              packManifestDigest: activePack.manifestDigest,
              file: {
                route: pdf.route,
                fileName: pdf.fileName,
                mediaType: pdf.mediaType,
                status: pdf.status,
                sha256: sha256Sync(pdf.bytes),
                base64: Buffer.from(pdf.bytes).toString("base64"),
              },
            },
            allowedOrigin,
            undefined,
            allowMethods,
          );
          return;
        } catch (err) {
          if (err instanceof RouteRefusedError) {
            sendJson(
              res,
              409,
              {
                code: "route-on-hold",
                message: "Customer PDF is on hold and cannot be released",
                holds: err.holds.map((h) => ({
                  ruleId: h.ruleId,
                  ...(h.property ? { property: h.property } : {}),
                  ...(h.field ? { field: h.field } : {}),
                  ...(h.detail ? { detail: h.detail } : {}),
                })),
              },
              allowedOrigin,
              undefined,
              allowMethods,
            );
            return;
          }
          throw err;
        }
      }

      // =========================================================================
      // IDENTITY & ROLE ADMINISTRATION (/api/admin/*) — P03, C7-01, C7-02
      // =========================================================================

      // GET /api/admin/users
      if (method === "GET" && pathname === "/api/admin/users") {
        requireAuth("role-read");
        sendJson(res, 200, { users: grants.listUsers() }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // POST /api/admin/users
      if (method === "POST" && pathname === "/api/admin/users") {
        const ctx = requireAuth("role-manage");
        const body = await readBody(req, defaultMaxBytes);
        if (typeof body.sub !== "string" || typeof body.displayName !== "string" || typeof body.reason !== "string") {
          sendJson(res, 400, { code: "invalid-payload", message: "sub, displayName, and reason are required" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        if (body.roles !== undefined && !Array.isArray(body.roles)) {
          sendJson(res, 400, { code: "invalid-payload", message: "roles must be an array" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        const user = grants.upsertUser({
          sub: body.sub,
          displayName: body.displayName,
          roles: body.roles as ServerRole[] | undefined,
          actorSub: ctx.sub,
          reason: body.reason,
        });
        sendJson(res, 200, { user }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // POST /api/admin/users/:sub/roles
      const assignRoleMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/roles$/);
      if (method === "POST" && assignRoleMatch) {
        const ctx = requireAuth("role-manage");
        const targetSub = decodeParam(assignRoleMatch[1]!);
        const body = await readBody(req, defaultMaxBytes);
        if (typeof body.role !== "string" || typeof body.reason !== "string") {
          sendJson(res, 400, { code: "invalid-payload", message: "role and reason are required" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        const user = grants.assignRole(targetSub, body.role, ctx.sub, body.reason);
        sendJson(res, 200, { user }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // POST /api/admin/users/:sub/roles/revoke
      const revokeRolePostMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/roles\/revoke$/);
      if (method === "POST" && revokeRolePostMatch) {
        const ctx = requireAuth("role-manage");
        const targetSub = decodeParam(revokeRolePostMatch[1]!);
        const body = await readBody(req, defaultMaxBytes);
        if (typeof body.role !== "string" || typeof body.reason !== "string") {
          sendJson(res, 400, { code: "invalid-payload", message: "role and reason are required" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        const user = grants.revokeRole(targetSub, body.role, ctx.sub, body.reason);
        sendJson(res, 200, { user }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // DELETE /api/admin/users/:sub/roles/:role
      const revokeRoleDelMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/roles\/([^/]+)$/);
      if (method === "DELETE" && revokeRoleDelMatch) {
        const ctx = requireAuth("role-manage");
        const targetSub = decodeParam(revokeRoleDelMatch[1]!);
        const role = decodeParam(revokeRoleDelMatch[2]!);
        const queryReason = url.searchParams.get("reason")?.trim() || undefined;
        let reason = queryReason;
        if (!reason) {
          const body = await readBody(req, defaultMaxBytes);
          if (typeof body.reason !== "string") {
            sendJson(res, 400, { code: "reason-required", message: "reason (query parameter or JSON string) is required" }, allowedOrigin, undefined, allowMethods);
            return;
          }
          reason = body.reason;
        }
        const user = grants.revokeRole(targetSub, role, ctx.sub, reason);
        sendJson(res, 200, { user }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // POST /api/admin/users/:sub/deactivate
      const deactivateMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/deactivate$/);
      if (method === "POST" && deactivateMatch) {
        const ctx = requireAuth("role-manage");
        const targetSub = decodeParam(deactivateMatch[1]!);
        const body = await readBody(req, defaultMaxBytes);
        if (typeof body.reason !== "string") {
          sendJson(res, 400, { code: "invalid-payload", message: "reason is required" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        const user = grants.deactivateUser(targetSub, ctx.sub, body.reason);
        sendJson(res, 200, { user }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // GET /api/admin/audit
      if (method === "GET" && pathname === "/api/admin/audit") {
        requireAuth("role-read");
        sendJson(res, 200, { events: grants.listAuditEvents() }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // GET /api/admin/metrics (Cycle 8, T23): counters only. No subject, id, value or path appears in it.
      if (method === "GET" && pathname === "/api/admin/metrics") {
        requireAuth("metrics:read");
        sendJson(res, 200, metrics.snapshot(coordinator.snapshot()), allowedOrigin, undefined, allowMethods);
        return;
      }

      // =========================================================================
      // CONTROLLED CONFIGURATION RELEASES (/api/config-releases/*) — P04, C7-04
      // =========================================================================

      // GET /api/config-releases
      if (method === "GET" && pathname === "/api/config-releases") {
        requireAuth("config-read");
        const packageId = url.searchParams.get("packageId") ?? undefined;
        sendJson(
          res,
          200,
          {
            activeReleaseId: configReleases.getActive(packageId)?.releaseId ?? null,
            releases: configReleases.list(packageId),
          },
          allowedOrigin,
          undefined,
          allowMethods,
        );
        return;
      }

      // POST /api/config-releases/propose
      if (method === "POST" && pathname === "/api/config-releases/propose") {
        const ctx = requireAuth("config-propose");
        const { maxBodyBytes } = await loadRuntime();
        const body = await readBody(req, maxBodyBytes);
        const release = await configReleases.propose(body, ctx.sub);
        sendJson(res, 201, { release }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // POST /api/config-releases/rollback
      if (method === "POST" && pathname === "/api/config-releases/rollback") {
        const ctx = requireAuth("config-rollback");
        const body = await readBody(req, defaultMaxBytes);
        if (typeof body.packageId !== "string" || typeof body.reason !== "string") {
          sendJson(res, 400, { code: "invalid-payload", message: "packageId and reason are required" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        if (body.targetReleaseId !== undefined && typeof body.targetReleaseId !== "string") {
          sendJson(res, 400, { code: "invalid-payload", message: "targetReleaseId must be a string when provided" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        const result = await configReleases.rollback(body.packageId, body.targetReleaseId, ctx.sub, body.reason);
        cachedPacks.set(domain, { releaseId: result.release.releaseId, pack: result.pack });
        sendJson(
          res,
          200,
          {
            release: result.release,
            rolledBackFrom: result.rolledBackFrom,
            packProfile: `${result.pack.id}@${result.pack.version}`,
            packManifestDigest: result.pack.manifestDigest,
            activeRetentionPolicy: `${result.pack.policy.retention.id}@${result.pack.policy.retention.version}`,
          },
          allowedOrigin,
          undefined,
          allowMethods,
        );
        return;
      }

      // POST /api/config-releases/:releaseId/approve
      const cfgApproveMatch = pathname.match(/^\/api\/config-releases\/([^/]+)\/approve$/);
      if (method === "POST" && cfgApproveMatch) {
        const ctx = requireAuth("config-approve");
        const releaseId = decodeParam(cfgApproveMatch[1]!);
        const body = await readBody(req, defaultMaxBytes);
        const release = configReleases.approve(releaseId, ctx.sub, typeof body.reason === "string" ? body.reason : "");
        sendJson(res, 200, { release }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // POST /api/config-releases/:releaseId/reject
      const cfgRejectMatch = pathname.match(/^\/api\/config-releases\/([^/]+)\/reject$/);
      if (method === "POST" && cfgRejectMatch) {
        const ctx = requireAuth("config-approve");
        const releaseId = decodeParam(cfgRejectMatch[1]!);
        const body = await readBody(req, defaultMaxBytes);
        const release = configReleases.reject(releaseId, ctx.sub, typeof body.reason === "string" ? body.reason : "");
        sendJson(res, 200, { release }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // POST /api/config-releases/:releaseId/activate
      const cfgActivateMatch = pathname.match(/^\/api\/config-releases\/([^/]+)\/activate$/);
      if (method === "POST" && cfgActivateMatch) {
        const ctx = requireAuth("config-activate");
        const releaseId = decodeParam(cfgActivateMatch[1]!);
        const body = await readBody(req, defaultMaxBytes);
        const result = await configReleases.activate(releaseId, ctx.sub, typeof body.reason === "string" ? body.reason : "");
        cachedPacks.set(domain, { releaseId: result.release.releaseId, pack: result.pack });
        sendJson(
          res,
          200,
          {
            release: result.release,
            packProfile: `${result.pack.id}@${result.pack.version}`,
            packManifestDigest: result.pack.manifestDigest,
            activeRetentionPolicy: `${result.pack.policy.retention.id}@${result.pack.policy.retention.version}`,
          },
          allowedOrigin,
          undefined,
          allowMethods,
        );
        return;
      }

      // GET /api/config-releases/:releaseId
      const cfgGetMatch = pathname.match(/^\/api\/config-releases\/([^/]+)$/);
      if (method === "GET" && cfgGetMatch) {
        requireAuth("config-read");
        const releaseId = decodeParam(cfgGetMatch[1]!);
        const release = configReleases.get(releaseId);
        if (!release) {
          sendJson(res, 404, { code: "not-found", message: "Configuration release not found" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        sendJson(res, 200, { release, events: configReleases.listEvents(releaseId) }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // =========================================================================
      // INTERNAL DPP WORKFLOW ENDPOINTS (C6 + C7 RBAC Enforcement)
      // =========================================================================

      // GET /api/policy/retention
      if (method === "GET" && pathname === "/api/policy/retention") {
        requireAuth("config-read");
        const { runner } = await loadRuntime();
        const active = runner.policies.getActive();
        sendJson(res, 200, { active }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // GET /api/policy/exceptions
      if (method === "GET" && pathname === "/api/policy/exceptions") {
        requireAuth("config-read");
        const { activePack } = await loadRuntime();
        sendJson(res, 200, { catalogue: activePack.policy.exceptions }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // POST /api/jobs/import
      if (method === "POST" && pathname === "/api/jobs/import") {
        const submitter = requireAuth("import-submit");
        const { maxBodyBytes, runner } = await loadRuntime();
        const body = await readBody(req, maxBodyBytes);

        if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== "string") {
          sendJson(res, 400, { code: "invalid-payload", message: "idempotencyKey must be a string" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        const idemHeader = typeof req.headers["x-idempotency-key"] === "string" ? req.headers["x-idempotency-key"].trim() : "";
        const idempotencyKey = ((body.idempotencyKey as string | undefined) ?? idemHeader).trim();
        if (!idempotencyKey) {
          sendJson(res, 400, { code: "idempotency-key-missing", message: "idempotencyKey (or X-Idempotency-Key header) is required" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        if (!body.erp || typeof body.erp !== "object" || Array.isArray(body.erp)) {
          sendJson(res, 400, { code: "missing-erp", message: "erp payload object is required" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        if (body.evidence !== undefined && !Array.isArray(body.evidence)) {
          sendJson(res, 400, { code: "invalid-payload", message: "evidence must be an array" }, allowedOrigin, undefined, allowMethods);
          return;
        }

        const erpObj = body.erp as { name?: unknown; type?: unknown; base64?: unknown; text?: unknown };
        const erpBytes = toBytes(erpObj, "erp");

        let labPayload: { bytes: Uint8Array; name: string; type: string } | undefined;
        if (body.lab !== undefined) {
          if (!body.lab || typeof body.lab !== "object" || Array.isArray(body.lab)) {
            sendJson(res, 400, { code: "invalid-payload", message: "lab must be an object" }, allowedOrigin, undefined, allowMethods);
            return;
          }
          const labObj = body.lab as { name?: unknown; type?: unknown; base64?: unknown; text?: unknown };
          labPayload = {
            bytes: toBytes(labObj, "lab"),
            name: typeof labObj.name === "string" ? labObj.name : "lab-assessment.json",
            type: typeof labObj.type === "string" ? labObj.type : "application/json",
          };
        }

        const evidence: ImportEvidenceUpload[] | undefined = (body.evidence as unknown[] | undefined)?.map((rawEv, idx) => {
          if (!rawEv || typeof rawEv !== "object" || Array.isArray(rawEv)) {
            throw Object.assign(new Error(`evidence[${idx}] must be an object`), { statusCode: 400, code: "invalid-payload" });
          }
          const e = rawEv as Record<string, unknown>;
          if (
            typeof e.evidenceId !== "string" ||
            typeof e.issuer !== "string" ||
            typeof e.revision !== "string" ||
            typeof e.recordKind !== "string"
          ) {
            throw Object.assign(new Error(`evidence[${idx}] requires string evidenceId, issuer, revision, and recordKind`), {
              statusCode: 400,
              code: "invalid-payload",
            });
          }
          return {
            evidenceId: e.evidenceId,
            issuer: e.issuer,
            revision: e.revision,
            recordKind: e.recordKind,
            dataset: typeof e.dataset === "string" ? e.dataset : undefined,
            statedClassification:
              typeof e.statedClassification === "string" || e.statedClassification === null
                ? e.statedClassification
                : undefined,
            declaredSha256: typeof e.declaredSha256 === "string" ? e.declaredSha256 : undefined,
            mediaType: typeof e.mediaType === "string" ? e.mediaType : undefined,
            contentBytes: toBytes(e, `evidence[${e.evidenceId}]`),
            legalHold: typeof e.legalHold === "boolean" ? e.legalHold : undefined,
          };
        });

        // Cycle 8: a slot of the coordinator (per-domain active slots, a finite FIFO queue, a global cap), then a budget.
        // A full queue is refused at once with 429 + Retry-After. The slot is freed on every way out (commit, fail, rollback,
        // cancel, timeout, exception, client disconnect). The server never retries on its own.
        const slot = coordinator.admit(domain);
        const token = new CancellationToken();
        let started = false;
        let claimedJobId: string | null = null;
        res.once("close", () => {
          if (res.writableFinished) return;
          token.cancel("client-disconnected"); // the client left: the job stops at its next check and nothing is committed
          if (!started) slot.release(); // still queued: leave the queue now
        });
        let outcome: Awaited<ReturnType<typeof runner.runImportJob>>;
        try {
          try {
            await slot.ready;
          } catch {
            return; // abandoned while queued: the client is gone
          }
          started = true;
          const budget = new JobBudget({ deadlineMs: limits.execution.job_deadline_ms, now: clock, token });
          const control: ImportJobControl = {
            budget,
            limits: limits.execution,
            submitterSub: submitter.sub,
            onClaimed: (jobId) => {
              claimedJobId = jobId;
              liveJobs.register(jobId, { budget, token, securityDomain: domain, submitterSub: submitter.sub });
            },
            stageHook: options.testHooks?.stageHook,
          };
          outcome = await runner.runImportJob({
            control,
          idempotencyKey,
          actor: OPERATOR,
          dataset: typeof body.dataset === "string" ? body.dataset : undefined,
          statedClassification:
            typeof body.statedClassification === "string" || body.statedClassification === null
              ? body.statedClassification
              : undefined,
          expectedVersion:
            typeof body.expectedVersion === "number" || body.expectedVersion === null
              ? body.expectedVersion
              : undefined,
          reason: typeof body.reason === "string" ? body.reason : undefined,
          timeEnvelope: body.timeEnvelope as CallerTimeEnvelope | undefined,
          erp: {
            bytes: erpBytes,
            name: typeof erpObj.name === "string" ? erpObj.name : "erp-extract.csv",
            type: typeof erpObj.type === "string" ? erpObj.type : "text/csv",
          },
          lab: labPayload,
          evidence,
          });

        } finally {
          if (claimedJobId) liveJobs.unregister(claimedJobId);
          slot.release();
        }

        sendJson(res, outcome.ok ? 200 : 422, outcome, allowedOrigin, undefined, allowMethods);
        return;
      }

      // POST /api/jobs/recover
      if (method === "POST" && pathname === "/api/jobs/recover") {
        requireAuth("job-recover");
        const { runner } = await loadRuntime();
        const report = runner.recoverPendingJobs();
        sendJson(res, 200, report, allowedOrigin, undefined, allowMethods);
        return;
      }

      // POST /api/jobs/:jobId/cancel (Cycle 8, LEAN-DEF-09, D8-02). The submitter (same sub, ACT-01) or an ADMIN, with a mandatory reason.
      const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelMatch) {
        const ctx = requireAuth("job:cancel");
        const jobId = decodeParam(cancelMatch[1]!);
        const body = await readBody(req, defaultMaxBytes);
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        if (!reason || reason.length > REASON_MAX || CONTROL_CHARS.test(reason)) {
          sendJson(
            res,
            400,
            { code: "reason-required", message: `A single-line reason of 1..${REASON_MAX} characters is required` },
            allowedOrigin,
            undefined,
            allowMethods,
          );
          return;
        }
        const { runner } = await loadRuntime();
        const job = runner.getJob(jobId);
        if (!job) {
          sendJson(res, 404, { code: "not-found", message: "Job not found" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        const owner = runner.getSubmitter(jobId) ?? "";
        if (!ctx.roles.some((role) => mayCancelJob(role, ctx.sub, owner))) {
          throw new AuthError("forbidden", 403, "Only the submitter of this job, or an ADMIN, may cancel it");
        }
        if (job.state === "running") {
          const live = liveJobs.get(jobId, domain);
          if (!live) {
            sendJson(res, 409, { code: "not-cancellable", message: "The job is not running in this server process" }, allowedOrigin, undefined, allowMethods);
            return;
          }
          const result = live.budget.cancel(reason);
          if (result === "cancelled") runner.recordCancellation(jobId, ctx.sub, reason);
          sendJson(
            res,
            200,
            { jobId, status: result === "not-cancellable" ? "already-cancelled" : result, outcome: "CANCELLED" },
            allowedOrigin,
            undefined,
            allowMethods,
          );
          return;
        }
        if (job.state === "rolled_back" && job.errorCode === "cancelled") {
          sendJson(res, 200, { jobId, status: "already-cancelled", outcome: "CANCELLED" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        sendJson(res, 409, { code: "not-cancellable", message: `The job has already ended (${job.state})` }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // GET /api/jobs
      if (method === "GET" && pathname === "/api/jobs") {
        requireAuth("job-read");
        const { runner } = await loadRuntime();
        sendJson(res, 200, { jobs: runner.listJobs() }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // GET /api/jobs/:jobId
      const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (method === "GET" && jobMatch) {
        requireAuth("job-read");
        const jobId = decodeParam(jobMatch[1]!);
        const { runner } = await loadRuntime();
        const job = runner.getJob(jobId);
        if (!job) {
          sendJson(res, 404, { code: "not-found", message: "Job not found" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        sendJson(
          res,
          200,
          {
            job,
            events: runner.getJobEvents(jobId),
            receipt: runner.getReceiptForJob(jobId) ?? null,
            cancellation: runner.getCancellation(jobId),
          },
          allowedOrigin,
          undefined,
          allowMethods,
        );
        return;
      }

      // GET /api/records
      if (method === "GET" && pathname === "/api/records") {
        requireAuth("record-read-internal");
        const { runner } = await loadRuntime();
        sendJson(res, 200, { records: runner.repository.recordsSync() }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // GET /api/records/:model/:batch/history
      const histMatch = pathname.match(/^\/api\/records\/([^/]+)\/([^/]+)\/history$/);
      if (method === "GET" && histMatch) {
        requireAuth("record-read-internal");
        const model = decodeParam(histMatch[1]!);
        const batch = decodeParam(histMatch[2]!);
        const { runner } = await loadRuntime();
        const history = runner.repository.historySync(model, batch);
        const metadata = history.map((s) => runner.repository.getSnapshotMeta(model, batch, s.version)!);
        sendJson(res, 200, { model, batch, history, metadata }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // Snapshots are written only by import jobs and corrections: there is no raw snapshot write endpoint.
      if (/^\/api\/records\/[^/]+\/[^/]+\/snapshots$/.test(pathname)) {
        if (authMode === "oidc") requireAuth("record-correct");
        sendJson(res, 405, { code: "method-not-allowed", message: "Snapshots are created only by import jobs and corrections" }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // POST /api/records/:model/:batch/correct
      const correctMatch = pathname.match(/^\/api\/records\/([^/]+)\/([^/]+)\/correct$/);
      if (method === "POST" && correctMatch) {
        requireAuth("record-correct");
        const model = decodeParam(correctMatch[1]!);
        const batch = decodeParam(correctMatch[2]!);
        const { activePack, maxBodyBytes, runner } = await loadRuntime();
        const body = await readBody(req, maxBodyBytes);
        if (typeof body.property !== "string" || !body.property || typeof body.raw !== "string" || typeof body.reason !== "string") {
          sendJson(res, 400, { code: "invalid-payload", message: "property, raw, and reason are required" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        const reqData: CorrectionRequest = {
          model,
          batch,
          property: body.property,
          ...(typeof body.member === "string" && body.member ? { member: body.member } : {}),
          ...(typeof body.qualifier === "string" && body.qualifier ? { qualifier: body.qualifier } : {}),
          raw: body.raw,
          reason: body.reason,
        };
        const { snapshot, metadata } = runner.repository.correctRecordAtomic(activePack, reqData, {
          actor: OPERATOR,
          expectedVersion:
            typeof body.expectedVersion === "number" || body.expectedVersion === null
              ? body.expectedVersion
              : undefined,
          timeEnvelope: resolveCallerTimeEnvelope(
            body.timeEnvelope as CallerTimeEnvelope | undefined,
            (options.now ?? (() => new Date().toISOString()))(),
          ),
        });
        await runner.logCorrection(model, batch, snapshot.version);
        sendJson(res, 200, { snapshot, metadata }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // POST /api/records/:model/:batch/release
      const relMatch = pathname.match(/^\/api\/records\/([^/]+)\/([^/]+)\/release$/);
      if (method === "POST" && relMatch) {
        requireAuth("release-internal");
        const model = decodeParam(relMatch[1]!);
        const batch = decodeParam(relMatch[2]!);
        const { activePack, maxBodyBytes, runner } = await loadRuntime();
        const body = await readBody(req, maxBodyBytes);
        const version = parseOptionalVersion(body.version);
        const snapshot = version
          ? runner.repository.getSync(model, batch, version)
          : runner.repository.latestSync(model, batch);
        if (!snapshot) {
          sendJson(res, 404, { code: "not-found", message: "Record snapshot not found" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        const release = await generateRelease(activePack, snapshot, { software, by: OPERATOR });
        assertOutputWithin(release.files);
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
          undefined,
          allowMethods,
        );
        return;
      }

      // GET /api/evidence
      if (method === "GET" && pathname === "/api/evidence") {
        requireAuth("evidence-read");
        const { runner } = await loadRuntime();
        sendJson(res, 200, { evidence: runner.evidenceStore.list() }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // GET /api/evidence/:sha256
      const evGetMatch = pathname.match(/^\/api\/evidence\/([0-9a-fA-F]{64})$/);
      if (method === "GET" && evGetMatch) {
        requireAuth("evidence-read");
        const { runner } = await loadRuntime();
        const found = runner.evidenceStore.get(evGetMatch[1]!);
        if (!found) {
          sendJson(res, 404, { code: "not-found", message: "Evidence object not found" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        const { contentBytes, ...metadata } = found;
        sendJson(res, 200, { metadata, contentBase64: Buffer.from(contentBytes).toString("base64") }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // POST /api/evidence/:sha256/legal-hold
      const evHoldMatch = pathname.match(/^\/api\/evidence\/([0-9a-fA-F]{64})\/legal-hold$/);
      if (method === "POST" && evHoldMatch) {
        if (authMode === "oidc") {
          // Enforce RBAC BEFORE buffering or validating body so unauthorized roles always receive 403.
          const preCtx = authenticateRequest(req, options.db, domain, authConfig);
          const canPlace = evaluateRoleAction(preCtx, "evidence-legal-hold-place").permitted;
          const canRelease = evaluateRoleAction(preCtx, "evidence-legal-hold-release").permitted;
          if (!canPlace && !canRelease) {
            throw new AuthError("forbidden", 403, "Principal is not permitted to modify evidence legal holds");
          }
        }
        const body = await readBody(req, defaultMaxBytes);
        if (typeof body.legalHold !== "boolean") {
          sendJson(res, 400, { code: "invalid-payload", message: "legalHold boolean is required" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        if (body.reason !== undefined && typeof body.reason !== "string") {
          sendJson(res, 400, { code: "invalid-payload", message: "reason must be a string" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        const reasonStr = typeof body.reason === "string" ? body.reason.trim() : "";
        if (!body.legalHold) {
          if (authMode === "local-dev") {
            throw new RetentionViolationError(
              "legal-hold-release-refused",
              "A legal hold cannot be released over the API until operators are authenticated",
            );
          }
          const ctx = requireAuth("evidence-legal-hold-release");
          if (!reasonStr) {
            sendJson(res, 400, { code: "reason-required", message: "A reason is required to release a legal hold" }, allowedOrigin, undefined, allowMethods);
            return;
          }
          const { runner } = await loadRuntime();
          const updated = options.db.transaction(() => {
            const meta = runner.evidenceStore.setLegalHold(evHoldMatch[1]!, false);
            if (meta) grants.recordLegalHoldAudit(evHoldMatch[1]!, ctx.sub, false, reasonStr);
            return meta;
          });
          if (!updated) {
            sendJson(res, 404, { code: "not-found", message: "Evidence object not found" }, allowedOrigin, undefined, allowMethods);
            return;
          }
          sendJson(res, 200, { metadata: updated }, allowedOrigin, undefined, allowMethods);
          return;
        }
        const ctx = requireAuth("evidence-legal-hold-place");
        const { runner } = await loadRuntime();
        const updated = options.db.transaction(() => {
          const meta = runner.evidenceStore.setLegalHold(evHoldMatch[1]!, true);
          if (meta && authMode === "oidc") {
            grants.recordLegalHoldAudit(evHoldMatch[1]!, ctx.sub, true, reasonStr || "Legal hold placed");
          }
          return meta;
        });
        if (!updated) {
          sendJson(res, 404, { code: "not-found", message: "Evidence object not found" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        sendJson(res, 200, { metadata: updated }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // DELETE /api/evidence/:sha256
      const evDelMatch = pathname.match(/^\/api\/evidence\/([0-9a-fA-F]{64})$/);
      if (method === "DELETE" && evDelMatch) {
        if (authMode === "oidc") {
          requireAuth("evidence-delete");
        }
        if (url.searchParams.has("asOf")) {
          sendJson(res, 400, { code: "as-of-not-accepted", message: "Retention is judged on the server clock only" }, allowedOrigin, undefined, allowMethods);
          return;
        }
        const { runner } = await loadRuntime();
        const deleted = runner.evidenceStore.delete(evDelMatch[1]!);
        sendJson(res, deleted ? 200 : 404, { deleted }, allowedOrigin, undefined, allowMethods);
        return;
      }

      // GET /api/log & POST /api/log
      if (method === "GET" && pathname === "/api/log") {
        requireAuth("log-read");
        const { runner } = await loadRuntime();
        sendJson(res, 200, { entries: runner.logStore.allSync() }, allowedOrigin, undefined, allowMethods);
        return;
      }
      if (pathname === "/api/log" && method !== "GET") {
        if (authMode === "oidc") requireAuth("log-read");
        sendJson(res, 405, { code: "method-not-allowed", message: "Log entries are written by the server only" }, allowedOrigin, undefined, allowMethods);
        return;
      }

      sendJson(res, 404, { code: "not-found", message: "Unknown route" }, allowedOrigin, undefined, allowMethods);
    } catch (err) {
      const mapped = mapError(err);
      sendJson(
        res,
        mapped.status,
        { code: mapped.code, message: mapped.message, ...(mapped.limit ? { limit: mapped.limit } : {}) },
        allowedOrigin,
        mapped.extraHeaders,
        allowMethods,
      );
    }
    },
  );

  // T11: a hard cap on open connections; a connection over it is refused at once and counted.
  server.maxConnections = limits.http.max_connections;
  server.on("drop", () => metrics.recordLimit("OVER_LIMIT", "max_connections"));
  // T11: a client that is too slow to send its headers or its request (Slowloris) is answered 408 and its socket is closed.
  server.on("clientError", (err: Error & { code?: string }, socket) => {
    const timedOut = err.code === "ERR_HTTP_REQUEST_TIMEOUT";
    if (timedOut) metrics.recordLimit("TIMEOUT", "request_timeout_ms");
    if (socket.writable && !socket.destroyed) {
      socket.end(`HTTP/1.1 ${timedOut ? "408 Request Timeout" : "400 Bad Request"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } else {
      socket.destroy();
    }
  });
  return server;
}
