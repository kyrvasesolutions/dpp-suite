/**
 * Controlled schema, mapping, and policy package release & rollback store with four-eyes approval
 * (C7-04, LEAN-DEF-14, EV-6, ADR-0005).
 *
 * Separates stable `packageId` (bound strictly to `pack.id`) from immutable `releaseId` + `version`
 * + canonical `manifestSha256`, enforces predecessor chains, validates every proposed bundle through
 * `loadProfilePack` + full retention-floor + pin-immutability rules before saving, requires a
 * distinct approver (`approver !== proposer`, normalized), and supports atomic TOCTOU-free rollback
 * strictly to previously active (`superseded`) releases.
 */
import { createHash, randomUUID } from "node:crypto";
import { canonical } from "../../src/model/canonical";
import {
  ConfigReleaseError,
  ProposePackageSchema,
  type ConfigPackageEvent,
  type ConfigPackageRelease,
  type ProposePackageInput,
} from "../../src/model/c7Contracts";
import { DEFAULT_SECURITY_DOMAIN } from "../../src/model/pContracts";
import { loadProfilePack, type PackSource, type ProfilePack } from "../../src/model/profile";
import type { DbAdapter } from "../db/adapter";
import { PolicyStore, validateRetentionFloors } from "../store/policyStore";

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

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

function validateReason(reason: unknown): string {
  if (typeof reason !== "string") {
    throw new ConfigReleaseError("reason-required", 400, "A single-line reason of 1..500 characters is required");
  }
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > 500 || CONTROL_CHARS.test(trimmed)) {
    throw new ConfigReleaseError("reason-required", 400, "A single-line reason of 1..500 characters is required");
  }
  return trimmed;
}

function validateActorSub(actorSub: unknown): string {
  if (typeof actorSub !== "string" || !actorSub || actorSub !== actorSub.trim() || actorSub.length > 128 || CONTROL_CHARS.test(actorSub)) {
    throw new ConfigReleaseError("invalid-package", 400, "A valid non-empty actor subject identifier is required");
  }
  return actorSub;
}

function assertRetentionFloor(pack: ProfilePack): void {
  const err = validateRetentionFloors(pack.policy.retention);
  if (err) {
    throw new ConfigReleaseError("retention-floor-violation", 400, err);
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
    this.policies = new PolicyStore(db, securityDomain);
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
   * Seeds the verified start-up contract pack as the initial active release and activates its
   * retention policy pin atomically if no active release exists yet for `(securityDomain, packageId)`.
   * Idempotent across restarts.
   */
  async bootstrapActivePack(source: PackSource, packageId?: string, version?: string): Promise<ConfigPackageRelease> {
    if (!SHA256_HEX.test(source.manifestDigest)) {
      throw new ConfigReleaseError("invalid-package", 400, "Bootstrap pack source must carry a valid SHA-256 manifestDigest");
    }
    const pack = await parseAndValidateBundle(source);
    const resolvedPackageId = packageId ?? pack.id;
    const resolvedVersion = version ?? pack.version;
    if (resolvedPackageId !== pack.id) {
      throw new ConfigReleaseError(
        "invalid-package",
        400,
        `Bootstrap packageId "${resolvedPackageId}" does not match verified profile id "${pack.id}"`,
      );
    }
    const existing = this.getActive(resolvedPackageId);
    if (existing) return existing;

    const nowIso = this.now();
    const releaseId = `REL-${randomUUID()}`;

    return this.db.transaction(() => {
      const raced = this.getActive(resolvedPackageId);
      if (raced) return raced;
      this.db.run(
        `INSERT INTO config_packages (
          release_id, package_id, version, security_domain, manifest_sha256, digest_algorithm,
          predecessor_release_id, state, proposed_by, proposed_at, approved_by, approved_at,
          activated_by, activated_at, note, bundle_json
        ) VALUES (?, ?, ?, ?, ?, 'sha256', NULL, 'active', 'system-bootstrap', ?, 'signed-pack', ?, 'system-bootstrap', ?, ?, ?)`,
        releaseId,
        resolvedPackageId,
        resolvedVersion,
        this.securityDomain,
        source.manifestDigest,
        nowIso,
        nowIso,
        nowIso,
        `Initial verified signed contract pack (${pack.id}@${pack.version})`,
        JSON.stringify(source),
      );
      this.appendEvent(releaseId, resolvedPackageId, "proposed", "system-bootstrap", "Initial signed pack bootstrap", nowIso);
      this.appendEvent(releaseId, resolvedPackageId, "approved", "signed-pack", "Verified owner signature in SIGNATURES.json", nowIso);
      this.appendEvent(releaseId, resolvedPackageId, "activated", "system-bootstrap", "Active at server startup", nowIso);
      // Seed the baseline retention policy pin atomically so future rollbacks never hit pin poisoning.
      this.policies.activate(pack.policy.retention, nowIso);
      return this.get(releaseId)!;
    });
  }

  /** Proposes and validates a new versioned configuration package (state -> `validated`). */
  async propose(rawInput: unknown, actorSubInput: string): Promise<ConfigPackageRelease> {
    const actorSub = validateActorSub(actorSubInput);
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
    if (CONTROL_CHARS.test(input.note)) {
      throw new ConfigReleaseError("invalid-package", 400, "Release note must be single-line printable text");
    }
    // Canonical SHA-256 digest of the manifest (independent of JSON key order).
    const manifestSha256 = createHash("sha256").update(canonical(input.manifest)).digest("hex");
    const bundle: PackSource = {
      dir: `release:${input.packageId}@${input.version}`,
      manifest: input.manifest,
      files: input.files,
      manifestDigest: manifestSha256,
    };

    // Full structural, digest, pin, disclosure matrix, derived rule, limits, and full retention-floor check
    const pack = await parseAndValidateBundle(bundle);
    if (input.packageId !== pack.id) {
      throw new ConfigReleaseError(
        "invalid-package",
        400,
        `Proposed packageId "${input.packageId}" must match verified profile id "${pack.id}"`,
      );
    }

    const nowIso = this.now();
    const releaseId = `REL-${randomUUID()}`;

    return this.db.transaction(() => {
      // Fail early if the proposal tries to reuse an existing immutable retention policy pin with different content.
      const pinConflict = this.policies.checkPinConflict(pack.policy.retention);
      if (pinConflict) {
        throw new ConfigReleaseError("invalid-package", 409, pinConflict);
      }

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

  /** Approves a `validated` release under strict four-eyes separation of duties (`approver !== proposer`). */
  approve(releaseId: string, actorSubInput: string, reasonInput: string): ConfigPackageRelease {
    const actorSub = validateActorSub(actorSubInput);
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
      if (row.proposed_by.trim().toLowerCase() === actorSub.toLowerCase()) {
        throw new ConfigReleaseError(
          "self-approval-forbidden",
          403,
          "Four-eyes rule: the principal who proposed a configuration release cannot approve it",
        );
      }
      const updated = this.db.run(
        `UPDATE config_packages SET state = 'approved', approved_by = ?, approved_at = ?
         WHERE security_domain = ? AND release_id = ? AND state = 'validated'`,
        actorSub,
        nowIso,
        this.securityDomain,
        releaseId,
      );
      if (updated.changes !== 1) {
        throw new ConfigReleaseError("invalid-state", 409, `Release "${releaseId}" could not be approved concurrently`);
      }
      this.appendEvent(releaseId, row.package_id, "approved", actorSub, reason, nowIso);
      return this.get(releaseId)!;
    });
  }

  /** Rejects a `validated` or `approved` (not yet active) release with a mandatory reason. */
  reject(releaseId: string, actorSubInput: string, reasonInput: string): ConfigPackageRelease {
    const actorSub = validateActorSub(actorSubInput);
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
      const updated = this.db.run(
        `UPDATE config_packages SET state = 'rejected'
         WHERE security_domain = ? AND release_id = ? AND state IN ('validated', 'approved')`,
        this.securityDomain,
        releaseId,
      );
      if (updated.changes !== 1) {
        throw new ConfigReleaseError("invalid-state", 409, `Release "${releaseId}" changed state concurrently`);
      }
      this.appendEvent(releaseId, row.package_id, "rejected", actorSub, reason, nowIso);
      return this.get(releaseId)!;
    });
  }

  /** Activates an `approved` release atomically, superseding the predecessor and returning the verified `ProfilePack`. */
  async activate(releaseId: string, actorSubInput: string, reasonInput: string): Promise<{ release: ConfigPackageRelease; pack: ProfilePack }> {
    const actorSub = validateActorSub(actorSubInput);
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
        const sup = this.db.run(
          "UPDATE config_packages SET state = 'superseded' WHERE security_domain = ? AND release_id = ? AND state = 'active'",
          this.securityDomain,
          currentActive.releaseId,
        );
        if (sup.changes !== 1) {
          throw new ConfigReleaseError("invalid-state", 409, "Active release changed concurrently during activation");
        }
        this.appendEvent(currentActive.releaseId, row.package_id, "superseded", actorSub, `Superseded by ${releaseId}: ${reason}`, nowIso);
      }

      const act = this.db.run(
        `UPDATE config_packages SET state = 'active', activated_by = ?, activated_at = ?
         WHERE security_domain = ? AND release_id = ? AND state = 'approved'`,
        actorSub,
        nowIso,
        this.securityDomain,
        releaseId,
      );
      if (act.changes !== 1) {
        throw new ConfigReleaseError("invalid-state", 409, `Release "${releaseId}" is no longer in approved state`);
      }
      this.appendEvent(releaseId, row.package_id, "activated", actorSub, reason, nowIso);
      this.policies.activate(pack.policy.retention, nowIso);
      return this.get(releaseId)!;
    });

    return { release, pack };
  }

  /**
   * Rolls back the active release of `packageId` to a previously active (`superseded`) release atomically,
   * re-verifying both active and target states inside the write transaction to prevent async TOCTOU.
   */
  async rollback(
    packageId: string,
    targetReleaseId: string | undefined,
    actorSubInput: string,
    reasonInput: string,
  ): Promise<{ release: ConfigPackageRelease; rolledBackFrom: string; pack: ProfilePack }> {
    const actorSub = validateActorSub(actorSubInput);
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

    const preTarget = this.db.get<PackageRow>(
      "SELECT * FROM config_packages WHERE security_domain = ? AND package_id = ? AND release_id = ?",
      this.securityDomain,
      packageId,
      desiredTargetId,
    );
    if (!preTarget) {
      throw new ConfigReleaseError("not-found", 404, `Rollback target "${desiredTargetId}" not found for package "${packageId}"`);
    }
    if (preTarget.state !== "superseded") {
      throw new ConfigReleaseError(
        "invalid-state",
        409,
        `Rollback target "${desiredTargetId}" must be a previously active superseded release (state: "${preTarget.state}")`,
      );
    }

    const bundle = JSON.parse(preTarget.bundle_json) as PackSource;
    const pack = await parseAndValidateBundle(bundle);
    const nowIso = this.now();

    const release = this.db.transaction(() => {
      const liveActive = this.getActive(packageId);
      if (!liveActive || liveActive.releaseId !== currentActive.releaseId) {
        throw new ConfigReleaseError("invalid-state", 409, "Active release changed concurrently during rollback");
      }
      const liveTarget = this.db.get<PackageRow>(
        "SELECT * FROM config_packages WHERE security_domain = ? AND package_id = ? AND release_id = ?",
        this.securityDomain,
        packageId,
        desiredTargetId,
      );
      if (!liveTarget || liveTarget.state !== "superseded") {
        throw new ConfigReleaseError(
          "invalid-state",
          409,
          `Rollback target "${desiredTargetId}" is no longer in superseded state (current: "${liveTarget?.state ?? "missing"}")`,
        );
      }

      const rb = this.db.run(
        "UPDATE config_packages SET state = 'rolled_back' WHERE security_domain = ? AND release_id = ? AND state = 'active'",
        this.securityDomain,
        liveActive.releaseId,
      );
      if (rb.changes !== 1) {
        throw new ConfigReleaseError("invalid-state", 409, "Active release changed concurrently during rollback");
      }
      this.appendEvent(liveActive.releaseId, packageId, "rolled-back", actorSub, `Rolled back to ${desiredTargetId}: ${reason}`, nowIso);

      const restore = this.db.run(
        `UPDATE config_packages SET state = 'active', activated_by = ?, activated_at = ?
         WHERE security_domain = ? AND release_id = ? AND state = 'superseded'`,
        actorSub,
        nowIso,
        this.securityDomain,
        desiredTargetId,
      );
      if (restore.changes !== 1) {
        throw new ConfigReleaseError("invalid-state", 409, `Rollback target "${desiredTargetId}" changed state concurrently`);
      }
      this.appendEvent(desiredTargetId, packageId, "activated", actorSub, `Restored via rollback from ${liveActive.releaseId}: ${reason}`, nowIso);
      this.policies.activate(pack.policy.retention, nowIso);
      return this.get(desiredTargetId)!;
    });

    return { release, rolledBackFrom: currentActive.releaseId, pack };
  }

  /** Loads the verified `ProfilePack` of one exact `releaseId` row (prevents cache/row divergence). */
  async loadPackByReleaseId(releaseId: string): Promise<ProfilePack | undefined> {
    const row = this.db.get<PackageRow>(
      "SELECT * FROM config_packages WHERE security_domain = ? AND release_id = ?",
      this.securityDomain,
      releaseId,
    );
    if (!row) return undefined;
    return parseAndValidateBundle(JSON.parse(row.bundle_json) as PackSource);
  }

  /** Loads the verified `ProfilePack` of the currently active release, if one exists in the DB. */
  async loadActivePack(packageId?: string): Promise<ProfilePack | undefined> {
    const active = this.getActive(packageId);
    if (!active) return undefined;
    return this.loadPackByReleaseId(active.releaseId);
  }
}
