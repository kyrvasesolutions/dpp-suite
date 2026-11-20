# N fixture pack (synthetic aluminium D03a inputs)

**Status: HOLD.** The synthetic ERP CSV extract and laboratory/assessment JSON for the D03a scenario, and
one input per failure class in `contracts/n/failure-cases/`, are built once the N contract pack is frozen
(C0-01). They must follow the frozen input contracts and contain no real customer data (LEAN-DEF-12).

`src/model/sampleData.ts` stays a demonstration file for the Mapping tab; it is not the D03a contract.

Add files here, then run `npm run check-fixtures -- --write` and commit the updated `MANIFEST.json`.
Tests read fixtures only through `tests/support/fixtures.ts`, which refuses a file whose digest doesn't match.
