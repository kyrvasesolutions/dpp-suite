/**
 * Cycle 8 Layer 3 helper: the built server bundle (`server.mjs` plus its ingress worker) in a child process, so memory is the
 * server's own and not the test runner's. The bundle is built into a temp directory with the real server build config.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestIdp } from "./oidc";

export interface Child {
  baseUrl: string;
  port: number;
  pid: number;
  token(sub: string): string;
  /** Resident set size of the server process, bytes. */
  rss(): number;
  stop(): Promise<void>;
  log(): string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function buildBundle(outDir: string): Promise<void> {
  const viteName = "vite";
  const { build } = (await import(/* @vite-ignore */ viteName)) as typeof import("vite");
  await build({ configFile: join(process.cwd(), "vite.server.config.ts"), logLevel: "silent", build: { outDir, emptyOutDir: true } });
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
}

export async function startChild(options: { admin: string; users: Array<{ sub: string; roles: string[] }>; extraAdmins?: Array<{ sub: string; domain: string }>; env?: Record<string, string> }): Promise<Child> {
  const dir = mkdtempSync(join(tmpdir(), "dpp-c8-child-"));
  // built inside the repository tree, so the bundle resolves its external packages (zod, yaml, pdf-lib) from node_modules
  const cache = join(process.cwd(), "node_modules/.cache/dpp-c8-child");
  mkdirSync(cache, { recursive: true });
  const bundleDir = mkdtempSync(join(cache, "b-"));
  await buildBundle(bundleDir);
  const bundle = join(bundleDir, "server.mjs");
  const idp = createTestIdp();
  const jwks = join(dir, "jwks.json");
  writeFileSync(jwks, JSON.stringify(idp.jwks));
  const env = {
    ...process.env,
    DPP_DB_PATH: join(dir, "c.sqlite"),
    DPP_SERVER_HOST: "127.0.0.1",
    DPP_AUTH_MODE: "oidc",
    DPP_OIDC_ISSUER: idp.issuer,
    DPP_OIDC_AUDIENCE: idp.audience,
    DPP_OIDC_JWKS_PATH: jwks,
    DPP_STATIC_DIR: join(dir, "none"),
    ...(options.env ?? {}),
  };
  const cwd = process.cwd();
  execFileSync(process.execPath, [bundle, "--bootstrap-admin", options.admin, "Admin", "--reason", "child"], { cwd, env, stdio: "pipe" });
  for (const a of options.extraAdmins ?? []) {
    execFileSync(process.execPath, [bundle, "--bootstrap-admin", a.sub, "Admin", "--domain", a.domain, "--reason", "child"], { cwd, env, stdio: "pipe" });
  }
  const port = await freePort();
  const proc: ChildProcess = spawn(process.execPath, [bundle], { cwd, env: { ...env, DPP_SERVER_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout!.on("data", (d) => (log += d));
  proc.stderr!.on("data", (d) => (log += d));
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).status === 200) break;
    } catch {
      /* not up yet */
    }
    if (proc.exitCode !== null || i > 300) throw new Error(`the child server did not start:\n${log}`);
    await sleep(50);
  }
  const token = (sub: string) => {
    const now = Math.floor(Date.now() / 1000);
    return idp.signRs256({ sub, iat: now - 30, exp: now + 3600 });
  };
  for (const u of options.users) {
    const r = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(options.admin)}` },
      body: JSON.stringify({ sub: u.sub, displayName: u.sub, roles: u.roles, reason: "child" }),
    });
    if (r.status !== 200) throw new Error(`could not provision ${u.sub}: ${r.status}`);
  }
  return {
    baseUrl,
    port,
    pid: proc.pid!,
    token,
    rss: () => Number(execFileSync("ps", ["-o", "rss=", "-p", String(proc.pid)], { encoding: "utf8" }).trim()) * 1024,
    stop: async () => {
      proc.kill("SIGTERM");
      await sleep(150);
      rmSync(dir, { recursive: true, force: true });
      rmSync(bundleDir, { recursive: true, force: true });
    },
    log: () => log,
  };
}
