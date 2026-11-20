/** Every screen states its capability label (assessment criteria §2.3, shared criterion Cn-G3). */
import { CAPABILITIES, CAPABILITY_TEXT } from "../../src/model/capabilities.ts";
import { expect, test } from "./egress";

for (const capability of CAPABILITIES) {
  test(`${capability.name} shows exactly one capability label: ${capability.label}`, async ({ page }) => {
    await page.goto(`/#${capability.id}`);
    const badge = page.getByTestId("capability-badge");
    await expect(badge).toHaveCount(1);
    await expect(badge).toHaveAttribute("data-label", capability.label);
    await expect(badge.locator(".capability-label")).toHaveText(CAPABILITY_TEXT[capability.label]);
  });
}
