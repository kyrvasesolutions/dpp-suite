// @vitest-environment node
/**
 * Cycle 8: the runtime egress guard (D8-05, LEAN-DEF-13, threat T10). Every network entry point refuses a non-loopback
 * destination (names, IPs, IPv4-mapped IPv6, 0.0.0.0, metadata addresses), loopback still works, and the guard is layered
 * and reversible. Refusal happens before any I/O, so nothing here leaves the machine.
 */
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import allow from "../../config/egress-allowlist.json";
import { allowlistHosts, egressGuardInstalled, EgressRefusedError, installEgressGuard, type EgressGuardHandle } from "../../server/security/egressGuard";
import { MONITOR_KEY } from "../support/noEgress";
import { SqliteAdapter } from "../../server/db/adapter";
import { migrateUp } from "../../server/db/migrations";
import { createDppServer } from "../../server/http/api";
import { PolicyStore } from "../../server/store/policyStore";
import { createTestIdp } from "../support/oidc";
import { loadPack } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const HOSTS = ["example.com", "8.8.8.8", "::ffff:8.8.8.8", "0.0.0.0", "169.254.169.254", "2001:4860:4860::8888", "::"];
const inUrl = (h: string) => (h.includes(":") ? `[${h}]` : h);

let guard: EgressGuardHandle;
beforeAll(() => {
  guard = installEgressGuard({ allowlist: [], mode: "refuse" });
});
afterAll(() => guard());

const refusedSync = (fn: () => unknown) => {
  let error: unknown;
  try {
    const r = fn();
    if (r && typeof (r as { destroy?: () => void }).destroy === "function") (r as { destroy: () => void }).destroy();
  } catch (e) {
    error = e;
  }
  expect(error, "expected an EgressRefusedError").toBeInstanceOf(EgressRefusedError);
};
const refusedAsync = async (fn: () => unknown) => {
  await expect(Promise.resolve().then(fn)).rejects.toBeInstanceOf(EgressRefusedError);
};
const noop = () => undefined;

describe("every network API refuses an external destination", () => {
  describe.each(HOSTS)("host %s", (h) => {
    const u = inUrl(h);
    it("net", () => {
      refusedSync(() => net.connect({ host: h, port: 80 }));
      refusedSync(() => net.connect(80, h));
      refusedSync(() => net.createConnection({ host: h, port: 80 }));
      refusedSync(() => net.createConnection(80, h));
      refusedSync(() => new net.Socket().connect({ host: h, port: 80 }));
      refusedSync(() => new net.Socket().connect(80, h));
    });
    it("tls", () => {
      refusedSync(() => tls.connect({ host: h, port: 443 }));
      refusedSync(() => tls.connect(443, h));
    });
    it("http and https", () => {
      refusedSync(() => http.request({ hostname: h }));
      refusedSync(() => http.request({ host: h, port: 80 }));
      refusedSync(() => http.get(`http://${u}/`));
      refusedSync(() => http.get(new URL(`http://${u}/`)));
      refusedSync(() => http.request(`http://${u}/`, { method: "POST" }));
      refusedSync(() => https.request({ hostname: h }));
      refusedSync(() => https.get(`https://${u}/`));
      refusedSync(() => https.get(new URL(`https://${u}/`), { timeout: 10 }));
    });
    it("http2", () => {
      refusedSync(() => http2.connect(`http://${u}`));
    });
    it("dns callbacks", () => {
      refusedSync(() => dns.lookup(h, noop));
      refusedSync(() => dns.lookup(h, { all: true }, noop));
      refusedSync(() => dns.resolve(h, noop));
      for (const m of ["resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveNs", "resolveTxt", "resolveSrv", "resolveSoa", "resolvePtr", "resolveCaa", "resolveNaptr"] as const) {
        refusedSync(() => (dns[m] as unknown as (h: string, cb: () => void) => void)(h, noop));
      }
      refusedSync(() => dns.reverse(h, noop));
      refusedSync(() => dns.lookupService(h, 80, noop));
      refusedSync(() => new dns.Resolver().resolve4(h, noop));
    });
    it("dns promises", async () => {
      await refusedAsync(() => dns.promises.lookup(h));
      await refusedAsync(() => dns.promises.resolve(h));
      await refusedAsync(() => dns.promises.resolve4(h));
      await refusedAsync(() => dns.promises.resolveTxt(h));
      await refusedAsync(() => dns.promises.reverse(h));
      await refusedAsync(() => new dns.promises.Resolver().resolve6(h));
    });
    it("fetch", async () => {
      await refusedAsync(() => fetch(`http://${u}/`));
      await refusedAsync(() => fetch(new URL(`https://${u}/x`)));
      await refusedAsync(() => fetch(new Request(`http://${u}/`)));
      await refusedAsync(() => fetch(`http://user:pw@${u}:8080/`, { method: "POST", body: "x" }));
    });
  });

  it("refuses spellings of an address that are not strict loopback", () => {
    for (const h of ["127.1.", "0x7f.1", "2130706433", "localhost.example.com", "Ｌocalhost", "10.0.0.1", "192.168.1.1", "172.16.0.1", "fe80::1"]) {
      refusedSync(() => net.connect({ host: h, port: 80 }));
    }
  });

  it("an error carries the API and host, a stable code, and is not a network error", () => {
    try {
      net.connect({ host: "example.com", port: 80 });
      expect.unreachable();
    } catch (e) {
      const err = e as EgressRefusedError;
      expect(err.code).toBe("EGRESS_REFUSED");
      expect(err.api).toBe("net.connect");
      expect(err.host).toBe("example.com");
    }
  });
});

describe("loopback still works", () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end("hello"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("http, fetch, net and dns reach 127.0.0.1 and localhost", async () => {
    const viaHttp = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      }).on("error", reject);
    });
    expect(viaHttp).toBe("hello");
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("hello");
    await new Promise<void>((resolve, reject) => {
      const s = net.connect({ host: "127.0.0.1", port }, () => {
        s.destroy();
        resolve();
      });
      s.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => dns.lookup("localhost", (e) => (e ? reject(e) : resolve())));
    await expect(dns.promises.lookup("127.0.0.1")).resolves.toBeTruthy();
    expect((await fetch("data:text/plain,hi")).status).toBe(200);
  });

  it("a unix socket path is local and is not refused by the guard", () => {
    const s = net.connect({ path: "/tmp/dpp-egress-test-no-such.sock" });
    s.on("error", noop);
    s.destroy();
  });
});

describe("allow-list and record mode (through a local server, so nothing leaves the machine)", () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  // A custom lookup sends the made-up name to loopback; the guard still sees the name.
  const toLoopback = ((_h: string, o: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
    o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as never;
  const get = (host: string) =>
    new Promise<string>((resolve, reject) => {
      http.get({ hostname: host, port, lookup: toLoopback }, (res) => {
        res.resume();
        res.on("end", () => resolve("done"));
      }).on("error", reject);
    });

  it("a host in the allow-list is let through; the same host is refused without it", async () => {
    const allowed = installEgressGuard({ allowlist: ["allowed.example"], mode: "refuse" });
    try {
      await expect(get("allowed.example")).resolves.toBe("done");
      expect(allowed.attempts).toEqual([]);
      await expect(get("other.example")).rejects.toBeInstanceOf(EgressRefusedError);
      expect(allowed.attempts.length).toBe(1);
    } finally {
      allowed();
    }
  });

  it("record mode records the attempt and lets it proceed", async () => {
    const rec = installEgressGuard({ allowlist: [], mode: "record" });
    try {
      await expect(get("recorded.example")).resolves.toBe("done");
      const apis = rec.attempts.map((a) => a.host);
      expect(apis).toContain("recorded.example");
    } finally {
      rec();
    }
  });

  it("the shipped allow-list is empty (N allows no egress)", () => {
    expect(allow.connect).toEqual([]);
    expect(allowlistHosts(["https://api.example.org:8443/path", "not a url", "http://[2001:db8::1]/"])).toEqual(["api.example.org", "2001:db8::1"]);
  });
});

describe("installation is layered, idempotent and reversible", () => {
  it("a second install does not wrap again, and uninstall twice is harmless", () => {
    const before = [net.connect, http.request, dns.lookup, globalThis.fetch, net.Socket.prototype.connect];
    const second = installEgressGuard({ allowlist: [], mode: "refuse" });
    expect([net.connect, http.request, dns.lookup, globalThis.fetch, net.Socket.prototype.connect]).toEqual(before);
    second();
    second();
    expect([net.connect, http.request, dns.lookup, globalThis.fetch, net.Socket.prototype.connect]).toEqual(before);
    expect(egressGuardInstalled()).toBe(true);
    refusedSync(() => net.connect({ host: "example.com", port: 80 })); // the outer layer still guards
  });

  it("removing the last layer restores every original function", () => {
    const monitor = (globalThis as unknown as Record<symbol, EgressGuardHandle>)[MONITOR_KEY];
    expect(monitor, "the no-egress monitor is installed in node files").toBeTypeOf("function");
    guard();
    monitor();
    try {
      expect(egressGuardInstalled()).toBe(false);
      const natives = [net.connect, tls.connect, http.request, https.get, dns.lookup, dns.promises.lookup, dns.resolve4, globalThis.fetch];
      const h = installEgressGuard({ allowlist: [], mode: "refuse" });
      expect(egressGuardInstalled()).toBe(true);
      expect(net.connect).not.toBe(natives[0]);
      expect(globalThis.fetch).not.toBe(natives[7]);
      h();
      expect(egressGuardInstalled()).toBe(false);
      expect([net.connect, tls.connect, http.request, https.get, dns.lookup, dns.promises.lookup, dns.resolve4, globalThis.fetch]).toEqual(natives);
    } finally {
      // put the monitor and this file's own refuse layer back for the remaining tests and the afterAll hooks
      (globalThis as unknown as Record<symbol, EgressGuardHandle>)[MONITOR_KEY] = installEgressGuard({ allowlist: [], mode: "record" });
      guard = installEgressGuard({ allowlist: [], mode: "refuse" });
    }
  });
});

describe("listening on any local interface still works under the guard (F2)", () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  const hosts = ["0.0.0.0", "127.0.0.1", "localhost", "::", ...(lan ? [lan] : [])];

  it.each(hosts)("a plain server listens on %s and answers over loopback", async (host) => {
    const server = http.createServer((_q, r) => r.end("up"));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, resolve);
      });
      const { port } = server.address() as AddressInfo;
      expect(port).toBeGreaterThan(0);
      // a LAN address is not reachable from here without an outbound connection (which the guard refuses): listening is the proof
      if (host !== lan) expect(await (await fetch(`http://${host === "localhost" ? "localhost" : "127.0.0.1"}:${port}/`)).text()).toBe("up");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("F6: only the lookup of the exact bind host is skipped: listening on a name that is not an IP literal or localhost is still checked", () => {
    const server = http.createServer();
    refusedSync(() => server.listen(0, "example.com"));
    refusedSync(() => server.listen({ port: 0, host: "metadata.internal.example" }));
    expect(server.listening).toBe(false);
  });

  it("the DPP server in OIDC mode starts on 0.0.0.0 with the guard in refuse mode, and health is 200 over 127.0.0.1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dpp-egress-listen-"));
    const pack = await loadPack();
    const db = new SqliteAdapter({ path: join(dir, "l.sqlite") });
    migrateUp(db);
    new PolicyStore(db).activate(pack.policy.retention);
    const idp = createTestIdp();
    const server = createDppServer({ db, pack, software: TEST_SOFTWARE, authMode: "oidc", oidc: idp.oidcConfig, host: "0.0.0.0" });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "0.0.0.0", resolve);
      });
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(200);
      // outbound is still refused while the server is up
      refusedSync(() => net.connect({ host: "example.com", port: 80 }));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the resolved address is checked, not only the host name (F1)", () => {
  const LAN = "10.255.255.1";
  /** A custom lookup that points any name at an address. Asynchronous, so a test can destroy the socket before it is used. */
  const pointTo = (address: string) =>
    ((_h: string, o: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
      process.nextTick(() => (o?.all ? cb(null, [{ address, family: address.includes(":") ? 6 : 4 }]) : cb(null, address, address.includes(":") ? 6 : 4)))) as never;
  const error = (emitter: { once(e: "error", f: (x: unknown) => void): unknown }) => new Promise<unknown>((resolve) => emitter.once("error", resolve));

  it.each([LAN, "192.168.1.5", "169.254.169.254", "8.8.8.8", "0.0.0.0", "::ffff:10.0.0.1", "fe80::1", "2001:4860:4860::8888"])("refuse: net.connect to localhost resolved to %s fails closed", async (addr) => {
    const s = net.connect({ host: "localhost", port: 9, lookup: pointTo(addr) });
    expect(await error(s)).toBeInstanceOf(EgressRefusedError);
    const s2 = new net.Socket().connect({ host: "localhost", port: 9, lookup: pointTo(addr) });
    expect(await error(s2)).toBeInstanceOf(EgressRefusedError);
  });

  it("refuse: http.get and http.request with a custom lookup to a LAN address fail closed", async () => {
    const req = http.get({ host: "localhost", port: 9, lookup: pointTo(LAN) });
    expect(await error(req)).toBeInstanceOf(EgressRefusedError);
    const req2 = http.request({ hostname: "localhost", port: 9, lookup: pointTo(LAN), agent: false });
    req2.end();
    expect(await error(req2)).toBeInstanceOf(EgressRefusedError);
    const req3 = https.get({ host: "localhost", port: 9, lookup: pointTo(LAN) });
    expect(await error(req3)).toBeInstanceOf(EgressRefusedError);
  });

  it("refuse: tls.connect with a custom lookup to a LAN address fails closed", async () => {
    const s = tls.connect({ host: "localhost", port: 9, lookup: pointTo(LAN) });
    expect(await error(s)).toBeInstanceOf(EgressRefusedError);
  });

  it("refuse: a lookup that returns several addresses is refused when any one is external", async () => {
    const mixed = ((_h: string, _o: unknown, cb: (e: null, a: unknown) => void) => process.nextTick(() => cb(null, [{ address: "127.0.0.1", family: 4 }, { address: LAN, family: 4 }]))) as never;
    const s = net.connect({ host: "localhost", port: 9, lookup: mixed });
    expect(await error(s)).toBeInstanceOf(EgressRefusedError);
  });

  it("a loopback answer from a custom lookup is fine, and an allow-listed name may resolve anywhere", async () => {
    const server = net.createServer((c) => c.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const s = net.connect({ host: "localhost", port, lookup: pointTo("127.0.0.1") }, () => {
        s.destroy();
        resolve();
      });
      s.on("error", reject);
    });
    await new Promise<void>((r) => server.close(() => r()));
    const allowed = installEgressGuard({ allowlist: ["allowed.example"], mode: "refuse" });
    try {
      const s = net.connect({ host: "allowed.example", port: 9, lookup: pointTo(LAN) });
      s.on("error", () => undefined);
      s.destroy(); // before the lookup answers: nothing is sent
      await new Promise((r) => setTimeout(r, 20));
      expect(allowed.attempts).toEqual([]);
    } finally {
      allowed();
    }
  });

  it("record mode (the Vitest monitor): the dialled address is recorded; the socket is destroyed before it can connect", async () => {
    const rec = installEgressGuard({ allowlist: [], mode: "record" });
    try {
      const s = net.connect({ host: "localhost", port: 9, lookup: pointTo(LAN) });
      s.on("error", () => undefined);
      s.destroy();
      const req = http.get({ host: "localhost", port: 9, lookup: pointTo("192.168.7.7") });
      req.on("error", () => undefined);
      req.destroy();
      await new Promise((r) => setTimeout(r, 30));
      const hosts = rec.attempts.map((a) => a.host);
      expect(hosts).toContain(LAN);
      expect(hosts).toContain("192.168.7.7");
      expect(rec.attempts.every((a) => a.api.startsWith("net."))).toBe(true);
    } finally {
      rec();
    }
  });
});
