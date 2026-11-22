# ADR-0001: Browser-only deterministic pipeline and dual contract packs

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

The DPP traceability demonstrator processes two fixed source files (an ERP CSV extract and a laboratory/assessment JSON file) for one product record and generates three recipient-specific outputs (Customer PDF, internal ERP staging CSV, and a held Registry preparation JSON draft) with strict disclosure control, zero network egress, and deterministic reproducibility. Because the repository is public, real or confidential specification content must stay outside version control while CI and the public deployment still verify the full structure and behaviour.

## Decision

1. **Browser-only execution with zero egress.** The application runs entirely in the browser (React 19, Vite, IndexedDB `dpp-trace`, in-browser SQLite via `sql.js`), governed by a strict Content Security Policy (`config/csp.ts`), an empty egress allow-list (`config/egress-allowlist.json`), jitless `zod` (`src/zodConfig.ts` imported first), and an off-by-default LLM flag (`VITE_ENABLE_LLM=false`).
2. **Staged four-step data flow (`source → record → route → output`).**
   - `src/model/ingress.ts` and `src/model/strictJson.ts` parse inputs strictly against pinned contracts and declared limits (`policy/LIMITS@1.0.0.yaml`), preserving verbatim source assertions and locations.
   - `src/model/recordRepository.ts` maintains append-only versioned snapshots; `src/model/centralRecord.ts` provides lossless portable export and re-checked import.
   - `src/model/policy.ts` (`decide`) is the single Policy Decision Point reading the actor/field matrix; `src/model/disclosure.ts` (`project`) is the single Policy Enforcement Point; `src/model/readiness.ts` (`assess`) computes deterministic route readiness and traceable holds.
   - `src/model/outputs/` builds all outputs exclusively from `project()`, refusing on-hold routes (Customer PDF and ERP CSV) and keeping Registry JSON as an unsubmitted `HOLD` draft (`"submission": "never"`). The Customer PDF uses `pdf-lib` (standard Helvetica, no embedded font, WinAnsi guard, no date/producer metadata) for byte-identical determinism.
3. **Dual contract pack with exact pins and signatures.** Contract packs and fixtures are generated from a single local source and verified by `scripts/check-contracts.mjs --require-frozen --require-signed` against `contracts/SIGNATURES.json`. Code in `src/` never hard-codes property identifiers; properties are resolved by definition slug so the same code works with both the public stand-in pack and a private pack.
4. **Public repository documentation scope.** Tracked public documentation consists solely of `CHANGELOG.md` and `adr/*.md`. Assessment records, operator guides, private specifications, and working notes remain local and git-ignored.

## Consequences

- Every pull request is verified in CI against a frozen, signed stand-in pack without exposing private specification files.
- Outputs are reproducible across runs and machines; export timestamps live exclusively in `manifest.generated` outside every digest (`substantiveDigest`).
- Server-side identity, cryptographic signing, real standard limit tables, licensed font embedding, and durable multi-user storage are explicitly deferred to subsequent production increments.
