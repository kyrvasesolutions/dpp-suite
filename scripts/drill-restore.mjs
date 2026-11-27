/**
 * Timed backup & restore drill runner against the compiled server bundle `dist-server/server.mjs`.
 *
 * Exercises:
 *   1. Booting the compiled server against a temp SQLite WAL database and importing a representative
 *      clean file pair with a SHA-256-verified evidence attachment via `POST /api/jobs/import`;
 *   2. Taking a hot VACUUM INTO backup + AES-256-GCM encrypted off-host archive via `--backup`;
 *   3. Deleting the plaintext DB copy and restoring strictly from the encrypted off-host archive via `--restore`;
 *   4. Verifying `computeStoreChecksum`, `evidenceChecked >= 1`, `evidenceVerified: true`, and RPO/RTO bounds;
 *   5. Writing a structured JSON drill report (stdout, and optionally `--out <path>`).
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outPath = outIdx !== -1 && args[outIdx + 1] ? resolve(args[outIdx + 1]) : null;
const serverBundle = resolve("dist-server/server.mjs");

if (!existsSync(serverBundle)) {
  console.error("drill-restore: dist-server/server.mjs not found; run `npm run build:server` first.");
  process.exit(1);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolvePort(port)));
    });
    s.on("error", reject);
  });
}

async function waitForHealth(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry until server listens
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const workDir = mkdtempSync(join(tmpdir(), "dpp-restore-drill-"));
const srcDb = join(workDir, "live.sqlite");
const backupRoot = join(workDir, "backups");
const encryptedFile = join(workDir, "offhost", "backup.dppbk");
const restoredDb = join(workDir, "restored.sqlite");
const keyHex = randomBytes(32).toString("hex");

try {
  const port = await freePort();
  const baseEnv = {
    ...process.env,
    DPP_DB_PATH: srcDb,
    DPP_BACKUP_KEY: keyHex,
    DPP_SERVER_HOST: "127.0.0.1",
    DPP_SERVER_PORT: String(port),
    DPP_AUTH_MODE: "local-dev",
    DPP_DEPLOYMENT_SURFACE: "all",
  };

  // 1. Seed initial store with an ACT-19 platform operator + real committed record, evidence blob, and receipt
  execFileSync(
    process.execPath,
    [serverBundle, "--bootstrap-admin", "ops-drill-admin", "Platform Ops Drill", "--reason", "Timed restore drill seed"],
    { env: baseEnv, encoding: "utf8" },
  );

  const child = spawn(process.execPath, [serverBundle], { env: baseEnv, stdio: "ignore" });
  try {
    await waitForHealth(`http://127.0.0.1:${port}/api/health`);
    const erpBytes = readFileSync(resolve("fixtures/n/erp-extract.csv"));
    const labBytes = readFileSync(resolve("fixtures/n/lab-assessment.json"));
    const evBytes = Buffer.from("synthetic-restore-drill-evidence-object", "utf8");
    const evSha = createHash("sha256").update(evBytes).digest("hex");

    const impRes = await fetch(`http://127.0.0.1:${port}/api/jobs/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Idempotency-Key": "drill-seed-import-1" },
      body: JSON.stringify({
        erp: { name: "erp-extract.csv", type: "text/csv", base64: erpBytes.toString("base64") },
        lab: { name: "lab-assessment.json", type: "application/json", base64: labBytes.toString("base64") },
        evidence: [
          {
            evidenceId: "EV-DRILL-SEED-01",
            issuer: "Stand-In Lab",
            revision: "1.0",
            recordKind: "test-report",
            declaredSha256: evSha,
            base64: evBytes.toString("base64"),
          },
        ],
      }),
    });
    if (!impRes.ok) {
      throw new Error(`Drill seed import failed with HTTP ${impRes.status}: ${await impRes.text()}`);
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }

  // 2. Create hot backup + AES-256-GCM encrypted off-host archive via compiled CLI
  const backupOut = execFileSync(
    process.execPath,
    [
      serverBundle,
      "--backup",
      backupRoot,
      "--tier",
      "15m",
      "--encrypt-out",
      encryptedFile,
      "--key-env",
      "DPP_BACKUP_KEY",
      "--key-id",
      "drill-key-1",
    ],
    { env: baseEnv, encoding: "utf8" },
  );
  const backupMeta = JSON.parse(backupOut.trim());
  const bkDirs = readdirSync(backupRoot).filter((d) => d.startsWith("BK-"));
  if (bkDirs.length !== 1) throw new Error(`Expected 1 backup directory, found ${bkDirs.length}`);
  const backupDir = join(backupRoot, bkDirs[0]);

  // Remove plaintext DB copy to prove restore truly decrypts the off-host archive
  rmSync(join(backupDir, "store.sqlite"), { force: true });

  // 3. Restore strictly from encrypted off-host archive into fresh SQLite target
  const t0 = performance.now();
  const restoreOut = execFileSync(
    process.execPath,
    [
      serverBundle,
      "--restore",
      backupDir,
      "--target-db",
      restoredDb,
      "--decrypt-in",
      encryptedFile,
      "--key-env",
      "DPP_BACKUP_KEY",
    ],
    { env: baseEnv, encoding: "utf8" },
  );
  const wallMs = Math.round(performance.now() - t0);
  const restoreResult = JSON.parse(restoreOut.trim());

  const report = {
    executedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    backup: backupMeta,
    restore: restoreResult,
    cliWallClockMs: wallMs,
    passed: Boolean(
      backupMeta.ok &&
        backupMeta.evidenceCount >= 1 &&
        restoreResult.passed &&
        restoreResult.checksumMatch &&
        restoreResult.evidenceVerified &&
        restoreResult.evidenceChecked >= 1,
    ),
  };

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exit(1);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
