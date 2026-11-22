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
   - The browser application remains the operator UI, and the server also serves the built application (`dist/`) on its own origin, so the browser's `connect-src 'self'` policy needs no exception. When the application finds the server on its own origin (`GET /api/health` answers JSON), `src/model/recordStore.tsx` reads the central record from the server and sends each import to it as a staged job (`POST /api/jobs/import`, JSON with base64 files), and operator corrections go to `POST /api/records/:model/:batch/correct`. The browser still parses the files for the Import screen's display; the server runs the strict ingress again from the uploaded bytes and is the system of record. Release files, exports and the PDF are still produced in the browser from the record it reads. Restoring a central-record file into the store is refused while a server holds the records, because snapshots are written only by jobs and corrections. When no server answers (static builds such as GitHub Pages), the application falls back to browser IndexedDB with no network request beyond the probe.
   - `server/` code and `node:*` built-in imports never enter the Vite browser bundle (`dist/`), enforced by `scripts/check-bundle.mjs`.

2. **Relational persistence via `DbAdapter` + built-in `node:sqlite` (WAL mode).**
   - All SQL access goes through a minimal synchronous/transactional `DbAdapter` interface (`server/db/adapter.ts`) designed so a PostgreSQL adapter can later replace SQLite without changing repository, job, or policy code.
   - The default implementation (`SqliteAdapter`) uses Node 24's built-in `node:sqlite` (`DatabaseSync`) with `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, `PRAGMA busy_timeout = 5000`, `BEGIN IMMEDIATE` serializable write transactions, and hot file backups (`VACUUM INTO`). This introduces **zero new production npm dependencies**.
   - Schema changes are governed by versioned forward (`up`) and backward (`down`) SQL migrations (`server/db/migrations.ts`) verified for round-trip checksum integrity. An applied migration is never edited (a test freezes the checksums of v1 and v2); a change is a new migration. A rollback refuses to drop a table that still holds retained or legal-hold evidence, snapshots or receipts.

3. **Time-envelope, domain-scoped relational schema.**
   - Every persisted snapshot and event is scoped by `security_domain` alongside `(model, batch, version)` so records and event identities remain unambiguous across domains.
   - Snapshots store distinct temporal fields (`recorded_at`, `observed_at`, `declared_at`, `published_at`, `valid_from`, `valid_to`) using half-open validity intervals `[valid_from, valid_to)` and append-only digest chains (`supersedes_version`, `supersedes_digest`, `record_digest`, `snapshot_digest`).
   - Transactional commits enforce optimistic expected-version checks inside `BEGIN IMMEDIATE` transactions so concurrent operators cannot lose or duplicate assertions.

4. **Recoverable staged import jobs (`received → classified → validated → staged → committed | rolled_back | failed`).**
   - `server/jobs/importJobRunner.ts` persists every stage transition and payload digest in `import_jobs` and `job_events`, keyed by `(security_domain, idempotency_key)`.
   - The key is claimed atomically: one `INSERT ... ON CONFLICT DO NOTHING` inside a `BEGIN IMMEDIATE` transaction decides who owns `(security_domain, idempotency_key)` together with the digest of what was sent (both file digests and the dataset). A duplicate with the same payload waits for the running job (or replays the committed one) and gets the same result; a duplicate with a different payload is refused with a conflict (HTTP 409). Every stage transition is guarded by `state = 'running'` and the claimed digest, so a job that was rolled back, taken over or committed meanwhile cannot be moved again. A database constraint that fires is a 409, never a 500.
   - Repeating a job with the same idempotency key after a failure or crash either cleanly resumes from durable staged state or atomically rolls back any partial work, leaving zero orphaned snapshots, evidence rows, or log entries.
   - Recovery touches only jobs that are not executing: a job running in this process is left alone, and a job last touched by another process is left alone until its lease (60 s) ends. Server start-up recovers everything still running, on the stated assumption that one server process uses the data file.
   - Deterministic crash-injection hooks allow tests to fail execution at every pipeline stage and verify recovery across database restarts. `after-stage` stops with the payload durable and no commit started; `before-commit` stops inside the commit transaction after every row is written, so the whole commit rolls back.

5. **Pinned classification, retention, and data-quality exception contracts.**
   - A new pinned contract pack file `policy/RETENTION@1.0.0.yaml` defines dataset confidentiality classifications (`public`, `internal`, `restricted`; unclassified defaults to `restricted`), default retention horizons (10 years / 3650 days for snapshots and evidence), and legal-hold override rules.
   - The server refuses to ingest or store payloads unless an active pinned retention policy is loaded and applied first.
   - A retention policy is activated only as loaded from the verified contract pack (the object must come out of the pack loader with its content digest intact); different content under a pin the database already holds is refused.
   - Content-addressed evidence rows (`evidence_store`) verify SHA-256 digests on write and reject deletion prior to `retention_until` or while `legal_hold` is active. Retention is judged on the server clock only: the API accepts no caller time, and a SQL `BEFORE DELETE` trigger refuses a delete inside the horizon or under a hold using the database's own clock, so even a raw `DELETE` cannot bypass it; a second trigger keeps every column but the legal-hold flag immutable. Releasing a legal hold is refused over the API until operators are authenticated (placing one is allowed).
   - The server assigns `recordedAt`, the anchor of every retention horizon. A caller may state only `observedAt`, `declaredAt` and `validFrom`, within bounds (not before 2000-01-01, not more than five minutes ahead of the server); its `recordedAt`, `publishedAt` and `validTo` are ignored. An import job accepts only the two input datasets (`erp-extract`, `lab-assessment`), and a lab file is classified at least as strictly as `lab-assessment`.
   - A pinned data-quality exception catalogue (`policy/EXCEPTIONS@1.0.0.yaml`) and accompanying fixtures document and test representative customer onboarding anomalies (BOM, CRLF, whitespace, decimal comma, unknown codes, duplicates, unattached batches, missing digests, non-WinAnsi characters, and unclassified payloads). The fixtures are ARTIFICIAL-DEMO data written to represent those anomalies; they are not samples of real customer data, and real customer exception samples remain an open pre-production hold.

6. **Local-only default binding and OIDC-ready request context.**
   - The HTTP server (`server/http/api.ts`) binds to `127.0.0.1` by default, makes zero outbound network calls, sets strict security headers, and extracts an explicit request principal context ready for server-side OIDC authentication and RBAC enforcement in the next increment. There is no authentication yet, so it must stay on the local machine.
   - Its boundary is closed to web pages: the `Host` header must be a loopback name or the bound host (DNS rebinding), an `Origin` must be the server itself or an explicitly configured origin (no wildcard, no CORS headers otherwise), every POST must be `application/json`, and there is no raw snapshot or log write endpoint: snapshots are written only by import jobs and corrections, log entries only by the server.

## Consequences

- Multi-operator imports and corrections are serialized atomically with zero lost or duplicated assertions, including the same idempotency key sent concurrently.
- Pipeline crashes at any stage recover cleanly on restart without manual database repair.
- Evidence retention and confidentiality rules are enforced declaratively from the signed contract pack before any customer data is stored.
- Zero new production dependencies are added, preserving the licence allow-list and vulnerability posture.
- Static browser deployments continue to work unchanged via the IndexedDB fallback.
- The `node:sqlite` module is still marked experimental in Node 24 and prints a warning at start-up; the adapter boundary is what makes a later PostgreSQL swap possible.
- Open until their exits: authentication and authorisation (Cycle 7), load and security hardening (Cycle 8), a restore drill (Cycle 9), and real customer file contracts, limits and exception samples before any real data is held.
