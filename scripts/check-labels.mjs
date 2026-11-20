// Checks that the source of each consumer label in src/model/consumerLabels.ts still opens.
//
//   npm run check-labels
//
// Fails when a page is gone. Some scheme sites refuse automated requests, so an
// answer of 202, 403 or 429 is listed to check by hand rather than failing the run.
import { CONSUMER_LABELS } from "../src/model/consumerLabels.ts";

const BLOCKED = new Set([202, 403, 429]);
const USER_AGENT = "Mozilla/5.0 (compatible; dpp-validator-check-labels/0.1)";

const failures = [];
const blocked = [];

for (const label of CONSUMER_LABELS) {
  try {
    const res = await fetch(label.url, { headers: { "User-Agent": USER_AGENT } });
    if (BLOCKED.has(res.status)) blocked.push(`${label.short}: HTTP ${res.status} at ${label.url}`);
    else if (!res.ok) failures.push(`${label.short}: HTTP ${res.status} at ${label.url}`);
  } catch (error) {
    failures.push(`${label.short}: ${error.message} at ${label.url}`);
  }
}

if (blocked.length) console.log(`Refused automated requests, check by hand:\n${blocked.join("\n")}\n`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`${CONSUMER_LABELS.length - blocked.length} of ${CONSUMER_LABELS.length} label sources open.`);
