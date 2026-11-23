// @vitest-environment node
/**
 * Packaging, configuration and dependencies (Cycle 5): exact pins, one Node version, the configuration example, the secret
 * scan and the licence audit with negative controls, and the CI steps that run them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const pkg = json("package.json") as { dependencies: Record<string, string>; devDependencies: Record<string, string>; engines: { node: string }; scripts: Record<string, string> };
const lock = json("package-lock.json") as { packages: Record<string, { version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> };

describe("exact pins", () => {
  const all = { ...pkg.dependencies, ...pkg.devDependencies };

  it("pins every dependency to one exact version, no range", () => {
    for (const [name, range] of Object.entries(all)) expect(range, name).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it("agrees with the lockfile: the same specifiers at its root, and the resolved version of each is the pinned one", () => {
    const root = lock.packages[""];
    expect(root.dependencies).toEqual(pkg.dependencies);
    expect(root.devDependencies).toEqual(pkg.devDependencies);
    for (const [name, version] of Object.entries(all)) expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
  });
});

describe("one Node version", () => {
  it("is 24 in .nvmrc, in the engines field and in every workflow", () => {
    expect(readFileSync(".nvmrc", "utf8").trim()).toBe("24");
    expect(pkg.engines.node).toMatch(/^>=24\b/);
    for (const wf of readdirSync(".github/workflows")) expect(readFileSync(`.github/workflows/${wf}`, "utf8"), wf).toMatch(/node-version: 24\b/);
  });

  it("serves the build on port 4173 with `npm run serve`", () => {
    expect(pkg.scripts.serve).toMatch(/vite preview .*--port 4173/);
  });
});

describe("configuration example", () => {
  const example = readFileSync("config/env.example", "utf8");
  const assignments = Object.fromEntries(
    example
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]),
  );

  it("names the configuration points and holds no secret value", () => {
    expect(Object.keys(assignments).sort()).toEqual([
      "BASE_PATH",
      "DPP_ALLOWED_ORIGIN",
      "DPP_AUTH_MODE",
      "DPP_CONTRACT_PACK",
      "DPP_DB_PATH",
      "DPP_DEPLOYMENT_SURFACE",
      "DPP_FIXTURE_PACK",
      "DPP_OIDC_AUDIENCE",
      "DPP_OIDC_ISSUER",
      "DPP_OIDC_JWKS_PATH",
      "DPP_SERVER_HOST",
      "DPP_SERVER_PORT",
      "DPP_STATIC_DIR",
      "VITE_API_BASE",
      "VITE_ENABLE_LLM",
    ]);
    expect(assignments.VITE_ENABLE_LLM).toBe("false");
    expect(assignments.DPP_CONTRACT_PACK).toBe("");
    expect(assignments.DPP_FIXTURE_PACK).toBe("");
    expect(assignments.BASE_PATH).toBe("/");
    expect(assignments.VITE_API_BASE).toBe("");
    expect(assignments.DPP_DB_PATH).toBe("data/dpp.sqlite");
    expect(assignments.DPP_SERVER_PORT).toBe("4174");
    expect(assignments.DPP_SERVER_HOST).toBe("127.0.0.1");
    expect(assignments.DPP_ALLOWED_ORIGIN).toBe("");
    expect(assignments.DPP_STATIC_DIR).toBe("");
    expect(assignments.DPP_AUTH_MODE).toBe("local-dev");
    expect(assignments.DPP_DEPLOYMENT_SURFACE).toBe("all");
    expect(assignments.DPP_OIDC_ISSUER).toBe("");
    expect(assignments.DPP_OIDC_AUDIENCE).toBe("");
    expect(assignments.DPP_OIDC_JWKS_PATH).toBe("");
  });

  it("is a template the secret scan allows", () => {
    expect(existsSync("config/env.example")).toBe(true);
    expect(spawnSync("node", ["scripts/check-secrets.mjs"], { encoding: "utf8" }).status).toBe(0);
  });
});

/** A throwaway git repository with the given files, so the scan is run against content a test controls. */
function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "dpp-secrets-"));
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  git("add", "-A");
  return dir;
}
const scan = (dir: string) => {
  const r = spawnSync("node", [join(process.cwd(), "scripts/check-secrets.mjs"), "--root", dir], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

// Built at run time, so this file does not itself look like it holds a key.
const fake = {
  anthropic: ["sk", "ant", "api03", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("-"),
  github: ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_"),
  aws: ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
  key: ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "),
};

describe("secret scan", () => {
  it("passes a clean repository and the real one", () => {
    const dir = repo({ "a.txt": "nothing here\n", "config/env.example": "VITE_ENABLE_LLM=false\n", ".env.example": "KEY=\n" });
    try {
      expect(scan(dir)).toMatchObject({ status: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(Object.entries(fake))("fails on a planted %s secret, naming file and line but never the secret", (_kind, secret) => {
    const dir = repo({ "src/ok.ts": "const a = 1;\n", "src/leak.ts": `const k = "${secret}";\n` });
    try {
      const r = scan(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain("src/leak.ts:1");
      expect(r.out).not.toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([".env", ".env.local", "config/.env.production"])("fails on a committed %s file", (name) => {
    const dir = repo({ [name]: "A=1\n" });
    try {
      const r = scan(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain(name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("also reads a new file that is not committed yet, but not an ignored one", () => {
    const dir = repo({ ".gitignore": "ignored.txt\n", "ignored.txt": `${fake.github}\n`, "new.txt": `${fake.aws}\n` });
    try {
      const r = scan(dir);
      expect(r.out).toContain("new.txt:1");
      expect(r.out).not.toContain("ignored.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a CI step", () => {
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toMatch(/npm run check-secrets/);
  });
});

/** A throwaway project with an installed dependency tree whose licences a test controls. */
function project(packages: Record<string, { license?: unknown; licenses?: unknown; dependencies?: Record<string, string> }>, direct: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "dpp-licences-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", dependencies: Object.fromEntries(direct.map((d) => [d, "1.0.0"])) }));
  for (const [name, body] of Object.entries(packages)) {
    mkdirSync(join(dir, "node_modules", name), { recursive: true });
    writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.0.0", ...body }));
  }
  return dir;
}
const audit = (dir: string) => {
  const r = spawnSync("node", [join(process.cwd(), "scripts/check-licences.mjs"), "--root", dir], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

describe("licence audit", () => {
  it("passes every licence on the allow-list, SPDX alternatives and the legacy fields included", () => {
    const dir = project(
      {
        a: { license: "MIT" },
        b: { license: "(MIT OR GPL-3.0-only)" },
        c: { license: { type: "BSD-3-Clause" } },
        d: { licenses: [{ type: "Apache-2.0" }] },
        e: { license: "0BSD" },
        f: { license: "OFL-1.1" },
        g: { license: "CC0-1.0" },
        h: { license: "BlueOak-1.0.0" },
        i: { license: "ISC" },
        j: { license: "BSD-2-Clause" },
      },
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
    );
    try {
      expect(audit(dir)).toMatchObject({ status: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["GPL-3.0-only", "GPL-3.0-only"],
    ["AGPL-3.0-or-later", "AGPL-3.0-or-later"],
    ["a custom text", "SEE LICENSE IN LICENSE.md"],
    ["an AND with one part off the list", "(MIT AND GPL-2.0-only)"],
    ["no licence stated", undefined],
  ])("fails a dependency with %s", (_, license) => {
    const dir = project({ a: { license } }, ["a"]);
    try {
      const r = audit(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain("a@1.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads dependencies of dependencies, from a nested node_modules too", () => {
    const dir = project({ a: { license: "MIT", dependencies: { b: "1.0.0" } }, b: { license: "MIT", dependencies: { c: "1.0.0" } } }, ["a"]);
    mkdirSync(join(dir, "node_modules/b/node_modules/c"), { recursive: true });
    writeFileSync(join(dir, "node_modules/b/node_modules/c/package.json"), JSON.stringify({ name: "c", version: "9.9.9", license: "GPL-3.0-only" }));
    try {
      const r = audit(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain("c@9.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not audit a development dependency", () => {
    const dir = project({ a: { license: "MIT" }, dev: { license: "GPL-3.0-only" } }, ["a"]);
    try {
      expect(audit(dir)).toMatchObject({ status: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a dependency that is not installed", () => {
    const dir = project({}, ["absent"]);
    try {
      expect(audit(dir).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the real production dependencies, with pdf-lib among them as MIT, and keeps the allow-list as agreed", () => {
    const r = spawnSync("node", ["scripts/check-licences.mjs"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/pdf-lib@1\.17\.1\s+MIT/);
    expect(r.stdout).toContain("allow-list MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, OFL-1.1, CC0-1.0, BlueOak-1.0.0");
  });

  it("is a CI step, and the dependency audit is a gating step (D8-06: check-audit, no continue-on-error)", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toMatch(/npm run check-licences/);
    expect(ci).toMatch(/- name: Dependency audit gate[^\n]*\n\s+run: npm run check-audit/);
    expect(ci).not.toMatch(/continue-on-error/);
    expect(ci).not.toMatch(/npm audit --omit=dev/);
  });
});

describe("installation rehearsal script", () => {
  it("exists, is executable and runs the six steps in order", () => {
    expect(statSync("scripts/rehearse-install.sh").mode & 0o111).not.toBe(0);
    const text = readFileSync("scripts/rehearse-install.sh", "utf8");
    const order = ["npm ci", "npm run typecheck", "check-contracts -- --require-frozen --require-signed", "npm run build", "npm run check-bundle", "serve_and_fetch"];
    const at = order.map((s) => text.lastIndexOf(s));
    expect(at.every((n) => n > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain("--clean");
  });
});
