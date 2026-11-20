# N contract pack (narrow demonstrator D03a, aluminium sheet)

Frozen inputs that every N function slice is checked against (plan workbook rev12, work package N01;
assessment criterion C0-01).

**Status: HOLD.** The content of PROFILE-ALU-24-01 v1.0.0 (the 24 business properties and their nested
members), the column and field lists of the two input contracts, the fields of the three routes and the
actor/field matrix are defined in the v0.5 specification package, which is not in this repository. The
workbook names that package but holds no definitions: it references only 18 of the property identifiers
(ALU-D001, 002, 004, 005, 014, 015, 019 to 022, 025, 026, 035, 036, 043 to 046), so the profile can't be
rebuilt from it. Nothing here may be invented; each `pending` field is filled from the package and then
signed off by the owner.

What is already final, because it doesn't depend on the property content:

- the structure of the pack and the keys each file must have (checked by `npm run check-contracts`);
- the three routes, their recipients and formats, and the HOLD on the registry route;
- the strict ingress rules of both inputs (stages, rejection of duplicate keys and non-finite numbers);
- the synthetic failure classes, each tied to the criterion that tests it.

## Files

| Path | What it holds |
|---|---|
| `MANIFEST.json` | Pack status, hold reason and the sha256 of every file. Written only by `npm run check-contracts -- --write` |
| `profile/PROFILE-ALU-24-01@1.0.0.yaml` | The fixed profile: 24 business properties with definition, unit, EN/DE labels, requiredness per route, nested members |
| `inputs/erp-extract.csv.contract.yaml` | ERP extract as CSV: encoding, delimiter, columns, code lists, units |
| `inputs/lab-assessment.contract.yaml` | Laboratory and assessment file as JSON: structure, units, footprint context |
| `routes/*.yaml` | The three recipient routes and their fields |
| `policy/actor-field-matrix.csv` | Recipient × property → `permit`, `deny` or `derived` |
| `failure-cases/*.yaml` | One synthetic failure class each, with the criterion that tests it and the expected outcome |

## Freezing the pack

1. Fill every `pending` value from the v0.5 package; keep its identifiers.
2. Set `status: FROZEN` in the profile, both inputs, the routes and the matrix header comment.
3. Run `npm run check-contracts -- --write`, then `npm run check-contracts`. With status FROZEN the
   checker enforces the full rules (24 properties, unique IDs, EN and DE labels, definitions, route fields
   inside the profile, a matrix row for every property).
4. The owner signs the manifest digest (criterion C0-01); customer approval of the subset, the PDF
   audience and the disclosure rules is recorded for C0-02.

Any later change to a frozen file changes its digest and fails the check until the manifest is rewritten,
which makes the change visible in review.
