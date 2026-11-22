# ADR-0002: Deterministic contract testing and three-layer verification

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

As the platform scales from the narrow demonstrator to broader production increments (durable storage, identity/access control, external connectors, verifiable credentials, and registry submission), relying solely on post-implementation manual checks or conversational LLM walkthroughs catches specification mismatches too late and is not repeatable after every contract change.

## Decision

Adopt a **three-layer, deterministic-first verification architecture**, reserving LLM-based review for semantic gaps that executable rules cannot encode:

1. **Layer 1 — Static plan, contract, and traceability checks.**
   - Machine-checkable contract rules (`scripts/check-contracts.mjs`, `scripts/check-fixtures.mjs`, `tests/unit/acceptanceCoverage.test.ts`, and local traceability verification) enforce structural completeness, exact version/digest pins, unit consistency, and ID cross-references deterministically.
   - For future increments beyond the narrow demonstrator, extend Layer 1 with ontology/graph constraint checks (RDF + SHACL/SPARQL) over a formal data-item catalogue before implementation begins.
2. **Layer 2 — Pre-implementation deterministic contract simulation (for post-demonstrator increments).**
   - The narrow demonstrator is already implemented and verified against live code (`p95 < 10 ms` in Node), so building a stub simulator retroactively for it is skipped to avoid rework.
   - For subsequent production increments, simulate multi-component use cases deterministically using typed contracts, stubs that carry record identifiers and provenance lists (preventing canned-data false passes), and drop-one-input checks **before** writing implementation code.
   - **Fix-the-spec rule:** a failing contract check is resolved by updating the specification/contract with a recorded decision — never by loosening a contract or weakening a test merely to pass.
3. **Layer 3 — Deterministic implementation, mutation, and negative testing.**
   - **Contract tightness (`tests/unit/contractTightness.test.ts`):** programmatically drop every required profile property, required ERP CSV column, and required laboratory JSON key one at a time to prove every route/ingress contract breaks as expected; mutate scalar and derived inputs to prove outputs change live (anti-canned-data); verify 100% lineage continuity across multi-version histories.
   - **Codified adversarial mutations (`tests/unit/adversarialMutations.test.ts`):** preserve repeatable adversarial probes (canary leak scans across logs and outputs, formula/separator injection via corrections, unauthorized/silent-correction refusals, hostile byte/depth/row/deadline limits) as permanent unit regression tests.
   - **Three-route UI acceptance suite (`tests/acceptance/`):** run every failure class and positive/reproducibility/scan scenario through the production UI against all three routes, mapped in `tests/acceptance/coverage.json`.
   - **Independent review:** pair deterministic suites with fresh-context independent review (and cross-model independence where simulated personas are used) strictly for semantic/usability properties that rules cannot verify.

## Consequences

- Tests prove they can fail rather than passing by construction, while staying fast in CI.
- Adversarial findings discovered during review become permanent deterministic regressions.
- Verification reports explicitly state what passing tests **do not** prove (e.g., real standard limits, cryptographic signing, server-side concurrency/authentication, or legal conformity).
