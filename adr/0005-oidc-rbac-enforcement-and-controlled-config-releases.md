# ADR-0005: OIDC authentication, server-side RBAC with grant epochs, output-surface separation, and controlled configuration releases

- **Status:** Accepted
- **Date:** 2026-11-22

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
   - `server/auth/oidc.ts` verifies compact JWS bearer tokens (`RS256` and `ES256`) against a configured JSON Web Key Set (`DPP_OIDC_JWKS_PATH` or `DPP_OIDC_JWKS_JSON`), enforcing exact `iss` (`DPP_OIDC_ISSUER`), `aud` (`DPP_OIDC_AUDIENCE`), `exp`, `nbf`, and non-empty `sub`. Algorithms outside `{RS256, ES256}` (including `none` and symmetric `HS*`) are rejected before key lookup.
   - `DPP_AUTH_MODE=oidc` requires a verified bearer JWT on every API endpoint except minimal `GET /api/health` liveness. `DPP_AUTH_MODE=local-dev` (default only when no OIDC configuration is set) remains restricted to loopback (`127.0.0.1`/`localhost`) so static demos and local single-user setups keep working unchanged.

2. **Server-side PDP/PEP and live grant-epoch revocation (`server/auth/grantStore.ts`, `server/auth/authorizer.ts`).**
   - Five distinct roles govern server actions: `ACT-01` (Manufacturer Operator), `ACT-06` (Business Customer), `ADMIN` (Identity & Role Administrator), `CURATOR` (Configuration Curator), and `AUDITOR` (Read-Only Auditor).
   - Users, role grants, and a monotonic `grant_epoch` live in SQLite (`0006_cycle7_identity_and_releases`). Assigning or revoking a role increments `grant_epoch` and appends an immutable `grant_events` row. Every HTTP request checks live grants and epoch directly against the store, so role changes take effect immediately on the next request even for non-expired tokens.
   - `authorizeAction(principal, action)` is the single server-side Policy Decision Point for actions. Field-level disclosure continues to flow exclusively through `src/model/policy.ts` (`decide`) and `src/model/disclosure.ts` (`project`).
   - Authenticated `ADMIN` principals may release an evidence legal hold with a mandatory reason, recorded in the append-only audit trail; all other roles receive `403`.

3. **Dedicated separation of internal and customer output surfaces.**
   - Customer reads and releases live exclusively under `/api/customer/*` (`GET /api/customer/records`, `GET /api/customer/records/:model/:batch`, `POST /api/customer/records/:model/:batch/release`), returning only the `customer-pdf` projection and Customer PDF (never raw snapshots, internal ERP CSV, evidence blobs, denied fields, or source file names).
   - Internal routes (`/api/records/*`, `/api/jobs/*`, `/api/evidence/*`, `/api/admin/*`, `/api/config-releases/*`, `/api/log`) reject `ACT-06` with `403`.
   - `DPP_DEPLOYMENT_SURFACE=all|internal|customer` allows running dedicated `internal` and `customer` server instances on separate hosts/ports where the customer listener mounts zero internal routes.

4. **Controlled configuration package release & rollback with four-eyes approval (`server/releases/configReleaseStore.ts`).**
   - Configuration packages separate stable package identity (`package_id`) from immutable release identity (`release_id`, exact `version`, `manifest_sha256`, `predecessor_release_id`). Mutable `"latest"` pins are rejected.
   - Every release follows an enforced state machine (`validated → approved → active | superseded | rolled_back | rejected`) backed by append-only `config_package_events`:
     - `CURATOR` proposes a bundle; the server validates every file digest, exact pin, disclosure matrix, derived rule, limit, and retention floor (`restricted`, ≥ 3650 days) through `loadProfilePack` before storing `validated`.
     - A **distinct** authorized approver (`approver_sub !== proposer_sub`, four-eyes rule) approves the release (`approved`); self-approval is rejected (`403`).
     - `CURATOR` or `ADMIN` activates an `approved` release atomically, recording its predecessor, or rolls back to a prior approved release with a mandatory reason. Active server operations immediately serve the active release's verified `ProfilePack` and pinned retention policy.

5. **Additive, checksum-verified migrations (`0006_cycle7_identity_and_releases`).**
   - Migrations v1–v5 remain untouched with frozen checksums. Migration v6 adds `users`, `role_grants`, `grant_events`, `config_packages`, and `config_package_events` with append-only and replace-proof SQLite triggers, and rolls back cleanly (`v6 → v5`) without disturbing retained snapshots, evidence, receipts, or execution logs.

## Consequences

- Calling the API directly can no longer bypass role, field, or action rules; role revocations take effect on the very next request.
- Customer deployments can isolate `/api/customer/*` on a dedicated listener with zero internal routes exposed.
- Configuration packages cannot go live without structural validation and four-eyes approval, and can be rolled back deterministically with full audit history.
- Zero new production npm dependencies are introduced.
- Production customer IdP registration, external key rotation/discovery over HTTPS, cryptographic payload signing, and load/threat-model hardening remain explicit subsequent increments.
