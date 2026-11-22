# ADR-0004: Durable relational storage, staged job recovery, and retention policy

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

The narrow demonstrator stored snapshots and execution logs solely in browser IndexedDB (`ADR-0001`). While sufficient for a single-browser local demonstrator, browser storage cannot satisfy bounded production requirements:

- Concurrent operators on separate sessions cannot share one transactional record store without lost updates or duplicated assertions.
- An import interrupted mid-pipeline inside React memory cannot be recovered, resumed, or atomically rolled back.
- Evidence payloads and record snapshots need content-addressed integrity verification, confidentiality classification, and enforceable retention horizons (including legal-hold protection) applied **before** customer data is accepted.
- Downstream server-side authentication, access enforcement, and backup/restore drills require a durable relational server store.

At the same time, the shared pure domain engine (`src/model/`) must not be forked between browser and server, production npm dependencies should remain minimal and audited, and static browser previews (such as GitHub Pages) must keep functioning with the local IndexedDB fallback.

## Decision

1. **Shared pure domain core, thin Node 24 API service (`server/`).**
   - `server/` executes the exact same pure TypeScript domain modules (`src/model/ingress.ts`, `correction.ts`, `policy.ts`, `disclosure.ts`, `readiness.ts`, `derived.ts`, `lineage.ts`, `outputs/*`, `centralRecord.ts`, `classification.ts`). No domain rules are duplicated.
   - The browser application remains the operator UI. When configured with an API base URL (`VITE_API_BASE`), `src/model/recordStore.tsx` routes persistence and job execution through the server API; when unconfigured (static builds), it transparently falls back to browser IndexedDB.
   - `server/` code and `node:*` built-in imports never enter the Vite browser bundle (`dist/`), enforced by `scripts/check-bundle.mjs`.

2. **Relational persistence via `DbAdapter` + built-in `node:sqlite` (WAL mode).**
   - All SQL access goes through a minimal synchronous/transactional `DbAdapter` interface (`server/db/adapter.ts`) designed so a PostgreSQL adapter can later replace SQLite without changing repository, job, or policy code.
   - The default implementation (`SqliteAdapter`) uses Node 24's built-in `node:sqlite` (`DatabaseSync`) with `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, `PRAGMA busy_timeout = 5000`, `BEGIN IMMEDIATE` serializable write transactions, and hot file backups (`VACUUM INTO`). This introduces **zero new production npm dependencies**.
   - Schema changes are governed by versioned forward (`up`) and backward (`down`) SQL migrations (`server/db/migrations.ts`) verified for round-trip checksum integrity.

3. **Time-envelope, domain-scoped relational schema.**
   - Every persisted snapshot and event is scoped by `security_domain` alongside `(model, batch, version)` so records and event identities remain unambiguous across domains.
   - Snapshots store distinct temporal fields (`recorded_at`, `observed_at`, `declared_at`, `published_at`, `valid_from`, `valid_to`) using half-open validity intervals `[valid_from, valid_to)` and append-only digest chains (`supersedes_version`, `supersedes_digest`, `record_digest`, `snapshot_digest`).
   - Transactional commits enforce optimistic expected-version checks inside `BEGIN IMMEDIATE` transactions so concurrent operators cannot lose or duplicate assertions.

4. **Recoverable staged import jobs (`received → classified → validated → staged → committed | rolled_back | failed`).**
   - `server/jobs/importJobRunner.ts` persists every stage transition and payload digest in `import_jobs` and `job_events`, keyed by `(security_domain, idempotency_key)`.
   - Repeating a job with the same idempotency key after a failure or crash either cleanly resumes from durable staged state or atomically rolls back any partial work, leaving zero orphaned snapshots, evidence rows, or log entries.
   - Deterministic crash-injection hooks allow tests to fail execution at every pipeline stage and verify recovery across database restarts.

5. **Pinned classification, retention, and data-quality exception contracts.**
   - A new pinned contract pack file `policy/RETENTION@1.0.0.yaml` defines dataset confidentiality classifications (`public`, `internal`, `restricted`; unclassified defaults to `restricted`), default retention horizons (10 years / 3650 days for snapshots and evidence), and legal-hold override rules.
   - The server refuses to ingest or store payloads unless an active pinned retention policy is loaded and applied first.
   - Content-addressed evidence rows (`evidence_store`) verify SHA-256 digests on write and reject deletion prior to `retention_until` or while `legal_hold` is active.
   - A pinned data-quality exception catalogue (`policy/EXCEPTIONS@1.0.0.yaml`) and accompanying fixtures document and test real-world customer onboarding anomalies (BOM, CRLF, whitespace, decimal comma, unknown codes, duplicates, unattached batches, missing digests, non-WinAnsi characters, and unclassified payloads).

6. **Local-only default binding and OIDC-ready request context.**
   - The HTTP server (`server/http/api.ts`) binds to `127.0.0.1` by default, makes zero outbound network calls, sets strict security headers, and extracts an explicit request principal context ready for server-side OIDC authentication and RBAC enforcement in the next increment.

## Consequences

- Multi-operator imports and corrections are serialized atomically with zero lost or duplicated assertions.
- Pipeline crashes at any stage recover cleanly on restart without manual database repair.
- Evidence retention and confidentiality rules are enforced declaratively from the signed contract pack before any customer data is stored.
- Zero new production dependencies are added, preserving the licence allow-list and vulnerability posture.
- Static browser deployments continue to work unchanged via the IndexedDB fallback.
