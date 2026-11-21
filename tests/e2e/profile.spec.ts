/** The Profile screen shows what the pinned pack files hold (Cycle 1, AT-E for C1-01, C1-05 and C1-06). */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { expect, test } from "./egress";

const PACK = "contracts/n";
const profile = parse(readFileSync(`${PACK}/profile/PROFILE-ALU-24-01@1.0.0.yaml`, "utf8")) as {
  pins: { terms: string; code_lists: string[] };
  properties: Array<{ id: string; labels: { en: string; de: string }; members: string[]; context_labels?: Array<{ lang: string; context: string; text: string }> }>;
};
const terms = parse(readFileSync(`${PACK}/terms/${profile.pins.terms}.yaml`, "utf8")) as { terms: unknown[] };
const manifest = JSON.parse(readFileSync(`${PACK}/MANIFEST.json`, "utf8")) as { files: Record<string, string> };

const expected = {
  properties: profile.properties.length,
  members: new Set(profile.properties.flatMap((p) => p.members)).size,
  routes: 3,
  terms: terms.terms.length,
  "code-lists": profile.pins.code_lists.length + 1,
  files: Object.keys(manifest.files).length,
};

test.beforeEach(async ({ page }) => {
  await page.goto("/#profile");
});

test("counts on the screen match the pinned files", async ({ page }) => {
  for (const [id, value] of Object.entries(expected)) {
    await expect(page.getByTestId(`profile-count-${id}`).locator("strong")).toHaveText(String(value));
  }
  await expect(page.getByTestId("profile-property")).toHaveCount(24);
  await expect(page.getByTestId("source-status")).toHaveCount(24);
  await expect(page.getByTestId("stand-in-banner")).toBeVisible();
});

test("finds a property by its ID and shows its definition", async ({ page }) => {
  const target = profile.properties[9];
  await page.getByLabel("Find a property").fill(target.id);
  const rows = page.getByTestId("profile-property");
  await expect(rows).toHaveCount(1);
  await rows.first().locator("summary").click();
  await expect(rows.first()).toContainText("Definition");
  await expect(rows.first()).toContainText(target.labels.en);
});

test("shows German and sector labels without mixing the sector into the language tag", async ({ page }) => {
  const withContext = profile.properties.find((p) => p.context_labels?.some((l) => l.lang === "de"))!;
  const label = withContext.context_labels!.find((l) => l.lang === "de")!;
  const row = page.locator(`[data-testid="profile-property"][data-id="${withContext.id}"] .profile-label`);
  await page.getByLabel("Language").selectOption("de");
  await expect(row).toHaveText(withContext.labels.de);
  await expect(row).toHaveAttribute("lang", "de");
  await page.getByLabel("Sector").selectOption(label.context);
  await expect(row).toHaveText(label.text);
  await expect(row).toHaveAttribute("lang", "de");
});
