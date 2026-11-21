/**
 * Checks the production build in dist/ for egress controls (criterion C0-07, baseline finding B0-03):
 * the page carries the content security policy, and no browser LLM client is bundled unless the build
 * was made with VITE_ENABLE_LLM=true. Run after `npm run build`.
 *
 * It also refuses a build that embeds any contract pack other than the public stand-in in contracts/n
 * (decision D1-01, option b), so a local build made with DPP_CONTRACT_PACK can't be published by mistake.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const FORBIDDEN = ["dangerouslyAllowBrowser", "api.anthropic.com"];
const errors = [];

if (!existsSync(join(DIST, "index.html"))) {
  console.error("check-bundle: dist/index.html is missing; run npm run build first");
  process.exit(1);
}

const html = readFileSync(join(DIST, "index.html"), "utf8");
const csp = html
  .match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1]
  ?.replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&");
const allow = JSON.parse(readFileSync("config/egress-allowlist.json", "utf8"));
const expectedConnect = `connect-src ${["'self'", ...allow.connect].join(" ")}`;
if (!csp) errors.push("index.html has no Content-Security-Policy meta tag");
else if (!csp.split(";").map((d) => d.trim()).includes(expectedConnect)) {
  errors.push(`expected "${expectedConnect}" in the policy, found: ${csp}`);
}

if (process.env.VITE_ENABLE_LLM !== "true") {
  const assets = join(DIST, "assets");
  for (const file of readdirSync(assets).filter((f) => f.endsWith(".js"))) {
    const text = readFileSync(join(assets, file), "utf8");
    for (const s of FORBIDDEN) if (text.includes(s)) errors.push(`${file} contains "${s}" although VITE_ENABLE_LLM is not true`);
  }
}

const packs = new Set();
for (const file of readdirSync(join(DIST, "assets")).filter((f) => f.endsWith(".js"))) {
  for (const m of readFileSync(join(DIST, "assets", file), "utf8").matchAll(/\bpackDir"?\s*:\s*["'`]([^"'`]*)["'`]/g)) packs.add(m[1]);
}
if (packs.size === 0) errors.push("no contract pack is embedded in the bundle");
for (const p of packs) if (p !== "contracts/n") errors.push(`the bundle embeds the contract pack ${p}; only contracts/n may be published`);

if (errors.length) {
  for (const e of errors) console.error(`check-bundle: ${e}`);
  process.exit(1);
}
console.log("Bundle OK: content security policy present, no browser LLM client, public contract pack only.");
