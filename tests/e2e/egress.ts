import { test as base, expect } from "@playwright/test";
import allow from "../../config/egress-allowlist.json" with { type: "json" };

/**
 * Every end-to-end test fails if the app requests an origin outside its own and the egress allow-list,
 * or if the browser reports a content security policy violation (LEAN-DEF-13; criterion C0-07).
 * Requests are watched on the whole browser context, so service-worker fetches count as well as the page's.
 * The policy blocks most foreign requests before they are sent, so the violation check is what catches them.
 */
export const test = base.extend({
  page: async ({ page, context, baseURL }, use) => {
    const allowed = new Set([new URL(baseURL!).origin, ...allow.connect]);
    const foreign: string[] = [];
    const violations: string[] = [];

    context.on("request", (request) => {
      const url = new URL(request.url());
      if (url.protocol.startsWith("http") && !allowed.has(url.origin)) foreign.push(request.url());
    });
    await page.exposeBinding("__reportCspViolation", (_source, text: string) => violations.push(text));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        (window as unknown as { __reportCspViolation: (t: string) => void }).__reportCspViolation(
          `${e.violatedDirective} blocked ${e.blockedURI || "inline"} at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`,
        );
      });
    });

    await use(page);

    expect(foreign, "requests outside the egress allow-list").toEqual([]);
    expect(violations, "content security policy violations").toEqual([]);
  },
});

export { expect };
