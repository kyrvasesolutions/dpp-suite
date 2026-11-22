// @vitest-environment node
/** Negative control for check-bundle: pdfjs-dist in any script asset (.js, .mjs, .cjs) fails the check; pdf-lib is required. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const csp = readFileSync("config/egress-allowlist.json", "utf8");
const allow = JSON.parse(csp) as { connect: string[] };

function run(assets: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "dpp-dist-"));
  try {
    mkdirSync(join(dir, "assets"));
    const policy = `default-src 'self'; connect-src ${["'self'", ...allow.connect].join(" ")}`;
    writeFileSync(join(dir, "index.html"), `<html><head><meta http-equiv="Content-Security-Policy" content="${policy}"></head></html>`);
    for (const [name, body] of Object.entries(assets)) writeFileSync(join(dir, "assets", name), body);
    const r = spawnSync("node", ["scripts/check-bundle.mjs"], { env: { ...process.env, DPP_DIST: dir }, encoding: "utf8" });
    return `${r.stdout}${r.stderr}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PDFLIB = 'class PDFDocument{} const f="Helvetica"; const x={packDir:"contracts/n"};';

describe("check-bundle and the PDF libraries", () => {
  it.each(["chunk.js", "chunk.mjs", "chunk.cjs"])("fails when pdfjs-dist is in %s", (name) => {
    const out = run({ "index.js": PDFLIB, [name]: "GlobalWorkerOptions.workerSrc=1" });
    expect(out).toMatch(/pdfjs-dist is a test-only dependency/);
  });

  it("does not complain about pdfjs when only pdf-lib is bundled", () => {
    expect(run({ "index.js": PDFLIB })).toMatch(/Bundle OK/);
  });

  it("fails when pdf-lib is missing", () => {
    expect(run({ "index.js": 'const x={packDir:"contracts/n"};' })).toMatch(/pdf-lib should be bundled/);
  });
});
