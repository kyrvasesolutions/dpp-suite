// @vitest-environment node
/** check-secrets over the build output (D8-06, threat T18): a planted fake key in dist/ or dist-server/ fails the scan. */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Built at runtime so the repository scan never sees a key-shaped literal in this file.
const fakeAnthropic = () => ["sk", "ant", "api03"].join("-") + "-" + "A".repeat(32);
const fakeAws = () => "AKIA" + "ABCDEFGHIJKLMNOP";

function scan(layout: Record<string, string | Buffer>, args: string[], after?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "dpp-secrets-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    for (const [path, body] of Object.entries(layout)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    after?.(dir);
    const r = spawnSync("node", [join(process.cwd(), "scripts/check-secrets.mjs"), "--root", dir, ...args], { encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    try {
      chmodSync(join(dir, "locked.txt"), 0o644);
    } catch {
      /* not there */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("check-secrets scans the build output", () => {
  it("fails on a key planted in dist/ (git-ignored build output), and never prints the key", () => {
    const key = fakeAnthropic();
    const r = scan({ ".gitignore": "dist/\ndist-server/\n", "src.txt": "clean", "dist/assets/index.js": `var k="${key}";` }, []);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/dist\/assets\/index\.js:1: Anthropic API key/);
    expect(r.out).not.toContain(key);
  });

  it("fails on a key planted in dist-server/", () => {
    const r = scan({ ".gitignore": "dist-server/\n", "dist-server/server.mjs": `const a="${fakeAws()}";` }, []);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/dist-server\/server\.mjs:1: AWS access key ID/);
  });

  it("--build scans only the build output, and requires it to exist", () => {
    const planted = scan({ "dist/a.js": `x="${fakeAnthropic()}"` }, ["--build"]);
    expect(planted.code).toBe(1);
    const clean = scan({ "dist/a.js": "console.log(1)" }, ["--build"]);
    expect(clean.code).toBe(0);
    const missing = scan({ "a.txt": "x" }, ["--build"]);
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/build first/);
  });

  it("passes when the build output is clean", () => {
    const r = scan({ "a.txt": "x", "dist/index.html": "<html></html>" }, []);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/including dist/);
  });
});

// All built at runtime from parts, so this file holds no key-shaped literal.
const b64u = (n: number, c = "A") => c.repeat(n);
const fakeJwt = () => ["eyJ" + b64u(20, "h"), b64u(24, "p"), b64u(24, "s")].join(".");
const fakeGoogle = () => "AIza" + b64u(35, "B");
const fakeNpm = () => "npm_" + b64u(36, "C");
const fakeSlack = () => ["xox", "b"].join("") + "-" + b64u(24, "1");

describe("check-secrets: more kinds of secret", () => {
  it.each([
    ["JSON Web Token", fakeJwt()],
    ["Google API key", fakeGoogle()],
    ["npm token", fakeNpm()],
    ["Slack token", fakeSlack()],
  ])("finds a %s in a tracked file and a built file, never printing it", (kind, secret) => {
    const r = scan({ "notes.txt": `a\nvalue=${secret}\n`, "dist/a.js": `x="${secret}"` }, []);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`notes.txt:2: ${kind}`);
    expect(r.out).toContain(`dist/a.js:1: ${kind}`);
    expect(r.out).not.toContain(secret);
  });

  it("does not flag look-alikes: a short eyJ string, a header and payload without a signature, an npm_ word", () => {
    const r = scan({ "a.txt": `eyJabc.def.ghi\n${"eyJ" + b64u(20, "h")}.${b64u(24, "p")}\nnpm_install npm_config AIzaShort xox-none\n` }, []);
    expect(r.code).toBe(0);
  });

  it.each(["prod.env", "staging.env", ".env", ".env.local", ".env.production"])("fails on a committed environment file named %s", (name) => {
    const r = scan({ [name]: "A=1\n" }, []);
    expect(r.code).toBe(1);
    expect(r.out).toContain("an environment file must not be committed");
  });

  it.each(["env.example", ".env.example", "prod.env.example", ".env.sample", "prod.env.template", "environment.ts"])("allows the template or unrelated name %s", (name) => {
    expect(scan({ [name]: "A=1\n" }, []).code).toBe(0);
  });
});

describe("check-secrets: nothing is silently skipped", () => {
  it("finds a key in a file larger than the old 5 MB limit, and one that straddles a chunk boundary", () => {
    const key = fakeAnthropic();
    const big = Buffer.concat([Buffer.alloc(6 * 1024 * 1024, "x"), Buffer.from(`\n${key}\n`)]);
    const r1 = scan({ "big.txt": big }, []);
    expect(r1.code).toBe(1);
    expect(r1.out).toMatch(/big\.txt:2: Anthropic API key/);
    // the 4 MiB chunk edge falls inside the key
    const edge = Buffer.concat([Buffer.alloc(4 * 1024 * 1024 - 20, "y"), Buffer.from(key), Buffer.alloc(100, "z")]);
    const r2 = scan({ "edge.txt": edge }, []);
    expect(r2.code).toBe(1);
    expect(r2.out).toMatch(/edge\.txt:1: Anthropic API key/);
    expect(r2.out.match(/Anthropic API key/g)).toHaveLength(1); // reported once, not once per chunk
  });

  it("a file with NUL bytes is scanned unless its extension is on the binary list", () => {
    const body = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(fakeAnthropic())]);
    expect(scan({ "data.txt": body }, []).code).toBe(1);
    expect(scan({ "data.bin2": body }, []).code).toBe(1);
    expect(scan({ "image.png": body }, []).code).toBe(0);
    expect(scan({ "x.sqlite": body }, []).code).toBe(0);
    expect(scan({ "font.woff2": body }, []).code).toBe(0);
  });

  it("a file that cannot be read fails the scan", () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const r = scan({ "locked.txt": "fine" }, [], (dir) => chmodSync(join(dir, "locked.txt"), 0o000));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/locked\.txt: cannot be read/);
  });
});
