/**
 * Runtime egress guard (D8-05, LEAN-DEF-13, threat T10).
 *
 * Patches the Node network entry points so a connection, lookup or fetch to any non-loopback destination that
 * `decideEgress` does not allow is refused (mode "refuse": throws EgressRefusedError) or recorded (mode "record":
 * used by the Vitest no-egress monitor). There is no fallback from local to external processing.
 *
 * Install is layered and reversible: each install pushes a layer and returns an uninstall function; the newest layer
 * decides, patches are applied once and removed when the last layer goes. State lives on globalThis, so separate module
 * instances in one process share it.
 */
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import module from "node:module";
import net from "node:net";
import tls from "node:tls";
import { decideEgress } from "../../src/model/c8Contracts";

export type EgressMode = "refuse" | "record";

export interface EgressAttempt {
  api: string;
  host: string;
}

export class EgressRefusedError extends Error {
  override name = "EgressRefusedError";
  readonly code = "EGRESS_REFUSED";
  constructor(
    readonly api: string,
    readonly host: string,
  ) {
    super(`egress refused: ${api} to ${host.slice(0, 120)}`);
  }
}

export interface EgressGuardOptions {
  /** Exact host names or IPs that may be reached besides loopback. */
  allowlist: string[];
  mode: EgressMode;
}

export type EgressGuardHandle = (() => void) & { attempts: EgressAttempt[] };

/** Host names from the origin list in config/egress-allowlist.json (`connect`). */
export function allowlistHosts(connect: readonly string[]): string[] {
  const out: string[] = [];
  for (const origin of connect) {
    try {
      out.push(new URL(origin).hostname.replace(/^\[|\]$/g, ""));
    } catch {
      /* a malformed entry allows nothing */
    }
  }
  return out;
}

interface Layer {
  allowlist: string[];
  mode: EgressMode;
  attempts: EgressAttempt[];
  active: boolean;
}

interface State {
  layers: Layer[];
  restore: Array<() => void>;
  /** Depth of `net.Server.listen` calls in progress on this thread: their lookups resolve a LOCAL bind address, not a destination. */
  listening: number;
}

const KEY = Symbol.for("dpp.egressGuard.state");
const g = globalThis as unknown as Record<symbol, State | undefined>;
const state = (): State => (g[KEY] ??= { layers: [], restore: [], listening: 0 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
type Bag = Record<string, unknown>;

/** Throws or records. `host` undefined/empty means the platform default (localhost), which is loopback. */
function check(api: string, host: unknown): void {
  const s = state();
  const layer = s.layers[s.layers.length - 1];
  if (!layer) return;
  const h = typeof host === "string" && host.length > 0 ? host : "localhost";
  if (decideEgress(h, layer.allowlist) === "allow") return;
  layer.attempts.push({ api, host: h.slice(0, 120) });
  if (layer.mode === "refuse") throw new EgressRefusedError(api, h);
}

const declaredAllowlisted = (layer: Layer, declared: string) => layer.allowlist.some((a) => typeof a === "string" && a.toLowerCase() === declared.toLowerCase());

/**
 * Checks an address a connection resolved to or is dialling (F1). A name on the allow-list may resolve anywhere; any other
 * destination must resolve to loopback or an allowed address, so a custom `lookup` cannot send "localhost" to a LAN host.
 * Returns the refusal (refuse mode) or null (allowed, or recorded in record mode).
 */
function checkResolved(api: string, declared: string, address: unknown): EgressRefusedError | null {
  const s = state();
  const layer = s.layers[s.layers.length - 1];
  if (!layer || declaredAllowlisted(layer, declared)) return null;
  const addr = typeof address === "string" && address.length > 0 ? address : "(none)";
  if (decideEgress(addr, layer.allowlist) === "allow") return null;
  layer.attempts.push({ api, host: addr.slice(0, 120) });
  return layer.mode === "refuse" ? new EgressRefusedError(api, addr) : null;
}

type LookupFn = (host: string, opts: unknown, cb: (...r: unknown[]) => void) => unknown;

/** Wraps a `lookup` function so every address it returns is checked; a denied address fails the lookup. */
function guardLookup(inner: LookupFn | undefined, declared: string): LookupFn {
  const base: LookupFn = inner ?? ((h, o, cb) => (dns.lookup as unknown as LookupFn)(h, o, cb));
  return (host, opts, cb) => {
    let options = opts;
    let done = cb;
    if (typeof opts === "function") {
      done = opts as typeof cb;
      options = {};
    }
    return base(host, options, (...r: unknown[]) => {
      const [err, address] = r;
      if (!err) {
        const list = Array.isArray(address) ? address.map((x) => (x && typeof x === "object" ? (x as { address?: unknown }).address : x)) : [address];
        for (const a of list) {
          const refusal = checkResolved("net.lookup", declared, a);
          if (refusal) return done(refusal);
        }
      }
      return done(...r);
    });
  };
}

/** Rewrites Socket#connect arguments so the connection resolves through the guarded lookup. */
function withGuardedLookup(args: unknown[], declared: string): unknown[] {
  const a0 = args[0];
  if (Array.isArray(a0) && a0[0] !== null && typeof a0[0] === "object") {
    // already normalised by net.createConnection: keep the marker symbols
    const opts = { ...(a0[0] as Bag) };
    opts.lookup = guardLookup(opts.lookup as LookupFn | undefined, declared);
    const n = [opts, ...a0.slice(1)] as unknown[] & Bag;
    for (const sym of Object.getOwnPropertySymbols(a0)) (n as unknown as Record<symbol, unknown>)[sym] = (a0 as unknown as Record<symbol, unknown>)[sym];
    return [n, ...args.slice(1)];
  }
  if (a0 !== null && typeof a0 === "object") {
    const opts = { ...(a0 as Bag) };
    opts.lookup = guardLookup(opts.lookup as LookupFn | undefined, declared);
    return [opts, ...args.slice(1)];
  }
  // (port[, host][, cb]) form
  const rest = args.slice(1);
  const host = typeof rest[0] === "string" ? (rest.shift() as string) : undefined;
  return [{ port: a0, ...(host !== undefined ? { host } : {}), lookup: guardLookup(undefined, declared) }, ...rest];
}

/** Last line of defence: the address a socket is actually dialling or connected to. */
function watchSocket(socket: net.Socket, declared: string): void {
  socket.on("connectionAttempt", (ip: string) => {
    const refusal = checkResolved("net.connectionAttempt", declared, ip);
    if (refusal) socket.destroy(refusal);
  });
  socket.on("connect", () => {
    const refusal = checkResolved("net.remoteAddress", declared, socket.remoteAddress);
    if (refusal) socket.destroy(refusal);
  });
}

/** net.connect argument normalisation (same rules as Node): returns the host, or null for a local IPC path. */
function netTarget(args: unknown[]): string | null | undefined {
  const a0 = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (a0 !== null && typeof a0 === "object") {
    const o = a0 as { path?: unknown; host?: unknown; port?: unknown };
    if (typeof o.path === "string" && o.path.length > 0 && o.port === undefined) return null;
    return typeof o.host === "string" ? o.host : undefined;
  }
  if (typeof a0 === "string" && Number.isNaN(Number(a0))) return null; // a pipe name
  return typeof args[1] === "string" ? args[1] : undefined;
}

function urlHost(input: unknown): string | null | undefined {
  try {
    if (input instanceof URL) return input.hostname;
    if (typeof input === "string") return new URL(input).hostname;
    if (input && typeof input === "object" && "url" in input && typeof (input as { url: unknown }).url === "string") {
      return new URL((input as { url: string }).url).hostname;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** http(s).request(url | options, options?, cb?) → host, or null for a socketPath. */
function httpTarget(args: unknown[]): string | null | undefined {
  const [a0, a1] = args;
  let host: string | null | undefined;
  if (typeof a0 === "string" || a0 instanceof URL) {
    host = urlHost(a0);
    if (a1 !== null && typeof a1 === "object") {
      const o = a1 as { hostname?: unknown; host?: unknown; socketPath?: unknown };
      if (typeof o.socketPath === "string") return null;
      if (typeof o.hostname === "string") host = o.hostname;
      else if (typeof o.host === "string") host = o.host;
    }
    return host;
  }
  if (a0 !== null && typeof a0 === "object") {
    const o = a0 as { hostname?: unknown; host?: unknown; socketPath?: unknown };
    if (typeof o.socketPath === "string") return null;
    if (typeof o.hostname === "string") return o.hostname;
    if (typeof o.host === "string") return o.host;
  }
  return undefined;
}

function patch(obj: unknown, key: string, make: (orig: AnyFn) => AnyFn): void {
  const target = obj as Bag;
  const orig = target[key];
  if (typeof orig !== "function") return;
  const desc = Object.getOwnPropertyDescriptor(target, key);
  const replacement = make(orig as AnyFn);
  Object.defineProperty(replacement, "name", { value: (orig as AnyFn).name, configurable: true });
  Object.defineProperty(target, key, { ...(desc ?? { configurable: true, enumerable: true, writable: true }), value: replacement });
  state().restore.push(() => {
    if (desc) Object.defineProperty(target, key, desc);
    else delete target[key];
  });
}

const RESOLVE_METHODS = [
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
];

function applyPatches(): void {
  // sockets: the choke point for http, https, tls, http2 and undici (fetch)
  patch(net, "connect", (orig) => function (this: unknown, ...a: unknown[]) {
    const t = netTarget(a);
    if (t !== null) check("net.connect", t);
    return orig.apply(this, a);
  });
  patch(net, "createConnection", (orig) => function (this: unknown, ...a: unknown[]) {
    const t = netTarget(a);
    if (t !== null) check("net.createConnection", t);
    return orig.apply(this, a);
  });
  patch(net.Socket.prototype, "connect", (orig) => function (this: net.Socket, ...a: unknown[]) {
    const t = netTarget(a);
    if (t === null) return orig.apply(this, a);
    check("net.Socket.connect", t);
    const host = t ?? "localhost";
    const result = orig.apply(this, withGuardedLookup(a, host));
    watchSocket(this, host);
    return result;
  });
  // A listening server resolves its own bind address (any local interface, 0.0.0.0, a LAN IP): that is not a destination.
  patch(net.Server.prototype, "listen", (orig) => function (this: unknown, ...a: unknown[]) {
    const st = state();
    st.listening++;
    try {
      return orig.apply(this, a);
    } finally {
      st.listening--;
    }
  });
  patch(tls, "connect", (orig) => function (this: unknown, ...a: unknown[]) {
    const a0 = a[0];
    if (a0 !== null && typeof a0 === "object" && (a0 as { socket?: unknown }).socket) return orig.apply(this, a);
    const t = netTarget(a);
    if (t !== null) check("tls.connect", t);
    return orig.apply(this, a);
  });
  for (const [name, mod] of [["http", http], ["https", https]] as const) {
    for (const fn of ["request", "get"] as const) {
      patch(mod, fn, (orig) => function (this: unknown, ...a: unknown[]) {
        const t = httpTarget(a);
        if (t !== null) check(`${name}.${fn}`, t);
        return orig.apply(this, a);
      });
    }
  }
  patch(http2, "connect", (orig) => function (this: unknown, ...a: unknown[]) {
    check("http2.connect", urlHost(a[0]));
    return orig.apply(this, a);
  });

  // name resolution
  patch(dns, "lookup", (orig) => function (this: unknown, ...a: unknown[]) {
    if (state().listening === 0) check("dns.lookup", a[0]);
    return orig.apply(this, a);
  });
  patch(dns.promises, "lookup", (orig) => async function (this: unknown, ...a: unknown[]) {
    check("dns.promises.lookup", a[0]);
    return orig.apply(this, a);
  });
  patch(dns, "reverse", (orig) => function (this: unknown, ...a: unknown[]) {
    check("dns.reverse", a[0]);
    return orig.apply(this, a);
  });
  patch(dns.promises, "reverse", (orig) => async function (this: unknown, ...a: unknown[]) {
    check("dns.promises.reverse", a[0]);
    return orig.apply(this, a);
  });
  patch(dns, "lookupService", (orig) => function (this: unknown, ...a: unknown[]) {
    check("dns.lookupService", a[0]);
    return orig.apply(this, a);
  });
  patch(dns.promises, "lookupService", (orig) => async function (this: unknown, ...a: unknown[]) {
    check("dns.promises.lookupService", a[0]);
    return orig.apply(this, a);
  });
  for (const m of RESOLVE_METHODS) {
    patch(dns, m, (orig) => function (this: unknown, ...a: unknown[]) {
      check(`dns.${m}`, a[0]);
      return orig.apply(this, a);
    });
    patch(dns.promises, m, (orig) => async function (this: unknown, ...a: unknown[]) {
      check(`dns.promises.${m}`, a[0]);
      return orig.apply(this, a);
    });
    patch(dns.Resolver.prototype, m, (orig) => function (this: unknown, ...a: unknown[]) {
      check(`dns.Resolver.${m}`, a[0]);
      return orig.apply(this, a);
    });
    patch(dns.promises.Resolver.prototype, m, (orig) => async function (this: unknown, ...a: unknown[]) {
      check(`dns.promises.Resolver.${m}`, a[0]);
      return orig.apply(this, a);
    });
  }

  // fetch
  patch(globalThis, "fetch", (orig) => async function (this: unknown, ...a: unknown[]) {
    const input = a[0];
    const host = urlHost(input);
    // data: and blob: URLs have no host and reach nowhere; anything unparseable is left to fail inside fetch itself
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
    const schemeless = href !== undefined && /^(data|blob):/i.test(href);
    if (!schemeless && host !== undefined) check("fetch", host);
    else if (!schemeless && href !== undefined) check("fetch", "unparseable-url");
    return orig.apply(this, a);
  });

  module.syncBuiltinESMExports();
}

function removePatches(): void {
  const s = state();
  for (const undo of s.restore.reverse()) undo();
  s.restore = [];
  module.syncBuiltinESMExports();
}

export function installEgressGuard(options: EgressGuardOptions): EgressGuardHandle {
  const s = state();
  const layer: Layer = { allowlist: [...options.allowlist], mode: options.mode, attempts: [], active: true };
  s.layers.push(layer);
  if (s.layers.length === 1) applyPatches();
  const uninstall = (() => {
    if (!layer.active) return;
    layer.active = false;
    const st = state();
    st.layers = st.layers.filter((l) => l !== layer);
    if (st.layers.length === 0) removePatches();
  }) as EgressGuardHandle;
  uninstall.attempts = layer.attempts;
  return uninstall;
}

/** True while at least one guard layer is installed. */
export function egressGuardInstalled(): boolean {
  return state().layers.length > 0;
}
