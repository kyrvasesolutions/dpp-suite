# Contract pack (synthetic public stand-in)

This directory contains a frozen, digest-pinned **synthetic stand-in contract pack** used for
continuous integration and public demonstrations. It mirrors the 24-property structure, source
contracts, mapping contracts, disclosure policy, readiness rules, and operational limits while using
generic stand-in identifiers (`ALU-D101` to `ALU-D124`) and synthetic party codes.

## Contents

- `MANIFEST.json` — SHA-256 digest of every file in the pack (rewritten only via `npm run check-contracts -- --write`).
- `profile/PROFILE-ALU-24-01@1.0.0.yaml` — 24 business properties, typed value classes, units, EN/DE labels, route requiredness, and exact version pins.
- `contracts/*.json` / `contracts/context.jsonld` — pinned source/export mappings, record schema, inline JSON-LD context, code list, and recipient policy.
- `inputs/` — comma-delimited ERP CSV extract contract (`SRC-ERP-CSV-01`) and laboratory JSON contract (`SRC-LAB-JSON-01`).
- `routes/` — `customer`, `internal`, and held `registry` (`TARGET_PROFILE_UNCONFIRMED`, `submission: never`) route contracts.
- `policy/` — actor/field matrix, readiness rules, derived disclosure rules (`recycled_total_with_basis`, `lead_screening`), input limits, operational limits, retention profile, and data-quality exception catalogue.
- `terms/`, `units/`, `legal/`, `code-lists/` — governed terms, units and conversions (`mm` to `m`), illustrative legal links, and editable code lists.
- `failure-cases/` — synthetic negative test cases linked to `fixtures/n/`.

## Verification

```bash
npm run check-contracts -- --require-frozen --require-signed
```

`contracts/SIGNATURES.json` records owner digest approval (pinned SHA-256 of `MANIFEST.json`; not cryptographic signing).
