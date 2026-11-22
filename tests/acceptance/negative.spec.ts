/**
 * The failure classes, each against each of the three routes, through the UI (decision on the reading of the negative suite).
 * The cases come from cases.ts; nothing here names a case of its own.
 */
import { expect, test } from "../e2e/egress";
import { CASES, CLASSES, type EffectClass, type IngressClass, type RouteId } from "./cases";
import { deniedCount, download, expectNoDenied, fixtureFile, golden, holdRules, logEntries, openImport, openOutputs, pick, route, sha, textOf, importPair } from "./support";

const classCases = CASES.filter((c) => c.route !== "all" && CLASSES[c.class]);

async function ingressCase(page: import("@playwright/test").Page, k: IngressClass, name: RouteId) {
  if (k.built === "deadline") {
    // The page's clock jumps 40 s on every reading while the file is imported, so the 30-second deadline is passed.
    await page.addInitScript(() => {
      const real = performance.now.bind(performance);
      let t = 0;
      performance.now = () => ((window as unknown as { __slow?: boolean }).__slow ? (t += 40_000) : real());
    });
  }
  await openImport(page);
  const file =
    k.built === "too-large"
      ? { name: "erp-too-large.csv", mimeType: "text/csv", buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61) }
      : fixtureFile(k.file!);
  if (k.built === "deadline") await page.evaluate(() => ((window as unknown as { __slow: boolean }).__slow = true));
  await pick(page, k.role, file);
  const result = page.getByTestId(`import-${k.role}`);
  await expect(result).toHaveAttribute("data-ok", "false");
  if (k.built === "deadline") await page.evaluate(() => ((window as unknown as { __slow: boolean }).__slow = false));

  // the typed error names its stage and code, and the other file's result is not shown
  const error = result.locator(`[data-testid="import-error"][data-code="${k.code}"]`).first();
  await expect(error).toHaveAttribute("data-stage", k.stage);
  await expect(page.getByTestId(`import-${k.role === "erp" ? "lab" : "erp"}`)).toHaveCount(0);

  // no record was made: nothing is stored, and the route has no card and no download
  await expect(page.getByTestId("snapshot-status")).toHaveCount(0);
  await openOutputs(page);
  await expect(page.getByTestId("outputs-empty")).toBeVisible();
  await expect(route(page, name)).toHaveCount(0);
  await expect(page.locator(`[data-testid="download"][data-route="${name}"]`)).toHaveCount(0);
  await expect(page.getByTestId("snapshot")).toHaveCount(0);
  await page.goto("/#record");
  await expect(page.getByTestId("record-empty")).toBeVisible();

  // the rejection is logged as its stage and code: no value, no file name
  await page.goto("/#import");
  const entries = await logEntries(page);
  await expect(entries.filter({ hasText: k.code })).toHaveCount(1);
  await expect(entries.filter({ hasText: k.stage }).first()).toHaveAttribute("data-event", "import-rejected");
  const shown = await page.getByTestId("execution-log").innerText();
  if (file.name) expect(shown).not.toContain(file.name);
}

async function effectCase(page: import("@playwright/test").Page, k: EffectClass, name: RouteId) {
  const expected = k.routes[name];
  await importPair(page, k.pair);
  await openOutputs(page);
  await expect(page.getByTestId("output-route")).toHaveCount(3);
  const card = route(page, name);
  const state = await card.getAttribute("data-state");

  if (expected.outcome === "route-hold-output-refused") {
    await expect(card).toHaveAttribute("data-state", "refused");
    await expect(card.getByTestId("refusal")).toContainText("No file is made");
    expect(await holdRules(card)).toEqual([...expected.rules].sort());
    await expect(card.getByTestId("download")).toHaveCount(0);
    // each hold names where the assertions are, and the message holds no value the recipient may not see
    await expectNoDenied(await card.innerText(), name, k.pair);
    return;
  }

  // the route makes a file: only the registry draft is allowed to be on hold
  if (name === "registry-prep-json") {
    expect(state).toBe("hold-draft");
    expect(await holdRules(card)).toEqual([...expected.rules].sort());
    await expect(card.getByTestId("draft-notice")).toContainText("never submitted");
  } else {
    expect(state).toBe("ready");
  }
  const file = await download(page, name);
  const text = await textOf(name, file.bytes);
  await expectNoDenied(text, name, k.pair);

  if (name === "registry-prep-json") {
    const draft = JSON.parse(text) as { status: string; submission: string; holds: Array<{ rule: string }> };
    expect(draft.status).toBe("HOLD");
    expect(draft.submission).toBe("never");
    expect(draft.holds.map((h) => h.rule).sort()).toEqual([...expected.rules].sort());
    // a class that cannot affect the route leaves its draft byte for byte as the golden one
    if (expected.outcome === "NA" || expected.outcome === "field-withheld" || expected.outcome === "reproducible") expect(sha(file.bytes)).toBe(golden["registry-prep-json"]);
  }
  if (expected.outcome === "field-withheld" || expected.outcome === "reproducible") expect(sha(file.bytes)).toBe(golden[name]);

  if (expected.outcome === "field-withheld") {
    // the recipient view on the Record screen shows every denied property as withheld
    await page.goto("/#record");
    const card2 = page.locator(`[data-testid="record-route"][data-route="${name}"]`);
    await card2.locator("summary").click();
    const withheld = card2.locator('[data-testid="record-access"][data-access="deny"]');
    expect(await withheld.count()).toBeGreaterThan(0);
    expect(await withheld.count()).toBeLessThanOrEqual(deniedCount(name));
    for (const label of await withheld.allInnerTexts()) expect(label).toContain("Withheld");
  }
  if (expected.outcome === "reproducible") {
    // a second download in the same browser, and the same file again
    expect(sha((await download(page, name)).bytes)).toBe(sha(file.bytes));
  }
}

for (const c of classCases) {
  const k = CLASSES[c.class];
  test(`[${c.id}] ${c.title}`, async ({ page }) => {
    test.info().annotations.push({ type: "case", description: c.id });
    if (k.kind === "ingress") await ingressCase(page, k, c.route as RouteId);
    else await effectCase(page, k, c.route as RouteId);
  });
}
