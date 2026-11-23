# ADR-0005: OIDC authentication, server-side RBAC with grant epochs, output-surface separation, and controlled configuration releases

- **Status:** Accepted
- **Date:** 2026-11-23

## Context

Cycle 6 introduced a durable local Node 24 server with SQLite WAL persistence, staged idempotent import jobs, and pinned retention enforcement (`ADR-0004`). Because no operator authentication or server-side authorization existed yet, the server was restricted to `127.0.0.1` in a trusted local context, legal holds could not be released over HTTP, and contract-pack changes were deployed only by restarting the process with new files on disk.

Bounded production requires:

1. **Conventional identity-provider authentication** verifying signed bearer tokens without introducing unreviewed third-party authentication dependencies.
2. **Server-side role, field, and action enforcement** that cannot be bypassed by calling the HTTP API directly, with immediate revocation when a role is removed.
3. **Physical and route separation of internal outputs and customer outputs** in a dedicated deployment so external customer traffic never shares internal endpoints or views.
4. **An approved, auditable release and rollback procedure** for schema, mapping, and policy packages — preventing unvalidated or self-approved configuration changes and mutable `"latest"` references.
5. **Checksum-verified forward and backward data migrations** on production-like copies preserving all durable records without modifying already-applied migration definitions.

## Decision

1. **Standards-based OIDC JWT verification using Node 24 built-in `node:crypto` (zero new production dependencies).**
   - `server/auth/oidc.ts` verifies compact JWS bearer tokens (`RS256` with RSA >= 2048-bit and `ES256` IEEE P1363) against a configured local public JSON Web Key Set (`DPP_OIDC_JWKS_PATH`), enforcing canonical base64url, fatal UTF-8 JSON parsing, exact `iss` (`DPP_OIDC_ISSUER`), `aud` (`DPP_OIDC_AUDIENCE`), `exp`, `nbf`, `iat`, `grant_epoch` (when present), and non-empty trimmed `sub`. Algorithms outside `{RS256, ES256}` (including `none` and symmetric `HS*`) are rejected before key lookup.
   - `DPP_AUTH_MODE=oidc` requires a verified bearer JWT on every API endpoint except minimal `GET /api/health` liveness (which ignores caller `X-Security-Domain` in `oidc` mode). `DPP_AUTH_MODE=local-dev` (default) remains restricted to loopback (`127.0.0.1`/`localhost`/`::1`) and refuses to start on any non-loopback bind host before opening SQLite.
   - First-administrator provisioning is built into the compiled server entry point (`node dist-server/server.mjs --bootstrap-admin <sub-id> "<Display Name>"`).

2. **Server-side PDP/PEP and live grant-epoch revocation (`server/auth/grantStore.ts`, `server/auth/authorizer.ts`).**
   - Five distinct roles govern server actions: `ACT-01` (Manufacturer Operator), `ACT-06` (Business Customer), `ADMIN` (Identity & Role Administrator), `CURATOR` (Configuration Curator), and `AUDITOR` (Read-Only Auditor).
   - Users, role grants, and a monotonic `grant_epoch` live in SQLite (`0006_cycle7_identity_and_releases`). Assigning or revoking a role or deactivating a user increments `grant_epoch` atomically and appends an immutable `grant_events` row. Every HTTP request checks live grants and exact `grant_epoch` directly against SQLite, so role changes take effect immediately on the very next request even for unexpired tokens.
   - `authorizeRequest` (`server/auth/authorizer.ts`) over `evaluateRoleAction` (`src/model/c7Contracts.ts`) is the single server-side Policy Decision Point for actions. Field-level disclosure continues to flow exclusively through `src/model/policy.ts` (`decide`) and `src/model/disclosure.ts` (`project`).
   - Authenticated `ADMIN` principals may release an evidence legal hold with a mandatory reason, recorded in the append-only `grant_events` audit trail; all other roles receive `403`.

3. **Dedicated separation of internal and customer output surfaces.**
   - Customer reads and releases live exclusively under `/api/customer/*` (`GET /api/customer/records`, `GET /api/customer/records/:model/:batch`, `POST /api/customer/records/:model/:batch/release`), returning only the `customer-pdf` projection (with unverified values suppressed when on hold) and Customer PDF (never raw snapshots, internal ERP CSV, evidence blobs, denied fields, or source file names).
   - Internal routes (`/api/records/*`, `/api/jobs/*`, `/api/evidence/*`, `/api/admin/*`, `/api/config-releases/*`, `/api/log`) reject `ACT-06` with `403`.
   - `DPP_DEPLOYMENT_SURFACE=all|internal|customer` allows running dedicated `internal` and `customer` server instances on separate hosts/ports: the `customer` listener allows only `/api/health`, `/api/auth/me`, and `/api/customer/*` (returning `403 surface-forbidden` on every other `/api` path even for `ADMIN` tokens, and never serving the internal SPA), while the `internal` listener rejects `/api/customer/*` with `403 surface-forbidden`.

4. **Controlled configuration package release & rollback with four-eyes approval (`server/releases/configReleaseStore.ts`).**
   - Configuration packages separate stable package identity (`package_id`, strictly bound to verified `pack.id`) from immutable release identity (`release_id`, exact semver `version`, canonical `manifest_sha256`, `predecessor_release_id`). Mutable `"latest"` pins are rejected.
   - Every release follows an enforced state machine (`validated -> approved -> active | superseded | rolled_back | rejected`) backed by append-only `config_package_events`:
     - `CURATOR` proposes a bundle; the server validates every file digest, exact pin, disclosure matrix, derived rule, limit, retention-pin immutability, and full retention floors (`restricted`, >= 3650 days across governed datasets) through `loadProfilePack` before storing `validated`.
     - A **distinct** authorized approver (`CURATOR` or `ADMIN`, normalized `approver_sub !== proposer_sub`, four-eyes rule) approves or rejects the release; self-approval is rejected (`403 self-approval-forbidden`).
     - `CURATOR` or `ADMIN` activates an `approved` release atomically, superseding its predecessor, or rolls back strictly to a previously active `superseded` release with a mandatory reason. Active server listeners sharing the SQLite WAL database immediately load the active release's verified `ProfilePack` and domain-scoped retention policy (`domain_retention_policies`).

5. **Additive, checksum-verified migrations (`0006_cycle7_identity_and_releases`).**
   - Migrations v1–v5 remain untouched with frozen checksums. Migration v6 adds `users`, `role_grants`, `grant_events`, `config_packages` (with partial unique active index and `IS NOT` immutability triggers), `config_package_events`, and `domain_retention_policies`, and rolls back cleanly (`v6 -> v5`, clearing self-referencing `predecessor_release_id` links before dropping `config_packages`) inside a single atomic `migrateDown` transaction without disturbing retained snapshots, evidence, receipts, or execution logs.

## Consequences

- Calling the API directly can no longer bypass role, field, or action rules; role revocations take effect on the very next request.
- Customer deployments can isolate `/api/customer/*` on a dedicated listener returning `403 surface-forbidden` on all internal routes.
- Configuration packages cannot go live without structural validation and four-eyes approval, and can be rolled back deterministically with full audit history.
- Zero new production npm dependencies are introduced.
- Production customer IdP tenant registration, external JWKS HTTPS discovery and live key rotation, cryptographic payload signing, and load/threat-model hardening remain explicit subsequent increments.
