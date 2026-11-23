// @vitest-environment node
/** check-secrets over the build output (D8-06, threat T18): a planted fake key in dist/ or dist-server/ fails the scan. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Built at runtime so the repository scan never sees a key-shaped literal in this file.
const fakeAnthropic = () => ["sk", "ant", "api03"].join("-") + "-" + "A".repeat(32);
const fakeAws = () => "AKIA" + "ABCDEFGHIJKLMNOP";

function scan(layout: Record<string, string>, args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "dpp-secrets-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    for (const [path, body] of Object.entries(layout)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    const r = spawnSync("node", [join(process.cwd(), "scripts/check-secrets.mjs"), "--root", dir, ...args], { encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
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
