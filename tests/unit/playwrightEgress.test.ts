// @vitest-environment node
/** Every Playwright spec (end-to-end and acceptance) takes `test` from the egress fixture, never from @playwright/test (D8-05, T10). */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const specs = ["tests/e2e", "tests/acceptance"].flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith(".spec.ts")).map((f) => join(dir, f)));
const FIXTURE_IMPORT = /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*"(?:\.\/egress|\.\.\/e2e\/egress)(?:\.ts)?"/;
const DIRECT_TEST_IMPORT = /^import\s*\{[^}]*\btest\b(?!\s+as\b)[^}]*\}\s*from\s*"@playwright\/test"/m;

describe("Playwright specs use the egress fixture", () => {
  it("finds the specs", () => {
    expect(specs.length).toBeGreaterThanOrEqual(11);
  });

  it.each(specs)("%s imports test from the egress fixture", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src, "must import `test` from the egress fixture").toMatch(FIXTURE_IMPORT);
    expect(src, "must not import `test` from @playwright/test").not.toMatch(DIRECT_TEST_IMPORT);
  });

  it("only egress.spec.ts uses the plain test, under an alias, to observe the browser itself", () => {
    const aliased = specs.filter((f) => /\btest\s+as\s+\w+\s*\}\s*from\s*"@playwright\/test"/.test(readFileSync(f, "utf8")));
    expect(aliased).toEqual(["tests/e2e/egress.spec.ts"]);
  });

  it("the fixture watches the whole context for foreign requests and CSP violations", () => {
    const fixture = readFileSync("tests/e2e/egress.ts", "utf8");
    expect(fixture).toContain('context.on("request"');
    expect(fixture).toContain("securitypolicyviolation");
    expect(fixture).toContain("egress-allowlist.json");
    expect(fixture).toMatch(/expect\(foreign[^)]*\)\.toEqual\(\[\]\)/);
    expect(fixture).toMatch(/expect\(violations[^)]*\)\.toEqual\(\[\]\)/);
  });
});
