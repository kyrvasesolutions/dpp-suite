/**
 * Entry point for the local Node 24 DPP durable storage, OIDC/RBAC, surface-separated,
 * and controlled configuration release HTTP API service (ADR-0004, ADR-0005).
 *
 * Configuration via environment variables (no secrets):
 *   DPP_CONTRACT_PACK      contract pack directory (default: contracts/n)
 *   DPP_DB_PATH            SQLite WAL database path (default: ./data/dpp.sqlite)
 *   DPP_SERVER_HOST        bind address (default: 127.0.0.1; non-loopback requires DPP_AUTH_MODE=oidc)
 *   DPP_SERVER_PORT        TCP port (default: 4174)
 *   DPP_ALLOWED_ORIGIN     extra browser origin(s) allowed to call the API, comma separated (default: none)
 *   DPP_STATIC_DIR         built single-page app to serve on the same origin (default: dist; never served on customer surface)
 *   DPP_AUTH_MODE          `local-dev` (default, loopback-only) or `oidc` (signed Bearer JWT + DB grants)
 *   DPP_DEPLOYMENT_SURFACE `all` (default), `internal`, or `customer`
 *   DPP_OIDC_ISSUER        expected OIDC `iss` claim (required when DPP_AUTH_MODE=oidc)
 *   DPP_OIDC_AUDIENCE      expected OIDC `aud` claim (required when DPP_AUTH_MODE=oidc)
 *   DPP_OIDC_JWKS_PATH     path to local public JWKS JSON file (required when DPP_AUTH_MODE=oidc)
 */
import { existsSync } from "node:fs";
import { readPack } from "../config/contractPack";
import { AUTH_MODES, DEPLOYMENT_SURFACES, type AuthMode, type DeploymentSurface } from "../src/model/c7Contracts";
import { loadProfilePack } from "../src/model/profile";
import { loadJwksFromFile, OidcVerifier } from "./auth/oidc";
import { SqliteAdapter } from "./db/adapter";
import { migrateUp } from "./db/migrations";
import { createDppServer } from "./http/api";
import { ImportJobRunner } from "./jobs/importJobRunner";
import { ConfigReleaseStore } from "./releases/configReleaseStore";
import { PolicyStore } from "./store/policyStore";
import { verifyPackForServer } from "./verifyPack";

function parseAuthMode(raw: string | undefined): AuthMode {
  const v = (raw?.trim() || "local-dev") as AuthMode;
  if (!(AUTH_MODES as readonly string[]).includes(v)) {
    throw new Error(`Invalid DPP_AUTH_MODE "${v}" (expected one of: ${AUTH_MODES.join(", ")})`);
  }
  return v;
}

function parseSurface(raw: string | undefined): DeploymentSurface {
  const v = (raw?.trim() || "all") as DeploymentSurface;
  if (!(DEPLOYMENT_SURFACES as readonly string[]).includes(v)) {
    throw new Error(`Invalid DPP_DEPLOYMENT_SURFACE "${v}" (expected one of: ${DEPLOYMENT_SURFACES.join(", ")})`);
  }
  return v;
}

async function main(): Promise<void> {
  const packDir = process.env.DPP_CONTRACT_PACK?.trim() || "contracts/n";
  const dbPath = process.env.DPP_DB_PATH?.trim() || "data/dpp.sqlite";
  const host = process.env.DPP_SERVER_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.DPP_SERVER_PORT?.trim() || "4174");
  const authMode = parseAuthMode(process.env.DPP_AUTH_MODE);
  const surface = parseSurface(process.env.DPP_DEPLOYMENT_SURFACE);
  const allowedOrigin = (process.env.DPP_ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const staticDirRaw = process.env.DPP_STATIC_DIR?.trim() || "dist";
  const staticDir = surface !== "customer" && existsSync(staticDirRaw) ? staticDirRaw : undefined;

  let oidcVerifier: OidcVerifier | undefined;
  if (authMode === "oidc") {
    const issuer = process.env.DPP_OIDC_ISSUER?.trim() || "";
    const audience = process.env.DPP_OIDC_AUDIENCE?.trim() || "";
    const jwksPath = process.env.DPP_OIDC_JWKS_PATH?.trim() || "";
    if (!issuer || !audience || !jwksPath) {
      throw new Error(
        "DPP_AUTH_MODE=oidc requires DPP_OIDC_ISSUER, DPP_OIDC_AUDIENCE, and DPP_OIDC_JWKS_PATH to be set",
      );
    }
    oidcVerifier = new OidcVerifier({
      issuer,
      audience,
      jwks: loadJwksFromFile(jwksPath),
    });
  }

  // Frozen and signed, exactly as CI checks it, before anything is read from it or activated from it.
  verifyPackForServer(packDir);
  const packSource = readPack(packDir);
  const startupPack = await loadProfilePack(packSource);
  const db = new SqliteAdapter({ path: dbPath });
  const migrations = migrateUp(db);

  // Bootstrap the verified signed contract pack in the controlled release store (idempotent) and
  // load whichever approved configuration release is currently active in SQLite.
  const configReleases = new ConfigReleaseStore(db);
  const activeRelease = await configReleases.bootstrapActivePack(packSource, startupPack.id, startupPack.version);
  const activePack = (await configReleases.loadActivePack(startupPack.id)) ?? startupPack;

  // Activate the active configuration pack's pinned retention policy before accepting any data (C6-02).
  const activePolicy = new PolicyStore(db).activate(activePack.policy.retention);

  // Recover any interrupted staged jobs on startup (C6-04).
  // Skip job recovery on a dedicated customer-only surface so it remains read/release-only.
  const recovery =
    surface === "customer"
      ? { resumed: [], rolledBack: [] }
      : new ImportJobRunner(db, activePack).recoverPendingJobs({ force: true });

  const server = createDppServer({
    db,
    pack: activePack,
    allowedOrigin,
    host,
    staticDir,
    authMode,
    surface,
    oidc: oidcVerifier,
  });
  server.listen(port, host, () => {
    console.log(
      `DPP server listening on http://${host}:${port} ` +
        `(auth=${authMode}, surface=${surface}, ${staticDir ? `app served from ${staticDir}` : "API only"}) ` +
        `(db=${dbPath}, schema=v${migrations[migrations.length - 1]?.version ?? 0}, ` +
        `release=${activeRelease.packageId}@${activeRelease.version}, ` +
        `policy=${activePolicy.policyPin}, recovered=${recovery.resumed.length} resumed / ${recovery.rolledBack.length} rolled back)`,
    );
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("DPP server failed to start:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
