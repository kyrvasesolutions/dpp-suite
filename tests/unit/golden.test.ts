// @vitest-environment node
/**
 * Cycle 4: golden files (AT-S). The three outputs and the manifest for the clean stand-in pair are compared with the
 * files in tests/golden/: their sha256 and their full text (for the PDF, the text pdfjs-dist extracts from it).
 * The golden files come from the public stand-in pack only. `npm run golden -- --write` rewrites them; it never runs in CI.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pdfText } from "../support/pdfText";
import { releaseFor } from "../support/release";

const DIR = "tests/golden";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function current() {
  const { release } = await releaseFor();
  const file = (route: string) => release.files.find((f) => f.route === route)!;
  const pdf = file("customer-pdf");
  const text = {
    "erp-staging.csv": new TextDecoder().decode(file("erp-staging-csv").bytes),
    "registry-draft.json": new TextDecoder().decode(file("registry-prep-json").bytes),
    "release-manifest.json": release.manifestFile.text,
    "customer-sheet.txt": `${await pdfText(pdf.bytes)}\n`,
  };
  const digests = {
    "customer-pdf": sha(pdf.bytes),
    "erp-staging-csv": sha(file("erp-staging-csv").bytes),
    "registry-prep-json": sha(file("registry-prep-json").bytes),
    "release-manifest": release.manifestFile.sha256,
  };
  return { text, digests };
}

describe("golden files (AT-S)", () => {
  it.runIf(process.env.GOLDEN_WRITE === "1" && !process.env.CI)("rewrites the golden files", async () => {
    const { text, digests } = await current();
    mkdirSync(DIR, { recursive: true });
    for (const [name, body] of Object.entries(text)) writeFileSync(`${DIR}/${name}`, body);
    writeFileSync(`${DIR}/digests.json`, `${JSON.stringify(digests, null, 2)}\n`);
  });

  it("matches the golden digests and texts for the clean pair", async () => {
    const { text, digests } = await current();
    expect(digests).toEqual(JSON.parse(readFileSync(`${DIR}/digests.json`, "utf8")));
    for (const [name, body] of Object.entries(text)) expect(body, name).toBe(readFileSync(`${DIR}/${name}`, "utf8"));
  });

  it("states the clean pair's decisive facts in the golden texts", () => {
    const csv = readFileSync(`${DIR}/erp-staging.csv`, "utf8");
    const json = JSON.parse(readFileSync(`${DIR}/registry-draft.json`, "utf8"));
    const manifest = JSON.parse(readFileSync(`${DIR}/release-manifest.json`, "utf8"));
    expect(csv.split("\n")).toHaveLength(3);
    expect(json).toMatchObject({ status: "HOLD", submission: "never" });
    expect(manifest.outputs.map((o: { route: string; status: string }) => `${o.route}:${o.status}`)).toEqual(["customer-pdf:ready", "erp-staging-csv:ready", "registry-prep-json:hold"]);
    expect(manifest.software).toEqual({ name: "dpp-traceability", version: "0.0.0-golden", commit: "golden" });
  });
});
