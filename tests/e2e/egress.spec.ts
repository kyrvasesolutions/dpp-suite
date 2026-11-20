/** Egress control of the built app (criterion C0-07, baseline finding B0-03). */
import { test as plain } from "@playwright/test";
import { CONTENT_SECURITY_POLICY } from "../../config/csp.ts";
import { expect, test } from "./egress";

test("the built page carries the content security policy", async ({ page }) => {
  await page.goto("/");
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(csp).toBe(CONTENT_SECURITY_POLICY);
  expect(csp).toContain("connect-src 'self'");
});

// Without the guard, so the test can observe the browser itself: the policy must refuse the request before
// it is sent. Without the policy, the request would be sent (and fail to resolve), and this test fails.
plain("the content security policy stops a request to another origin before it is sent", async ({ page, context }) => {
  const sent: string[] = [];
  context.on("request", (r) => {
    if (r.url().includes("egress-probe.invalid")) sent.push(r.url());
  });
  await page.goto("/#requirements");
  const violation = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        document.addEventListener("securitypolicyviolation", (e) => resolve(e.violatedDirective), { once: true });
        fetch("https://egress-probe.invalid/").catch(() => undefined);
        setTimeout(() => resolve("no violation"), 2000);
      }),
  );
  expect(violation).toBe("connect-src");
  expect(sent, "the request must not leave the page").toEqual([]);
});

test("negative control: the guard fails a test that requests another origin", async ({ page }) => {
  // Expected to fail inside the guard. `.invalid` never resolves, so nothing leaves the machine.
  test.fail();
  await page.goto("/#requirements");
  await page.evaluate(() => fetch("https://egress-probe.invalid/").catch(() => undefined));
});
