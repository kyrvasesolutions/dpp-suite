/**
 * Controlled schema, mapping, and policy package release & rollback store with four-eyes approval
 * (C7-04, LEAN-DEF-14, EV-6, ADR-0005).
 *
 * Separates stable `packageId` from immutable `releaseId` + `version` + `manifestSha256`, enforces
 * predecessor chains, validates every proposed bundle through `loadProfilePack` + retention floor
 * rules before saving, requires a distinct approver (`approver_sub !== proposer_sub`), and supports
 * auditable rollback to any previously approved/superseded release.
 */
import { createHash, randomUUID } from "node:crypto";
import { CLASSIFICATIONS } from "../../src/model/classification";
import {
  ConfigReleaseError,
  ProposePackageSchema,
  type ConfigPackageEvent,
  type ConfigPackageRelease,
  type ProposePackageInput,
} from "../../src/model/c7Contracts";
import { DEFAULT_SECURITY_DOMAIN, EVIDENCE_FLOOR } from "../../src/model/pContracts";
import { loadProfilePack, type PackSource, type ProfilePack } from "../../src/model/profile";
import type { DbAdapter } from "../db/adapter";
import { PolicyStore } from "../store/policyStore";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

interface PackageRow {
  release_id: string;
  package_id: string;
  version: string;
  security_domain: string;
  manifest_sha256: string;
  digest_algorithm: "sha256";
  predecessor_release_id: string | null;
  state: ConfigPackageRelease["state"];
  proposed_by: string;
  proposed_at: string;
  approved_by: string | null;
  approved_at: string | null;
  activated_by: string | null;
  activated_at: string | null;
  note: string;
  bundle_json: string;
}

interface PackageEventRow {
  seq: number;
  release_id: string;
  package_id: string;
  security_domain: string;
  event: ConfigPackageEvent["event"];
  actor_sub: string;
  reason: string;
  recorded_at: string;
}

function rowToRelease(r: PackageRow): ConfigPackageRelease {
  return {
    releaseId: r.release_id,
    packageId: r.package_id,
    version: r.version,
    securityDomain: r.security_domain,
    manifestSha256: r.manifest_sha256,
    digestAlgorithm: r.digest_algorithm,
    predecessorReleaseId: r.predecessor_release_id,
    state: r.state,
    proposedBy: r.proposed_by,
    proposedAt: r.proposed_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    activatedBy: r.activated_by,
    activatedAt: r.activated_at,
    note: r.note,
  };
}

function validateReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > 500 || CONTROL_CHARS.test(trimmed)) {
    throw new ConfigReleaseError("reason-required", 400, "A single-line reason of 1..500 characters is required");
  }
  return trimmed;
}

function assertRetentionFloor(pack: ProfilePack): void {
  const retention = pack.policy.retention;
  if (retention.default_classification !== "restricted") {
    throw new ConfigReleaseError("retention-floor-violation", 400, "Retention policy default_classification must remain restricted");
  }
  if (retention.default_retention_days < EVIDENCE_FLOOR.retentionDays) {
    throw new ConfigReleaseError(
      "retention-floor-violation",
      400,
      `Retention policy default_retention_days must be at least ${EVIDENCE_FLOOR.retentionDays} days`,
    );
  }
  const evRule = retention.datasets.find((d) => d.dataset === "evidence-object");
  if (
    !evRule ||
    CLASSIFICATIONS.indexOf(evRule.classification) < CLASSIFICATIONS.indexOf(EVIDENCE_FLOOR.classification) ||
    evRule.retention_days < EVIDENCE_FLOOR.retentionDays
  ) {
    throw new ConfigReleaseError(
      "retention-floor-violation",
      400,
      `evidence-object dataset must be at least ${EVIDENCE_FLOOR.classification} and ${EVIDENCE_FLOOR.retentionDays} days`,
    );
  }
}

async function parseAndValidateBundle(bundle: PackSource): Promise<ProfilePack> {
  try {
    const pack = await loadProfilePack(bundle);
    assertRetentionFloor(pack);
    return pack;
  } catch (err) {
    if (err instanceof ConfigReleaseError) throw err;
    throw new ConfigReleaseError(
      "invalid-package",
      400,
      `Configuration package failed validation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export class ConfigReleaseStore {
  private readonly now: () => string;
  private readonly policies: PolicyStore;

  constructor(
    private readonly db: DbAdapter,
    public readonly securityDomain: string = DEFAULT_SECURITY_DOMAIN,
    options: { now?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.policies = new PolicyStore(db);
  }

  private appendEvent(
    releaseId: string,
    packageId: string,
    event: ConfigPackageEvent["event"],
    actorSub: string,
    reason: string,
    recordedAt: string,
  ): void {
    this.db.run(
      `INSERT INTO config_package_events (release_id, package_id, security_domain, event, actor_sub, reason, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      releaseId,
      packageId,
      this.securityDomain,
      event,
      actorSub,
      reason,
      recordedAt,
    );
  }

  get(releaseId: string): ConfigPackageRelease | undefined {
    const row = this.db.get<PackageRow>(
      "SELECT * FROM config_packages WHERE security_domain = ? AND release_id = ?",
      this.securityDomain,
      releaseId,
    );
    return row ? rowToRelease(row) : undefined;
  }

  getActive(packageId?: string): ConfigPackageRelease | undefined {
    const row = packageId
      ? this.db.get<PackageRow>(
          "SELECT * FROM config_packages WHERE security_domain = ? AND package_id = ? AND state = 'active' LIMIT 1",
          this.securityDomain,
          packageId,
        )
      : this.db.get<PackageRow>(
          "SELECT * FROM config_packages WHERE security_domain = ? AND state = 'active' ORDER BY activated_at DESC LIMIT 1",
          this.securityDomain,
        );
    return row ? rowToRelease(row) : undefined;
  }

  list(packageId?: string): ConfigPackageRelease[] {
    const rows = packageId
      ? this.db.query<PackageRow>(
          "SELECT * FROM config_packages WHERE security_domain = ? AND package_id = ? ORDER BY proposed_at ASC, release_id ASC",
          this.securityDomain,
          packageId,
        )
      : this.db.query<PackageRow>(
          "SELECT * FROM config_packages WHERE security_domain = ? ORDER BY proposed_at ASC, release_id ASC",
          this.securityDomain,
        );
    return rows.map(rowToRelease);
  }

  listEvents(releaseId: string): ConfigPackageEvent[] {
    const rows = this.db.query<PackageEventRow>(
      "SELECT * FROM config_package_events WHERE security_domain = ? AND release_id = ? ORDER BY seq ASC",
      this.securityDomain,
      releaseId,
    );
    return rows.map((r) => ({
      seq: Number(r.seq),
      releaseId: r.release_id,
      packageId: r.package_id,
      securityDomain: r.security_domain,
      event: r.event,
      actorSub: r.actor_sub,
      reason: r.reason,
      recordedAt: r.recorded_at,
    }));
  }

  /**
   * Seeds the verified start-up contract pack as the initial active release if no release exists yet
   * for `(securityDomain, packageId)`. Idempotent across restarts.
   */
  async bootstrapActivePack(source: PackSource, packageId = "PROFILE-ALU-24-01", version = "1.0.0"): Promise<ConfigPackageRelease> {
    const existing = this.getActive(packageId);
    if (existing) return existing;
    const pack = await parseAndValidateBundle(source);
    const nowIso = this.now();
    const releaseId = `REL-${randomUUID()}`;

    return this.db.transaction(() => {
      const raced = this.getActive(packageId);
      if (raced) return raced;
      this.db.run(
        `INSERT INTO config_packages (
          release_id, package_id, version, security_domain, manifest_sha256, digest_algorithm,
          predecessor_release_id, state, proposed_by, proposed_at, approved_by, approved_at,
          activated_by, activated_at, note, bundle_json
        ) VALUES (?, ?, ?, ?, ?, 'sha256', NULL, 'active', 'system-bootstrap', ?, 'signed-pack', ?, 'system-bootstrap', ?, ?, ?)`,
        releaseId,
        packageId,
        version,
        this.securityDomain,
        source.manifestDigest,
        nowIso,
        nowIso,
        nowIso,
        `Initial verified signed contract pack (${pack.id}@${pack.version})`,
        JSON.stringify(source),
      );
      this.appendEvent(releaseId, packageId, "proposed", "system-bootstrap", "Initial signed pack bootstrap", nowIso);
      this.appendEvent(releaseId, packageId, "approved", "signed-pack", "Verified owner signature in SIGNATURES.json", nowIso);
      this.appendEvent(releaseId, packageId, "activated", "system-bootstrap", "Active at server startup", nowIso);
      return this.get(releaseId)!;
    });
  }

  /** Proposes and validates a new versioned configuration package (state -> `validated`). */
  async propose(rawInput: unknown, actorSub: string): Promise<ConfigPackageRelease> {
    if (rawInput && typeof rawInput === "object" && typeof (rawInput as { version?: unknown }).version === "string") {
      const v = String((rawInput as { version: string }).version).toLowerCase();
      if (v === "latest" || v.includes("latest")) {
        throw new ConfigReleaseError("mutable-version-forbidden", 400, 'Mutable version "latest" is forbidden');
      }
    }
    const parsed = ProposePackageSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ConfigReleaseError(
        "invalid-package",
        400,
        `Invalid package proposal: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
      );
    }
    const input: ProposePackageInput = parsed.data;
    const manifestText = `${JSON.stringify(input.manifest, null, 2)}\n`;
    const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
    const bundle: PackSource = {
      dir: `release:${input.packageId}@${input.version}`,
      manifest: input.manifest,
      files: input.files,
      manifestDigest: manifestSha256,
    };

    // Full structural, digest, pin, disclosure matrix, derived rule, limits, and retention-floor check
    await parseAndValidateBundle(bundle);

    const nowIso = this.now();
    const releaseId = `REL-${randomUUID()}`;

    return this.db.transaction(() => {
      const dup = this.db.get<{ release_id: string }>(
        "SELECT release_id FROM config_packages WHERE security_domain = ? AND package_id = ? AND version = ?",
        this.securityDomain,
        input.packageId,
        input.version,
      );
      if (dup) {
        throw new ConfigReleaseError(
          "duplicate-release",
          409,
          `Release ${input.packageId}@${input.version} already exists (${dup.release_id})`,
        );
      }

      const active = this.getActive(input.packageId);
      const expectedPred = active?.releaseId ?? null;
      const statedPred = input.predecessorReleaseId ?? null;
      if (statedPred !== expectedPred) {
        throw new ConfigReleaseError(
          "predecessor-mismatch",
          409,
          `Predecessor mismatch: expected ${expectedPred ?? "null"} (current active release), received ${statedPred ?? "null"}`,
        );
      }

      this.db.run(
        `INSERT INTO config_packages (
          release_id, package_id, version, security_domain, manifest_sha256, digest_algorithm,
          predecessor_release_id, state, proposed_by, proposed_at, note, bundle_json
        ) VALUES (?, ?, ?, ?, ?, 'sha256', ?, 'validated', ?, ?, ?, ?)`,
        releaseId,
        input.packageId,
        input.version,
        this.securityDomain,
        manifestSha256,
        expectedPred,
        actorSub,
        nowIso,
        input.note,
        JSON.stringify(bundle),
      );
      this.appendEvent(releaseId, input.packageId, "proposed", actorSub, input.note, nowIso);
      return this.get(releaseId)!;
    });
  }

  /** Approves a `validated` release under four-eyes separation of duties (`approver !== proposer`). */
  approve(releaseId: string, actorSub: string, reasonInput: string): ConfigPackageRelease {
    const reason = validateReason(reasonInput);
    const nowIso = this.now();

    return this.db.transaction(() => {
      const row = this.db.get<PackageRow>(
        "SELECT * FROM config_packages WHERE security_domain = ? AND release_id = ?",
        this.securityDomain,
        releaseId,
      );
      if (!row) throw new ConfigReleaseError("not-found", 404, `Configuration release "${releaseId}" not found`);
      if (row.state !== "validated") {
        throw new ConfigReleaseError("invalid-state", 409, `Release "${releaseId}" is in state "${row.state}" and cannot be approved`);
      }
      if (row.proposed_by === actorSub) {
        throw new ConfigReleaseError(
          "self-approval-forbidden",
          403,
          "Four-eyes rule: the principal who proposed a configuration release cannot approve it",
        );
      }
      this.db.run(
        `UPDATE config_packages SET state = 'approved', approved_by = ?, approved_at = ?
         WHERE security_domain = ? AND release_id = ? AND state = 'validated'`,
        actorSub,
        nowIso,
        this.securityDomain,
        releaseId,
      );
      this.appendEvent(releaseId, row.package_id, "approved", actorSub, reason, nowIso);
      return this.get(releaseId)!;
    });
  }

  /** Rejects a `validated` or `approved` (not yet active) release with a mandatory reason. */
  reject(releaseId: string, actorSub: string, reasonInput: string): ConfigPackageRelease {
    const reason = validateReason(reasonInput);
    const nowIso = this.now();

    return this.db.transaction(() => {
      const row = this.db.get<PackageRow>(
        "SELECT * FROM config_packages WHERE security_domain = ? AND release_id = ?",
        this.securityDomain,
        releaseId,
      );
      if (!row) throw new ConfigReleaseError("not-found", 404, `Configuration release "${releaseId}" not found`);
      if (row.state !== "validated" && row.state !== "approved") {
        throw new ConfigReleaseError("invalid-state", 409, `Release "${releaseId}" in state "${row.state}" cannot be rejected`);
      }
      this.db.run(
        `UPDATE config_packages SET state = 'rejected'
         WHERE security_domain = ? AND release_id = ? AND state IN ('validated', 'approved')`,
        this.securityDomain,
        releaseId,
      );
      this.appendEvent(releaseId, row.package_id, "rejected", actorSub, reason, nowIso);
      return this.get(releaseId)!;
    });
  }

  /** Activates an `approved` release atomically, superseding the predecessor and returning the verified `ProfilePack`. */
  async activate(releaseId: string, actorSub: string, reasonInput: string): Promise<{ release: ConfigPackageRelease; pack: ProfilePack }> {
    const reason = validateReason(reasonInput);
    const preRow = this.db.get<PackageRow>(
      "SELECT * FROM config_packages WHERE security_domain = ? AND release_id = ?",
      this.securityDomain,
      releaseId,
    );
    if (!preRow) throw new ConfigReleaseError("not-found", 404, `Configuration release "${releaseId}" not found`);
    if (preRow.state !== "approved") {
      throw new ConfigReleaseError("invalid-state", 409, `Only approved releases may be activated (current state: "${preRow.state}")`);
    }

    const bundle = JSON.parse(preRow.bundle_json) as PackSource;
    const pack = await parseAndValidateBundle(bundle);
    const nowIso = this.now();

    const release = this.db.transaction(() => {
      const row = this.db.get<PackageRow>(
        "SELECT * FROM config_packages WHERE security_domain = ? AND release_id = ?",
        this.securityDomain,
        releaseId,
      );
      if (!row || row.state !== "approved") {
        throw new ConfigReleaseError("invalid-state", 409, `Release "${releaseId}" is no longer in approved state`);
      }
      const currentActive = this.getActive(row.package_id);
      if ((currentActive?.releaseId ?? null) !== row.predecessor_release_id) {
        throw new ConfigReleaseError(
          "predecessor-mismatch",
          409,
          `Release "${releaseId}" targets predecessor ${row.predecessor_release_id ?? "null"} but active release is ${currentActive?.releaseId ?? "null"}`,
        );
      }

      if (currentActive) {
        this.db.run(
          "UPDATE config_packages SET state = 'superseded' WHERE security_domain = ? AND release_id = ? AND state = 'active'",
          this.securityDomain,
          currentActive.releaseId,
        );
        this.appendEvent(currentActive.releaseId, row.package_id, "superseded", actorSub, `Superseded by ${releaseId}: ${reason}`, nowIso);
      }

      this.db.run(
        `UPDATE config_packages SET state = 'active', activated_by = ?, activated_at = ?
         WHERE security_domain = ? AND release_id = ? AND state = 'approved'`,
        actorSub,
        nowIso,
        this.securityDomain,
        releaseId,
      );
      this.appendEvent(releaseId, row.package_id, "activated", actorSub, reason, nowIso);
      // Activate the release's verified retention policy atomically inside the same transaction
      this.policies.activate(pack.policy.retention, nowIso);
      return this.get(releaseId)!;
    });

    return { release, pack };
  }

  /**
   * Rolls back the active release of `packageId` to a previously approved/superseded release atomically,
   * recording the mandatory reason and restoring the target's verified `ProfilePack` + retention policy.
   */
  async rollback(
    packageId: string,
    targetReleaseId: string | undefined,
    actorSub: string,
    reasonInput: string,
  ): Promise<{ release: ConfigPackageRelease; rolledBackFrom: string; pack: ProfilePack }> {
    const reason = validateReason(reasonInput);
    const currentActive = this.getActive(packageId);
    if (!currentActive) {
      throw new ConfigReleaseError("not-found", 404, `No active configuration release found for package "${packageId}"`);
    }
    const desiredTargetId = targetReleaseId ?? currentActive.predecessorReleaseId;
    if (!desiredTargetId) {
      throw new ConfigReleaseError("invalid-state", 409, `Active release "${currentActive.releaseId}" has no predecessor to roll back to`);
    }
    if (desiredTargetId === currentActive.releaseId) {
      throw new ConfigReleaseError("invalid-state", 409, "Cannot roll back to the already-active release");
    }

    const targetRow = this.db.get<PackageRow>(
      "SELECT * FROM config_packages WHERE security_domain = ? AND package_id = ? AND release_id = ?",
      this.securityDomain,
      packageId,
      desiredTargetId,
    );
    if (!targetRow) {
      throw new ConfigReleaseError("not-found", 404, `Rollback target "${desiredTargetId}" not found for package "${packageId}"`);
    }
    if (targetRow.state !== "superseded" && targetRow.state !== "approved") {
      throw new ConfigReleaseError(
        "invalid-state",
        409,
        `Rollback target "${desiredTargetId}" must be a previously approved/superseded release (state: "${targetRow.state}")`,
      );
    }

    const bundle = JSON.parse(targetRow.bundle_json) as PackSource;
    const pack = await parseAndValidateBundle(bundle);
    const nowIso = this.now();

    const release = this.db.transaction(() => {
      const liveActive = this.getActive(packageId);
      if (!liveActive || liveActive.releaseId !== currentActive.releaseId) {
        throw new ConfigReleaseError("invalid-state", 409, "Active release changed concurrently during rollback");
      }
      this.db.run(
        "UPDATE config_packages SET state = 'rolled_back' WHERE security_domain = ? AND release_id = ? AND state = 'active'",
        this.securityDomain,
        liveActive.releaseId,
      );
      this.appendEvent(liveActive.releaseId, packageId, "rolled-back", actorSub, `Rolled back to ${desiredTargetId}: ${reason}`, nowIso);

      this.db.run(
        `UPDATE config_packages SET state = 'active', activated_by = ?, activated_at = ?
         WHERE security_domain = ? AND release_id = ?`,
        actorSub,
        nowIso,
        this.securityDomain,
        desiredTargetId,
      );
      this.appendEvent(desiredTargetId, packageId, "activated", actorSub, `Restored via rollback from ${liveActive.releaseId}: ${reason}`, nowIso);
      this.policies.activate(pack.policy.retention, nowIso);
      return this.get(desiredTargetId)!;
    });

    return { release, rolledBackFrom: currentActive.releaseId, pack };
  }

  /** Loads the verified `ProfilePack` of the currently active release, if one exists in the DB. */
  async loadActivePack(packageId?: string): Promise<ProfilePack | undefined> {
    const active = this.getActive(packageId);
    if (!active) return undefined;
    const row = this.db.get<PackageRow>(
      "SELECT * FROM config_packages WHERE security_domain = ? AND release_id = ?",
      this.securityDomain,
      active.releaseId,
    );
    if (!row) return undefined;
    return parseAndValidateBundle(JSON.parse(row.bundle_json) as PackSource);
  }
}
