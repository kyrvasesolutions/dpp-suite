/**
 * The cases that are not one class on one route: the positive case of each route, reproducibility across browsers, no partial
 * success after a good record, conflicting sources and a correction, and the two scans of what the system says (the log, and
 * the error and hold messages). The cases come from cases.ts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import { expect, test } from "../e2e/egress";
import { CASES, CLASSES, CLEAN, ROUTES, type Case, type EffectClass, type RouteId } from "./cases";
import { download, downloadLog, expectNoDenied, fixtureFile, golden, importPair, logEntries, openImport, openOutputs, pick, recordOf, route, sha, textOf } from "./support";

const byId = (id: string): Case => CASES.find((c) => c.id === id)!;
const positive = CASES.filter((c) => c.class === "positive");

for (const c of positive) {
  test(`[${c.id}] ${c.title}`, async ({ page }) => {
    const name = c.route as RouteId;
    await importPair(page, CLEAN);
    await openOutputs(page);
    await expect(route(page, name)).toHaveAttribute("data-state", name === "registry-prep-json" ? "hold-draft" : "ready");
    const file = await download(page, name);
    expect(sha(file.bytes), `${name} equals the golden digest`).toBe(golden[name]);
    const text = await textOf(name, file.bytes);
    await expectNoDenied(text, name, CLEAN);
    if (name === "customer-pdf") {
      expect(text).toContain("Product data sheet");
      expect(text).toContain("within the limits");
      expect(text).toContain("Reading this sheet");
    } else if (name === "erp-staging-csv") {
      expect(text.trim().split("\n")).toHaveLength(2); // one header, one data row
      expect(text).toContain("PM-5754-H111-2000");
    } else {
      const draft = JSON.parse(text);
      expect(draft).toMatchObject({ status: "HOLD", submission: "never" });
      await expect(route(page, name).getByTestId("draft-notice")).toContainText("never submitted");
    }
  });
}

test(`[${byId("AC-REPRODUCIBLE-ALL").id}] ${byId("AC-REPRODUCIBLE-ALL").title}`, async ({ browser }) => {
  const runs: Array<{ digest: string; files: Record<string, string> }> = [];
  for (let n = 0; n < 2; n++) {
    const context = await browser.newContext({ baseURL: "http://localhost:4173", acceptDownloads: true });
    try {
      const page = await context.newPage();
      await importPair(page, CLEAN);
      const digest = await page.getByTestId("record-digest").getAttribute("title");
      if (n === 1) {
        // importing the same files again stores nothing new
        await page.getByRole("button", { name: "Import the same files again" }).click();
        await expect(page.getByTestId("reimport")).toHaveAttribute("data-same", "true");
        await expect(page.getByTestId("snapshot-status").first()).toHaveAttribute("data-stored", "false");
      }
      await openOutputs(page);
      await expect(page.getByTestId("outputs-record")).toContainText("version 1 of 1");
      const files: Record<string, string> = {};
      for (const name of ROUTES) files[name] = sha((await download(page, name)).bytes);
      runs.push({ digest: digest!, files });
    } finally {
      await context.close();
    }
  }
  expect(runs[1]).toEqual(runs[0]);
  for (const name of ROUTES) expect(runs[0].files[name], name).toBe(golden[name]);
});

test(`[${byId("AC-G14-NO-PARTIAL").id}] ${byId("AC-G14-NO-PARTIAL").title}`, async ({ page }) => {
  await importPair(page, CLEAN);
  // a second data row in the extract, with the good laboratory file still loaded
  await openImport(page);
  await pick(page, "erp", fixtureFile("erp-two-rows.csv"));
  await expect(page.getByTestId("import-erp")).toHaveAttribute("data-ok", "false");
  await expect(page.getByTestId("import-error").first()).toHaveAttribute("data-code", "multiple-records");
  await expect(page.getByTestId("import-error").first()).toHaveAttribute("data-stage", "structure");
  // no new version, and every output is still the golden one
  await openOutputs(page);
  await expect(page.getByTestId("outputs-record")).toContainText("version 1 of 1");
  await expect(page.getByTestId("snapshot")).toHaveCount(1);
  for (const name of ROUTES) expect(sha((await download(page, name)).bytes), name).toBe(golden[name]);
});

test(`[${byId("AC-CONFLICT-BOTH-KEPT").id}] ${byId("AC-CONFLICT-BOTH-KEPT").title}`, async ({ page }) => {
  await importPair(page, { erp: CLEAN.erp, lab: "lab-conflicting-alloy.json" });
  await page.goto("/#record");
  const alloy = page.locator('[data-testid="record-value"]').filter({ hasText: "Alloy designation" }).first();
  await expect(alloy).toHaveAttribute("data-status", "challenged");
  await expect(alloy.getByTestId("current-value")).toHaveCount(2); // both values are shown
  await expect(alloy).toContainText("EN AW-5754");
  await expect(alloy).toContainText("EN AW-5083");
  await expect(page.locator('[data-testid="record-route"][data-route="customer-pdf"]')).toHaveAttribute("data-status", "on-hold");
  await expect(page.locator('[data-testid="record-route"][data-route="customer-pdf"] [data-rule="RR-CHALLENGED"]')).toHaveCount(1);
  // the operator decides, with a reason: the value counts as present, and both earlier values stay visible
  await alloy.getByTestId("correct-button").click();
  await page.getByTestId("correct-value").fill("EN AW-5754");
  await page.getByTestId("correct-reason").fill("The mill certificate confirms 5754");
  await page.getByTestId("correct-save").click();
  await expect(page.getByTestId("record-head")).toContainText("version 2 of 2");
  const after = page.locator('[data-testid="record-value"]').filter({ hasText: "Alloy designation" }).first();
  await expect(after).toHaveAttribute("data-status", "corrected");
  await expect(after.getByTestId("earlier-value")).toHaveCount(2);
  await expect(after.getByTestId("earlier-value").filter({ hasText: "EN AW-5083" })).toHaveCount(1);
  await expect(after.getByTestId("correction-note")).toContainText("The mill certificate confirms 5754");
  await expect(page.locator('[data-testid="record-route"][data-route="customer-pdf"] [data-rule="RR-CHALLENGED"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="record-route"][data-route="erp-staging-csv"]')).toHaveAttribute("data-status", "ready");
});

// ---------- the scans of what the system says ----------

const FIXTURE_FILES = readdirSync("fixtures/n").filter((f) => /\.(csv|json)$/.test(f) && f !== "MANIFEST.json");
const cells = (csv: string) => csv.split(/\r?\n/).flatMap((l) => l.split(";")).map((c) => c.replace(/^"|"$/g, "")).filter(Boolean);
const leaves = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(leaves) : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : v === null || v === undefined || typeof v === "boolean" ? [] : [String(v)]);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test(`[${byId("AC-LOG-SCAN").id}] ${byId("AC-LOG-SCAN").title}`, async ({ page }) => {
  test.setTimeout(120_000);
  const messages: string[] = [];
  // every fixture alone, then every accepted pair through to outputs and the central-record export
  await openImport(page);
  for (const name of FIXTURE_FILES) {
    const role = name.endsWith(".csv") ? "erp" : "lab";
    await pick(page, role, fixtureFile(name));
    await expect(page.getByTestId(`import-${role}`)).toBeVisible();
    for (const t of await page.getByTestId("import-error").allInnerTexts()) messages.push(t);
    // start the next fixture from nothing else loaded
    await page.reload();
    await page.goto("/#import");
  }
  const accepted = Object.values(CLASSES).filter((c): c is EffectClass => c.kind === "effect");
  for (const k of accepted) {
    await importPair(page, k.pair);
    await openOutputs(page);
    await expect(page.getByTestId("output-route")).toHaveCount(3);
    for (const name of ROUTES) messages.push(await route(page, name).innerText());
    await page.getByRole("button", { name: "Export central record" }).click().catch(() => undefined);
  }

  // the log is in IndexedDB, which a reload keeps: it holds every run
  await page.goto("/#outputs");
  const entries = await logEntries(page);
  expect(await entries.count()).toBeGreaterThan(30);
  const { text, doc } = await downloadLog(page);
  // only the public fields, in the documented order
  expect(doc.fields).toEqual(["seq", "event", "stage", "code", "route", "ruleId", "stepId", "record", "version", "fileRole", "fileSha256", "outcome"]);
  for (const e of doc.entries) for (const key of Object.keys(e)) expect(doc.fields).toContain(key);
  expect(doc.entries.some((e) => e.event === "import-rejected" && e.code === "wrong-encoding")).toBe(true);
  expect(doc.entries.some((e) => e.event === "output-refused")).toBe(true);

  // no source value, file name or message of any fixture is in it (the sequence number and version are the log's own counters)
  const scanned = JSON.stringify(doc.entries.map(({ seq: _s, version: _v, ...rest }) => rest));
  const legit = new Set<string>(["erp", "lab", ...doc.entries.flatMap((e) => [e.event, e.outcome, e.stage, e.code, e.route, e.ruleId, e.fileRole].filter(Boolean) as string[])]);
  const tokens = new Set<string>();
  for (const name of FIXTURE_FILES) {
    const body = readFileSync(`fixtures/n/${name}`, "utf8");
    tokens.add(name);
    if (name.endsWith(".csv")) cells(body).forEach((c) => tokens.add(c));
    else {
      try {
        leaves(JSON.parse(body)).forEach((c) => tokens.add(c));
      } catch {
        body.split(/[^\w.-]+/).forEach((c) => tokens.add(c));
      }
    }
  }
  for (const m of messages) m.split(/\n+/).forEach((l) => tokens.add(l.trim()));
  const checked = [...tokens].filter((t) => t.length >= 3 && !legit.has(t));
  expect(checked.length).toBeGreaterThan(100);
  for (const t of checked) expect(new RegExp(`(?<![\\w-])${escape(t)}(?![\\w-])`).test(scanned), `"${t}" is in the log`).toBe(false);
  expect(text).not.toMatch(/PM-5754|B-2026|EV-CR|EV-TR/);
});

test(`[${byId("AC-MESSAGE-SCAN").id}] ${byId("AC-MESSAGE-SCAN").title}`, async ({ page }) => {
  test.setTimeout(120_000);
  const accepted = Object.entries(CLASSES).filter((e): e is [string, EffectClass] => e[1].kind === "effect");
  let scanned = 0;
  for (const [, k] of accepted) {
    await importPair(page, k.pair);
    await openOutputs(page);
    await expect(page.getByTestId("output-route")).toHaveCount(3);
    for (const name of ROUTES) {
      const card = route(page, name);
      // the whole card: refusal text, hold rules, rule texts, positions of the sources
      await expectNoDenied(await card.innerText(), name, k.pair);
      scanned++;
    }
    // the same holds as the Record and Readiness screens show them
    await page.goto("/#record");
    for (const name of ROUTES) {
      await expectNoDenied(await page.locator(`[data-testid="record-route"][data-route="${name}"]`).innerText(), name, k.pair);
      scanned++;
    }
    expect(await recordOf(k.pair)).toBeTruthy();
  }
  expect(scanned).toBe(accepted.length * 6);
  // and the hold rule IDs are the ones the pack knows
  const rules = new Set((parse(readFileSync("contracts/n/policy/READINESS-RULES@1.0.0.yaml", "utf8")) as { rules: Array<{ id: string }> }).rules.map((r) => r.id));
  for (const [, k] of accepted) for (const r of Object.values(k.routes)) for (const id of r.rules) expect(rules.has(id), id).toBe(true);
});

// ---------- the chain, the re-import, the pair, the install smoke and the gate ----------

const erpWith = (value: string) => ({ name: "d03a-erp-extract.csv", mimeType: "text/csv", buffer: Buffer.from(readFileSync("fixtures/n/d03a-erp-extract.csv", "utf8").replace(";62.0;", `;${value};`)) });

test(`[${byId("AC-RECORD-CHAIN").id}] ${byId("AC-RECORD-CHAIN").title}`, async ({ page }) => {
  await importPair(page, CLEAN);
  await page.goto("/#record");
  await expect(page.locator('[data-testid="record-source"][data-status="accepted"]')).toHaveCount(2);
  await expect(page.getByTestId("record-source").first()).toContainText(/[0-9a-f]{12}…/);
  const values = page.getByTestId("record-value");
  expect(await values.count()).toBeGreaterThan(20);
  await expect(page.locator('[data-testid="record-value"][data-status="agreeing"]')).toHaveCount(3);
  for (const kind of ["declared", "measured", "calculated externally"]) await expect(page.locator(`[data-testid="value-kind"]`, { hasText: new RegExp(`^${kind}$`) }).first()).toBeVisible();
  for (const name of ROUTES) {
    const card = page.locator(`[data-testid="record-route"][data-route="${name}"]`);
    await expect(card).toHaveAttribute("data-status", name === "registry-prep-json" ? "on-hold" : "ready");
    await card.locator("summary").click();
    expect(await card.locator('[data-testid="record-access"]').count()).toBeGreaterThan(0);
    await expect(card.getByTestId("record-output")).toHaveAttribute("data-state", name === "registry-prep-json" ? "hold-draft" : "made");
  }
  const customer = page.locator('[data-testid="record-route"][data-route="customer-pdf"]');
  await expect(customer.locator('[data-access="derived"]')).toHaveCount(2);
  await expect(customer.locator('[data-access="deny"]').first()).toBeVisible();
  await page.getByRole("button", { name: "Open Outputs" }).click();
  await expect(page.getByTestId("output-route")).toHaveCount(3);
  await page.goto("/#record");
  await page.getByRole("button", { name: "Open Readiness" }).click();
  await expect(page.getByTestId("readiness-version")).toContainText("version 1");
});

test(`[${byId("AC-REIMPORT-CORRECTION").id}] ${byId("AC-REIMPORT-CORRECTION").title}`, async ({ page }) => {
  await importPair(page, CLEAN);
  await page.goto("/#record");
  const recycled = () => page.locator('[data-testid="record-value"]').filter({ hasText: "Recycled content" }).first();
  await recycled().getByTestId("correct-button").click();
  await page.getByTestId("correct-value").fill("63.5");
  await page.getByTestId("correct-reason").fill("Certificate says 63.5");
  await page.getByTestId("correct-save").click();
  await expect(page.getByTestId("record-head")).toContainText("version 2 of 2");

  await page.goto("/#import");
  await page.getByRole("button", { name: "Import the same files again" }).click();
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-stored", "false");
  await openOutputs(page);
  const csv = (await download(page, "erp-staging-csv")).bytes.toString("utf8");
  expect(csv).toContain(";63.5;");
  expect(csv).not.toContain(";62.0;");

  await page.goto("/#import");
  await pick(page, "erp", erpWith("60.0"));
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-version", "3");
  for (const screen of ["record", "readiness", "outputs"]) {
    await page.goto(`/#${screen}`);
    if (screen === "record") await expect(recycled()).toHaveAttribute("data-status", "challenged");
    if (screen === "readiness") await expect(page.locator('[data-testid="route-status"][data-route="erp-staging-csv"] [data-rule="RR-CHALLENGED"]')).toHaveCount(1);
    if (screen === "outputs") await expect(route(page, "erp-staging-csv")).toHaveAttribute("data-state", "refused");
  }
});

test(`[${byId("AC-PAIR-ONE-VERSION").id}] ${byId("AC-PAIR-ONE-VERSION").title}`, async ({ page }) => {
  await openImport(page);
  await pick(page, "erp", erpWith("62.0"));
  await expect(page.getByTestId("pair-pending")).toBeVisible();
  await expect(page.getByTestId("snapshot-status")).toHaveCount(0);
  await openOutputs(page);
  await expect(page.getByTestId("outputs-empty")).toBeVisible();
  await openImport(page);
  await expect(page.getByTestId("import-erp")).toHaveAttribute("data-ok", "true");
  await pick(page, "lab", fixtureFile(CLEAN.lab));
  await expect(page.getByTestId("snapshot-status")).toHaveAttribute("data-version", "1");
  await page.goto("/#record");
  await expect(page.getByTestId("record-version")).toHaveCount(1);
  await expect(page.getByTestId("record-version").first()).toContainText("First import");
});

test(`[${byId("AC-INSTALL-SMOKE").id}] ${byId("AC-INSTALL-SMOKE").title}`, async ({ page }) => {
  const res = await page.request.get("/");
  expect(res.ok()).toBe(true);
  const html = await res.text();
  expect(html).toContain('<div id="root"');
  expect(html).toContain("Content-Security-Policy");
  expect(spawnSync("node", ["scripts/check-bundle.mjs"], { encoding: "utf8" }).status).toBe(0);
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { engines: { node: string }; scripts: Record<string, string> };
  expect(readFileSync(".nvmrc", "utf8").trim()).toBe("24");
  expect(pkg.engines.node).toBe(">=24");
  expect(pkg.scripts.serve).toContain("--port 4173");
  expect(readFileSync("config/env.example", "utf8")).toMatch(/^VITE_ENABLE_LLM=false$/m);
  expect(statSync("scripts/rehearse-install.sh").mode & 0o111).not.toBe(0);
  expect(existsSync("package-lock.json")).toBe(true);
});

test(`[${byId("AC-ACCEPTANCE-GATE").id}] ${byId("AC-ACCEPTANCE-GATE").title}`, async () => {
  const matrix = JSON.parse(readFileSync("tests/acceptance/coverage.json", "utf8")) as { cases: Case[] };
  expect(matrix.cases).toEqual(JSON.parse(JSON.stringify(CASES)));
  for (const f of ["FUNC-005", "FUNC-006", "FUNC-076", "FUNC-131", "FUNC-132", "FUNC-133", "FUNC-134"]) expect(CASES.some((c) => c.funcs.includes(f)), f).toBe(true);
  const packClasses = readdirSync("contracts/n/failure-cases").map((f) => f.replace(/\.yaml$/, ""));
  for (const name of packClasses) expect(CASES.filter((c) => c.class === name && c.route !== "all").map((c) => c.route).sort(), name).toEqual([...ROUTES].sort());
  expect(CASES.length).toBeGreaterThanOrEqual(60);
});
