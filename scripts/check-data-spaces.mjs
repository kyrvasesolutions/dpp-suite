// Checks src/model/dataSpaces.ts against the Catena-X Library.
//
//   npm run check-data-spaces
//
// Every standard must still be published in the version recorded, and every source a
// step to join rests on must still open. A failure usually means a new release: read
// what changed, then update the catalogue. The Library's pages say which release they
// show, so the check also fails if a standard's page is no longer the current one.
import { DATA_SPACE_STANDARDS, JOIN_STEPS } from "../src/model/dataSpaces.ts";

const page = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

const failures = [];

for (const s of DATA_SPACE_STANDARDS) {
  try {
    const html = await page(s.url);
    const title = html.match(/<title[^>]*>([^<]*)/)?.[1] ?? "";
    if (!title.includes(s.title)) failures.push(`${s.ref}: recorded "${s.title}", page says "${title}"`);
    if (!html.includes("(Current)")) failures.push(`${s.ref}: page is not marked as the current release`);
  } catch (error) {
    failures.push(`${s.ref}: ${error.message} at ${s.url}`);
  }
}

for (const url of new Set(JOIN_STEPS.map((s) => s.url))) {
  try {
    await page(url);
  } catch (error) {
    failures.push(`Step source: ${error.message} at ${url}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`All ${DATA_SPACE_STANDARDS.length} standards are current, and the sources of ${JOIN_STEPS.length} steps open.`);
