// @vitest-environment node
/**
 * The local notes (operator install notes, Record notes, developer handover) say what the repository does. The notes are
 * git-ignored (decision D2-02), so CI has no copy and these tests run only where the files are.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FLAG_TEXT } from "../../src/model/ingress";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
const golden = JSON.parse(readFileSync("tests/golden/digests.json", "utf8")) as Record<string, string>;
const read = (f: string) => readFileSync(f, "utf8");
const npmRuns = (text: string) => [...text.matchAll(/npm run ([a-z0-9:-]+)/g)].map((m) => m[1]);
const paths = (text: string) => [...text.matchAll(/`((?:src|scripts|tests|config|contracts|fixtures|spec)\/[\w./@-]+)`/g)].map((m) => m[1]);

describe.runIf(existsSync("docs/operator/install-notes.md"))("install notes", () => {
  const notes = existsSync("docs/operator/install-notes.md") ? read("docs/operator/install-notes.md") : "";

  it("names the Node version the repository pins, and the port the build is served on", () => {
    expect(notes).toContain(`Node.js | ${read(".nvmrc").trim()}`);
    expect(notes).toContain("4173");
    expect(notes).toContain("npm ci");
  });

  it("gives the install steps in the order that works", () => {
    const steps = ["npm ci", "npm run typecheck", "npm run check-contracts -- --require-frozen --require-signed", "npm run build", "npm run check-bundle", "npm run serve"];
    const at = steps.map((s) => notes.indexOf(s));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("only tells the operator to run npm scripts that exist", () => {
    for (const s of npmRuns(notes)) expect(Object.keys(pkg.scripts), s).toContain(s);
  });

  it("lists every configuration variable of config/env.example, and the declared limits", () => {
    const vars = read("config/env.example").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=")[0]);
    expect(vars).toHaveLength(15);
    for (const v of vars) expect(notes, v).toContain(`\`${v}\``);
    for (const limit of ["10 MiB", "**12**", "30 seconds", "one data row"]) expect(notes, limit).toContain(limit);
    const limits = read("contracts/n/policy/LIMITS@1.0.0.yaml");
    expect(limits).toMatch(/max_file_bytes: 10485760/);
    expect(limits).toMatch(/max_json_depth: 12/);
    expect(limits).toMatch(/job_deadline_ms: 30000/);
    expect(limits).toMatch(/max_erp_data_rows: 1\b/);
  });

  it("states the sha256 of the three outputs of the sample run, as the golden files have them", () => {
    for (const route of ["customer-pdf", "erp-staging-csv", "registry-prep-json"]) expect(notes, route).toContain(golden[route]);
  });

  it("says how to reset, and what the demonstrator does not do", () => {
    expect(notes).toMatch(/Clear site data/);
    expect(notes).toMatch(/IndexedDB/);
    for (const claim of ["hosted", "availability", "disaster recovery", "never submits", "synthetic"]) expect(notes.toLowerCase(), claim).toContain(claim.toLowerCase());
  });

  it("describes the rail as it is, and the pair rule", () => {
    const rail = ["Profile", "Import", "Record", "Readiness", "Outputs", "Requirements", "Prepare", "Validation", "Mapping", "Graph compliance"];
    expect(notes).toContain("ten screens");
    for (const r of rail) expect(notes, r).toContain(r);
    expect(notes).toMatch(/only once both files are in and accepted/);
  });

  it("names the sample files and results that exist", () => {
    expect(notes).toContain("Clean pair");
    expect(notes).toContain("ERP value with a decimal comma");
    expect(existsSync("fixtures/n/erp-decimal-comma.csv")).toBe(true);
    expect(notes).toContain("RR-STANDING-HOLD");
    expect(notes).toContain("decimal-comma");
    expect(existsSync("scripts/rehearse-install.sh")).toBe(true);
  });
});

describe.runIf(existsSync("docs/operator/outputs-notes.md"))("outputs notes", () => {
  const notes = existsSync("docs/operator/outputs-notes.md") ? read("docs/operator/outputs-notes.md") : "";
  it("says the manifest has a generated time that is in no digest, and that a value is corrected on the Record screen", () => {
    expect(notes).toContain("generated");
    expect(notes).toContain("substantive digest");
    expect(notes).not.toContain("holds no date or time");
    expect(notes).not.toContain("edits no record");
    expect(notes).toContain("Record** screen");
  });
});

describe.runIf(existsSync("docs/operator/record-notes.md"))("record notes", () => {
  const notes = existsSync("docs/operator/record-notes.md") ? read("docs/operator/record-notes.md") : "";

  it("explains every value status and the correction flag in the words of the screen", () => {
    for (const status of ["single", "agreeing", "challenged", "corrected"]) expect(notes, status).toContain(`\`${status}\``);
    expect(notes).toContain(FLAG_TEXT["corrected"].replace(": the earlier value stays visible", ""));
  });

  it("states the correction rules", () => {
    for (const rule of ["A reason is required", "new version", "earlier value stays visible", "cannot touch another record", "never adds a code", "cannot be corrected by hand", "latest version"]) {
      expect(notes, rule).toContain(rule);
    }
    expect(notes).toMatch(/lineage and the release manifest name the correction/);
    expect(notes).toMatch(/never holds the value or the reason/);
  });

  it("explains the re-import rule, the two digests and the honest labels", () => {
    for (const t of ["carried forward", "confirms", "drops the value", "An earlier version of this file", "attached", "source-changed", "Record digest", "Version digest", "First import", "Re-import", "Imported from a central-record file", "Store the accepted record without the other file", "same value", "Earlier"]) {
      expect(notes.toLowerCase(), t).toContain(t.toLowerCase().replace("same value", "stating the value the record already has"));
    }
    expect(read("src/components/ImportView.tsx")).toContain("Store the accepted record without the other file");
  });

  it("names the parts of the screen and the buttons it has", () => {
    for (const part of ["Sources", "Record values", "Routes and outputs", "Versions and differences", "Open Readiness", "Open Outputs", "Save as a new version", "Access to each property"]) {
      expect(notes, part).toContain(part);
      expect(read("src/components/RecordView.tsx"), part).toContain(part);
    }
  });
});

describe.runIf(existsSync("docs/developer/handover.md"))("developer handover", () => {
  const notes = existsSync("docs/developer/handover.md") ? read("docs/developer/handover.md") : "";

  it("mentions only files and folders that exist", () => {
    const named = paths(notes);
    expect(named.length).toBeGreaterThan(30);
    for (const p of named) expect(existsSync(p), p).toBe(true);
  });

  it("documents every npm script", () => {
    for (const s of Object.keys(pkg.scripts)) expect(notes, s).toContain(s === "generate-icons" ? "generate-icons" : s);
  });

  it("covers the architecture, the pack workflow with signing, the tests, the release process, the known limits and the open items", () => {
    for (const heading of ["## Architecture", "## The pack and the spec generator", "## Tests, golden files and scripts", "## Release process", "## Known limits", "## Open items for P"]) expect(notes, heading).toContain(heading);
    for (const text of ["node spec/tools/build-packs.mjs", "--write", "SIGNATURES.json", "--require-signed", "CHANGELOG.md", "D3-02", "D4-03", "D5-05", "source, record, route, output"]) expect(notes, text).toContain(text);
  });

  it("names every module of the model the data flow passes through", () => {
    for (const m of ["ingress", "strictJson", "recordRepository", "correction", "centralRecord", "policy", "disclosure", "readiness", "derived", "lineage", "log", "profile"]) {
      expect(notes, m).toContain(`src/model/${m}.ts`);
    }
  });
});

describe("public ADRs and documentation boundaries", () => {
  it("tracks public ADRs in adr/ while keeping docs/ and working documentation git-ignored", () => {
    for (const file of [
      "adr/0001-browser-only-pipeline-and-contract-packs.md",
      "adr/0002-deterministic-contract-testing-and-three-layer-verification.md",
      "adr/0003-reimport-and-correction-semantics.md",
      "adr/0004-durable-relational-storage-and-staged-jobs.md",
      "adr/0005-oidc-rbac-enforcement-and-controlled-config-releases.md",
    ]) {
      expect(existsSync(file), file).toBe(true);
    }
    const gitignore = read(".gitignore");
    for (const ignored of ["/docs/", "/docs/assessment/", "/scripts/assessment/", "/spec/", "/CLAUDE.md", "/.claude/"]) {
      expect(gitignore, ignored).toContain(ignored);
    }
  });
});

describe.runIf(existsSync("docs/operator/server-notes.md"))("server notes", () => {
  // The describe body runs even when the block is skipped, so the local, git-ignored notes are read only if present.
  const notes = existsSync("docs/operator/server-notes.md") ? read("docs/operator/server-notes.md") : "";
  const example = read("config/env.example");

  it("mentions only files and folders that exist", () => {
    for (const p of paths(notes)) expect(existsSync(p), p).toBe(true);
    for (const f of ["server/index.ts", "server/http/api.ts", "adr/0004-durable-relational-storage-and-staged-jobs.md"]) expect(notes).toContain(f);
  });

  it("runs only npm scripts that exist and documents every server variable of the configuration example", () => {
    for (const s of npmRuns(notes)) expect(pkg.scripts[s!], s).toBeDefined();
    const variables = [...example.matchAll(/^(DPP_(?:DB_PATH|SERVER_HOST|SERVER_PORT|ALLOWED_ORIGIN|STATIC_DIR|CONTRACT_PACK))=/gm)].map((m) => m[1]!);
    expect(variables).toHaveLength(6);
    for (const v of variables) expect(notes, v).toContain(v);
  });

  it("states the limits that matter: no authentication, localhost only, legal hold release, backup and recovery", () => {
    for (const text of ["no authentication", "127.0.0.1", "cannot be released over the API", "VACUUM INTO", "POST /api/jobs/recover", "DPP_ALLOWED_ORIGIN", "Supported"]) {
      expect(notes, text).toContain(text);
    }
    expect(notes).not.toMatch(/0\.0\.0\.0/);
  });
});

describe.runIf(existsSync("docs/operator/identity-and-releases-notes.md"))("identity and configuration release notes", () => {
  const notes = existsSync("docs/operator/identity-and-releases-notes.md") ? read("docs/operator/identity-and-releases-notes.md") : "";

  it("mentions only files and folders that exist and documents all Cycle 7 environment variables", () => {
    for (const p of paths(notes)) expect(existsSync(p), p).toBe(true);
    for (const v of ["DPP_AUTH_MODE", "DPP_DEPLOYMENT_SURFACE", "DPP_OIDC_ISSUER", "DPP_OIDC_AUDIENCE", "DPP_OIDC_JWKS_PATH"]) {
      expect(notes, v).toContain(v);
    }
  });

  it("covers roles, immediate revocation, surface separation, four-eyes approval, rollback, and legal hold release", () => {
    for (const token of [
      "ACT-01",
      "ACT-06",
      "ADMIN",
      "CURATOR",
      "AUDITOR",
      "grant_epoch",
      "/api/customer/",
      "/api/admin/users",
      "/api/config-releases/propose",
      "/api/config-releases/rollback",
      "four-eyes",
      "legal-hold",
    ]) {
      expect(notes, token).toContain(token);
    }
  });
});
