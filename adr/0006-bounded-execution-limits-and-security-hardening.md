# ADR-0006: Bounded execution, job coordination, cooperative cancellation, HTTP limits, and security hardening

- **Status:** Accepted
- **Date:** 2026-11-24

## Context

Cycle 6 introduced the durable Node 24 SQLite WAL server (`ADR-0004`), and Cycle 7 added OIDC authentication, server-side RBAC with live `grant_epoch` revocation, deployment surface separation, and controlled configuration releases (`ADR-0005`). Before bounded production traffic can be served safely, the runtime must defend against resource exhaustion, hostile or superlinear inputs, accidental secret or data disclosure, vulnerable dependencies, and unintended outbound network egress.

Specifically, bounded production requires:

1. **Pinned operational budgets and explicit limit-outcome contracts** (`OVER_LIMIT`, `TIMEOUT`, `CANCELLED`) so callers receive deterministic, non-partial outcomes instead of unhandled crashes or silent truncation.
2. **Per-security-domain concurrency control and memory bounds** preventing one domain, one slow client, or a burst of large uploads from starving other domains or exceeding the server memory envelope.
3. **Worker-isolated ingress with cooperative and forced termination** so synchronous parsing of hostile inputs cannot block `/api/health` or evade deadlines and cancellation.
4. **Confidentiality-preserving public logging and error barriers** ensuring restricted record values, filenames, subjects, and reasons never reach stdout, stderr, crash output, or non-submitter error bodies.
5. **Runtime egress denial and LLM boundary enforcement** guaranteeing zero outbound network connections and zero confidential data sent to external LLMs.
6. **Automated security gates** in CI for secrets (tracked files and build output), dependencies with dated accepted risks, and bundle hygiene.

## Decision

1. **Pinned operational limits policy (`policy/OPERATIONAL-LIMITS@1.0.0.yaml`).**
   - Added a frozen, signed policy file alongside `LIMITS@1.0.0` (leaving `LIMITS@1.0.0` untouched for browser/narrow compatibility).
   - Pins execution budgets (`source_file_max_bytes`, `source_pair_max_bytes`, `max_nesting_depth`, `max_records_per_job`, `job_deadline_ms`, `max_parser_nodes_per_job`, `max_output_bytes_per_route`, `total_staging_max_bytes`, `execution_memory_max_bytes`, `cancellation_poll_max_ms`, `forced_termination_max_ms: 1000`, `retry_count: 0`), coordinator quotas (`max_active_jobs_per_security_domain: 2`, `max_queued_jobs_per_security_domain: 8`, `max_active_jobs_total: 4`, `retry_after_seconds: 2`, `server_record_max_bytes: 2097152`, `max_inflight_record_bytes: 4194304`), HTTP bounds (`headers_timeout_ms`, `request_timeout_ms`, `keep_alive_timeout_ms`, `body_read_timeout_ms: 10000`, `idle_socket_timeout_ms: 60000`, `max_connections: 256`, `max_request_body_bytes: 31457280`, per-subject/IP read and write rate windows), and load targets (`import_job_p95_ms`, `read_p95_ms`, `concurrent_clients`, `volume_committed_batches`, `max_server_errors`, `max_rss_bytes`, `record_bytes_typical`, `record_bytes_max`, `max_size_burst_jobs`).
   - Because in-memory staging of 20 MiB pairs exceeded the 512 MiB RSS envelope on the reference host, canonical digesting was converted to streaming (`server/store/streamDigest.ts`) and `server_record_max_bytes` was pinned to 2 MiB (holding 10-job max-size burst peak RSS under 75 % of 512 MiB). Streaming ingestion for larger files remains an explicit hosting/pre-production hold.

2. **Explicit limit-outcome contract, job coordinator, and worker-isolated cancellation (`src/model/c8Contracts.ts`, `server/jobs/jobControl.ts`, `server/jobs/ingressRunner.ts`, `server/jobs/ingressWorker.ts`).**
   - Standardized additive `outcome` (`OVER_LIMIT`, `TIMEOUT`, `CANCELLED`) and `limit` fields on refusal responses while preserving existing narrow-demonstrator error codes.
   - `JobCoordinatorModel` / `JobCoordinator` reserves per-domain slots and in-flight record-byte budget **before** reading the request body, enforces per-domain FIFO and cross-domain isolation with bounded overtaking (`OVERTAKE_LIMIT = 8`), enforces `max_queued_jobs_per_security_domain` regardless of wait reason (returning `429` + `Retry-After`), never retries automatically (`retry_count: 0`), and releases slots and bytes immediately upon reaching any terminal state (never waiting for response flush).
   - Server import ingress runs in a `node:worker_threads` worker with V8 `resourceLimits` derived from `execution_memory_max_bytes`. Deadlines (`job_deadline_ms`), client disconnects, and authenticated `POST /api/jobs/:id/cancel` (submitter or `ADMIN`, mandatory reason recorded in append-only migration `0007_cycle8_job_control`) revoke promotion permission before `BEGIN IMMEDIATE` commit and terminate the worker within `forced_termination_max_ms`, leaving zero partial commits.

3. **Bounded HTTP handling, linear parsing/outputs, and input hardening (`server/http/api.ts`, `src/model/ingress.ts`, `src/model/readiness.ts`, `src/model/lineage.ts`, `src/model/outputs/customerPdf.ts`).**
   - Removed any global serial body lane; every body read enforces `body_read_timeout_ms` (`408 TIMEOUT`), control/metadata JSON routes are capped at 256 KiB, early `413` responses drain briefly before closing, and `POST /api/jobs/import` returns a bounded summary rather than echoing the full snapshot.
   - Replaced superlinear paths across ingress, readiness, lineage, and PDF wrapping with $O(n)$ algorithms (`Metrics` glyph/kerning prefix sums in `wrap()`, `Map`/`Set` indexing in `assess()`, `project()`, `buildItems()`, and `buildLineage()`, linear UTF-8 offset scanning, linear `safeName` and `Origin` header trimming).
   - Capped free-text fields at `MAX_TEXT_FIELD_CHARS = 2000` on ingress and operator corrections, enforced a printable-ASCII NFKC-stable allow-list (`SAFE_IDENTIFIER`) for identifiers/codes across CSV, lab JSON (including `alloy`), and corrections, hardened `parseStrictJson` with `maxNodes`, and fixed CSV formula-injection escaping (`csvCell`) for all non-strictly-numeric cells starting with formula characters.

4. **Six-field public log, exception barrier, and metrics (`server/log/publicLog.ts`, `server/log/barrier.ts`, `server/http/limits.ts`).**
   - Public stdout emits one JSON line per request containing strictly six fields (`ts`, `level`, `event`, `request_id`, `route` template, `status`); values, filenames, subjects, tokens, and reasons remain exclusively in access-controlled SQLite logs.
   - Error responses (`401`, `403`, `404`, `409`, `413`, `429`, `5xx`) use fixed text without reflecting request inputs; submitter `422` refusals carry value-free locators only. Uncaught exceptions/rejections pass through a barrier logging only `{ event: "crash", error_class, code }`.
   - `GET /api/admin/metrics` (`ADMIN`/`AUDITOR`) exposes counters only (status classes, limit outcomes, active/queued jobs, RSS; per-domain totals restricted to `ADMIN`).

5. **Runtime egress guard, disabled external LLM path, and blocking CI security gates (`server/security/egressGuard.ts`, `src/llm/suggest.ts`, `scripts/check-audit.mjs`, `scripts/check-secrets.mjs`, `scripts/check-bundle.mjs`).**
   - At server start-up (and inside ingress workers), `installEgressGuard()` blocks non-loopback `net`/`tls` dials, `dns.lookup`, and `fetch` against `config/egress-allowlist.json` (empty by default), checking resolved/dialled addresses while permitting local bind addresses.
   - Browser LLM mapping suggestions fail closed whenever `fetch` is present; no LLM SDK is shipped in `dist/` or `dist-server/` (verified by `check-bundle`). Vitest (`tests/setup/noEgress.ts`) and Playwright (`tests/e2e/fixtures/egress.ts`) enforce zero external egress across all suites.
   - `scripts/check-audit.mjs` enforces a blocking dependency gate in CI backed by `security/accepted-risks.json` (failing on any unaccepted advisory, severity escalation, future acceptance date, expired `review_by`, or window > 180 days). `scripts/check-secrets.mjs` scans tracked files plus `dist/` and `dist-server/`.

## Consequences

- Sustained concurrency, 64-job bursts, slow-drip clients, dead-socket disconnects, and 9,000-evidence records stay within latency and RSS envelopes with zero server errors and cross-domain isolation.
- Zero new production npm dependencies are introduced.
- Host-level OS/TLS hardening, container cgroup CPU/memory enforcement, streaming ingestion above 2 MiB, real customer IdP/JWKS rotation, cryptographic signing, and monitoring alerts/restore drills remain explicit subsequent increments or pre-production holds.
