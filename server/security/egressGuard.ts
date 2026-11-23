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
}

const KEY = Symbol.for("dpp.egressGuard.state");
const g = globalThis as unknown as Record<symbol, State | undefined>;
const state = (): State => (g[KEY] ??= { layers: [], restore: [] });

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

/** net.connect argument normalisation (same rules as Node): returns the host, or null for a local IPC path. */
function netTarget(args: unknown[]): string | null | undefined {
  const a0 = args[0];
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
  patch(net.Socket.prototype, "connect", (orig) => function (this: unknown, ...a: unknown[]) {
    const t = netTarget(a);
    if (t !== null) check("net.Socket.connect", t);
    return orig.apply(this, a);
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
    check("dns.lookup", a[0]);
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
