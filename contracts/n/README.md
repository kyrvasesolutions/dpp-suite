# N contract pack: public stand-in (narrow demonstrator D03a, aluminium sheet)

Frozen inputs that every N function slice is checked against (plan workbook rev12, work package N01;
assessment criterion C0-01).

**Status: FROZEN, stand-in.** By decision D1-01 (option b), the filled contract pack and the specification
package it comes from are kept outside this public repository. This directory holds a **synthetic stand-in**
with the same structure, so CI checks the real rules on every change:

- 24 business properties with definitions, units, EN/DE labels, requiredness per route and nested members;
- both input contracts (ERP CSV extract, laboratory/assessment JSON) with columns, code lists and a JSON Schema;
- the field lists of the three routes, with the standing HOLD on the registry route;
- the actor/field matrix;
- the 13 synthetic failure classes, each with its fixture in `fixtures/n/`.

The stand-in uses identifiers ALU-D101 to ALU-D124, stand-in definitions under `urn:dpp-demo:standin:term:`
and stand-in values for confidential code lists. It must not be read as the customer's profile.

## Files

| Path | What it holds |
|---|---|
| `MANIFEST.json` | The sha256 of every file. Written only by `npm run check-contracts -- --write` |
| `profile/PROFILE-ALU-24-01@1.0.0.yaml` | The fixed profile: 24 business properties, release and context metadata, and the exact pins of every file below |
| `terms/ALU-TERMS@1.0.0.yaml` | Governed terms: the definition behind every `definition_ref` and nested member (C1-04) |
| `code-lists/*@1.0.0.csv` | Company code lists, one editable file each (C1-03); `SECTOR` holds the sectors that labels can be specific to (C1-05) |
| `legal/ALU-LEGAL@1.0.0.yaml` | The illustrative legal requirement and source-status label of each property, linked to the regulatory chain (C1-06) |
| `units/UNITS@1.0.0.yaml` | Units in use and the conversions the mappings need (none) |
| `inputs/erp-extract.csv.contract.yaml` | ERP extract as CSV: encoding, delimiter, columns, code lists, units |
| `inputs/lab-assessment.contract.yaml` | Laboratory and assessment file as JSON: JSON Schema, allowed units, footprint rule |
| `routes/*.yaml` | The three recipient routes and their fields |
| `policy/actor-field-matrix.csv` | Property × route → `permit`, `deny` or `derived` |
| `failure-cases/*.yaml` | One synthetic failure class each, with the criterion that tests it, the expected outcome and its fixture |

## Checking

```bash
npm run check-contracts -- --require-frozen
```

Any change to a frozen file changes its digest and fails the check until the manifest is rewritten with
`--write`, which makes the change visible in review. The private pack is checked the same way with
`--pack <its directory>`.

To change a code list, edit its CSV file, then run `npm run check-contracts -- --write`: the file keeps its
name and version, gets a new digest, and the new manifest digest needs a new owner signature.

The app embeds this pack at build time (`virtual:contract-pack`, see `vite.config.ts`), runs the checker
first so an invalid pack fails the build, and verifies every digest again when the Profile screen loads it.
