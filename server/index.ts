/**
 * Entry point for the local Node 24 DPP durable storage and job API service (ADR-0004).
 *
 * Configuration via environment variables (no secrets):
 *   DPP_CONTRACT_PACK  contract pack directory (default: contracts/n)
 *   DPP_DB_PATH        SQLite WAL database path (default: ./data/dpp.sqlite)
 *   DPP_SERVER_HOST    bind address (default: 127.0.0.1, local only; there is no authentication yet)
 *   DPP_SERVER_PORT    TCP port (default: 4174)
 *   DPP_ALLOWED_ORIGIN extra browser origin(s) allowed to call the API, comma separated (default: none, same-origin only)
 *   DPP_STATIC_DIR     built single-page app to serve on the same origin (default: dist, served if it exists)
 */
import { existsSync } from "node:fs";
import { readPack } from "../config/contractPack";
import { loadProfilePack } from "../src/model/profile";
import { SqliteAdapter } from "./db/adapter";
import { migrateUp } from "./db/migrations";
import { createDppServer } from "./http/api";
import { ImportJobRunner } from "./jobs/importJobRunner";
import { PolicyStore } from "./store/policyStore";

async function main(): Promise<void> {
  const packDir = process.env.DPP_CONTRACT_PACK?.trim() || "contracts/n";
  const dbPath = process.env.DPP_DB_PATH?.trim() || "data/dpp.sqlite";
  const host = process.env.DPP_SERVER_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.DPP_SERVER_PORT?.trim() || "4174");
  const allowedOrigin = (process.env.DPP_ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const staticDirRaw = process.env.DPP_STATIC_DIR?.trim() || "dist";
  const staticDir = existsSync(staticDirRaw) ? staticDirRaw : undefined;

  const pack = await loadProfilePack(readPack(packDir));
  const db = new SqliteAdapter({ path: dbPath });
  const migrations = migrateUp(db);

  // Activate the contract pack's pinned retention policy before accepting any data (C6-02).
  const activePolicy = new PolicyStore(db).activate(pack.policy.retention);

  // Recover any interrupted staged jobs on startup (C6-04).
  // The server is the only process on its data file, so every job still running at start-up is from a crashed run.
  const recovery = new ImportJobRunner(db, pack).recoverPendingJobs({ force: true });

  const server = createDppServer({ db, pack, allowedOrigin, host, staticDir });
  server.listen(port, host, () => {
    console.log(
      `DPP server listening on http://${host}:${port} ` +
        `(${staticDir ? `app served from ${staticDir}` : "API only, no built app found"}) ` +
        `(db=${dbPath}, schema=v${migrations[migrations.length - 1]?.version ?? 0}, ` +
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
