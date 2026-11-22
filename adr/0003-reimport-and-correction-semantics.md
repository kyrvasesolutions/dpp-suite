# ADR-0003: Pair-attachment, re-import, and operator-correction semantics

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Operators can correct individual non-identifier, non-evidence values on the Record screen (creating a new immutable snapshot version with actor and mandatory reason) and later re-import updated ERP or laboratory files for the same `(model, batch)` record. Edge cases around partial file pairs, mismatched laboratory files, re-imports after corrections, and source-file attribution require explicit, deterministic rules so a re-import never silently discards a correction or hides a source change.

## Decision

1. **Complete attached pair before automatic versioning (`src/components/ImportView.tsx`).**
   - A snapshot version is automatically stored only when both the ERP extract and the laboratory file are accepted **and** the laboratory file attaches to the ERP record's `(model, batch)` pair (zero unattached assertions).
   - If the laboratory file describes a different model or batch, it stays unattached and nothing is stored automatically; the operator may still explicitly store an ERP-only record with an honest version label.
2. **Non-silent re-import over operator corrections (`src/model/correction.ts`).**
   - **Source unchanged** (still states what the correction replaced, and no active dispute): carry the operator correction forward onto the new version with status `corrected` (idempotent if nothing else changed).
   - **Source converged to the correction** (matches the corrected value via `sameAssertion`): confirm the correction with status `corrected`, preserving lineage to both the correction and the confirming source.
   - **Source changed to another value, or dropped the corrected value:** keep the correction and source assertion(s) (retaining the earlier source file by `sha256` when dropped), flag the source assertion `source-changed`, mark the value `challenged`, and hold dependent routes (`RR-CHALLENGED`) until the operator explicitly settles the value with a new correction.
3. **Honest attribution in the Record view (`src/components/RecordView.tsx`).**
   - Confirming source assertions matching the standing correction are displayed as *Also stated by…* rather than struck through as *Earlier*.
   - When an earlier version of a source file is retained in `record.sources` alongside a newer import of the same role, only the superseded earlier entry (appended after the incoming import's source) is annotated as an earlier file version with its `sha256`.

## Consequences

- Re-importing files can never silently overwrite an operator correction or silently accept a source omission.
- All re-import states pass `recheckRecord()` and round-trip losslessly through portable central-record export/import with deterministic field-level diffs.
- Version histories remain append-only and traceable across `v1 (import) → v2 (correction) → v3+ (re-import / settlement)`.
