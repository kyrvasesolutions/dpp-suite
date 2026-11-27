// @vitest-environment node
/**
 * Layer 2 pre-implementation deterministic contract simulator for Cycle 7 (P03 + P04).
 *
 * Calibrated against N (`contracts/n` disclosure matrix + `decide`/`project`), then simulates:
 * 1. Exhaustive server-side role × field × action enforcement (`C7-02`).
 * 2. Live grant-epoch revocation taking effect immediately on the next request (`LEAN-DEF-03`, `C7-01`, `C7-02`).
 * 3. Internal vs customer deployment surface separation (`C7-03`).
 * 4. Four-eyes controlled configuration release & rollback (`C7-04`, `LEAN-DEF-14`, `EV-6`).
 * 5. Drop-one-input contract-tightness checks proving every Cycle 7 precondition breaks at the exact expected step.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  AuthError,
  ConfigReleaseError,
  evaluateRoleAction,
  ROLE_ACTION_MATRIX,
  SERVER_ACTIONS,
  SERVER_ROLES,
  type AuthContext,
  type ConfigPackageRelease,
  type DeploymentSurface,
  type ServerAction,
  type ServerRole,
} from "../../src/model/c7Contracts";
import { project } from "../../src/model/disclosure";
import { byRole } from "../../src/model/ingress";
import { decide } from "../../src/model/policy";
import type { ProfilePack } from "../../src/model/profile";
import { CLEAN, loadPack, recordFor } from "../support/records";

interface SimToken {
  sub: string;
  issuer: string;
  audience: string;
  exp: number;
  sigValid: boolean;
  alg: string;
}

class Cycle7ContractSimulator {
  private readonly users = new Map<string, { active: boolean; epoch: number; roles: Set<ServerRole> }>();
  private readonly releases = new Map<string, ConfigPackageRelease>();
  private activeReleaseId: string | null = null;
  private seq = 0;

  constructor(
    private readonly expectedIssuer: string,
    private readonly expectedAudience: string,
    private readonly surface: DeploymentSurface = "all",
  ) {}

  upsertUser(sub: string, roles: ServerRole[], active = true): number {
    const existing = this.users.get(sub);
    const epoch = (existing?.epoch ?? 0) + 1;
    this.users.set(sub, { active, epoch, roles: new Set(roles) });
    return epoch;
  }

  revokeRole(sub: string, role: ServerRole): number {
    const u = this.users.get(sub);
    if (!u) throw new Error(`Unknown user ${sub}`);
    u.roles.delete(role);
    u.epoch += 1;
    return u.epoch;
  }

  authenticate(token: SimToken | null, nowSec: number): AuthContext {
    if (!token) throw new AuthError("unauthenticated", 401, "Bearer token is required");
    if (token.alg !== "RS256" && token.alg !== "ES256") {
      throw new AuthError("token-algorithm-rejected", 401, `Algorithm "${token.alg}" is not permitted`);
    }
    if (!token.sigValid) throw new AuthError("token-signature-invalid", 401, "Invalid JWS signature");
    if (token.issuer !== this.expectedIssuer) throw new AuthError("token-issuer-mismatch", 401, "Issuer mismatch");
    if (token.audience !== this.expectedAudience) throw new AuthError("token-audience-mismatch", 401, "Audience mismatch");
    if (nowSec >= token.exp) throw new AuthError("token-expired", 401, "Token expired");
    const u = this.users.get(token.sub);
    if (!u) throw new AuthError("user-unknown", 403, "User has no active grant");
    if (!u.active) throw new AuthError("user-inactive", 403, "User is deactivated");
    return {
      sub: token.sub,
      issuer: token.issuer,
      roles: [...u.roles],
      grantEpoch: u.epoch,
      securityDomain: "default",
      authMode: "oidc",
      productGroup: "aluminium-sheet",
      legalAct: "ESPR",
      surface: this.surface,
    };
  }

  authorize(token: SimToken | null, action: ServerAction, nowSec: number): AuthContext {
    const ctx = this.authenticate(token, nowSec);
    const decision = evaluateRoleAction(ctx, action);
    if (!decision.permitted) {
      throw new AuthError(
        decision.reason.includes("surface") ? "surface-forbidden" : "forbidden",
        403,
        decision.reason,
      );
    }
    return ctx;
  }

  proposeRelease(token: SimToken, pkg: { packageId: string; version: string; manifestSha256: string; predecessorReleaseId?: string | null; note: string }, nowSec: number): ConfigPackageRelease {
    const ctx = this.authorize(token, "config-propose", nowSec);
    if (!/^\d+\.\d+\.\d+/.test(pkg.version) || pkg.version.toLowerCase().includes("latest")) {
      throw new ConfigReleaseError("mutable-version-forbidden", 400, "Mutable version is forbidden");
    }
    if (!pkg.note.trim()) throw new ConfigReleaseError("reason-required", 400, "Note is required");
    const expectedPred = this.activeReleaseId;
    if ((pkg.predecessorReleaseId ?? null) !== expectedPred) {
      throw new ConfigReleaseError("predecessor-mismatch", 409, `Expected predecessor ${expectedPred}`);
    }
    const releaseId = `REL-${++this.seq}`;
    const rel: ConfigPackageRelease = {
      releaseId,
      packageId: pkg.packageId,
      version: pkg.version,
      securityDomain: ctx.securityDomain,
      manifestSha256: pkg.manifestSha256,
      digestAlgorithm: "sha256",
      predecessorReleaseId: expectedPred,
      state: "validated",
      proposedBy: ctx.sub,
      proposedAt: new Date(nowSec * 1000).toISOString(),
      approvedBy: null,
      approvedAt: null,
      activatedBy: null,
      activatedAt: null,
      note: pkg.note,
    };
    this.releases.set(releaseId, rel);
    return rel;
  }

  approveRelease(token: SimToken, releaseId: string, nowSec: number): ConfigPackageRelease {
    const ctx = this.authorize(token, "config-approve", nowSec);
    const rel = this.releases.get(releaseId);
    if (!rel) throw new ConfigReleaseError("not-found", 404, "Release not found");
    if (rel.state !== "validated") throw new ConfigReleaseError("invalid-state", 409, "Release must be validated");
    if (rel.proposedBy === ctx.sub) {
      throw new ConfigReleaseError("self-approval-forbidden", 403, "Four-eyes rule: proposer cannot approve own release");
    }
    rel.state = "approved";
    rel.approvedBy = ctx.sub;
    rel.approvedAt = new Date(nowSec * 1000).toISOString();
    return rel;
  }

  activateRelease(token: SimToken, releaseId: string, nowSec: number): ConfigPackageRelease {
    const ctx = this.authorize(token, "config-activate", nowSec);
    const rel = this.releases.get(releaseId);
    if (!rel) throw new ConfigReleaseError("not-found", 404, "Release not found");
    if (rel.state !== "approved") throw new ConfigReleaseError("invalid-state", 409, "Only approved releases may be activated");
    if (this.activeReleaseId) {
      const prev = this.releases.get(this.activeReleaseId);
      if (prev) prev.state = "superseded";
    }
    rel.state = "active";
    rel.activatedBy = ctx.sub;
    rel.activatedAt = new Date(nowSec * 1000).toISOString();
    this.activeReleaseId = releaseId;
    return rel;
  }

  rollbackRelease(token: SimToken, targetReleaseId: string, reason: string, nowSec: number): ConfigPackageRelease {
    this.authorize(token, "config-rollback", nowSec);
    if (!reason.trim()) throw new ConfigReleaseError("reason-required", 400, "Rollback requires a reason");
    const target = this.releases.get(targetReleaseId);
    if (!target) throw new ConfigReleaseError("not-found", 404, "Target release not found");
    if (target.state !== "superseded" && target.state !== "approved") {
      throw new ConfigReleaseError("invalid-state", 409, "Rollback target must be a previously approved/superseded release");
    }
    if (this.activeReleaseId) {
      const current = this.releases.get(this.activeReleaseId);
      if (current) current.state = "rolled_back";
    }
    target.state = "active";
    this.activeReleaseId = targetReleaseId;
    return target;
  }
}

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});

const NOW = 1_795_300_000;
const makeToken = (sub: string, overrides: Partial<SimToken> = {}): SimToken => ({
  sub,
  issuer: "https://idp.example.test",
  audience: "dpp-suite-api",
  exp: NOW + 3600,
  sigValid: true,
  alg: "RS256",
  ...overrides,
});

describe("Layer 2 Cycle 7 deterministic contract simulator (P03 + P04)", () => {
  it("calibrates field-level customer PEP against N disclosure matrix (no denied/raw-derived fields leak)", async () => {
    const rec = await recordFor(pack, CLEAN);
    const cust = project(pack, rec, "customer");
    const denied = pack.properties.filter((p) => decide(pack, "customer", p.id) === "deny").map((p) => p.id);
    const derived = pack.properties.filter((p) => decide(pack, "customer", p.id) === "derived").map((p) => p.id);
    expect(denied.length).toBeGreaterThanOrEqual(2);
    expect(derived.length).toBeGreaterThanOrEqual(2);
    expect(cust.values.some((v) => denied.includes(v.property))).toBe(false);
    expect(cust.values.some((v) => derived.includes(v.property))).toBe(false);
    expect(cust.values.some((v) => v.property === byRole(pack, "evidence"))).toBe(false);
  });

  it("enforces exhaustive role x action matrix and immediate grant-epoch revocation (C7-01, C7-02)", () => {
    const sim = new Cycle7ContractSimulator("https://idp.example.test", "dpp-suite-api");
    for (const role of SERVER_ROLES) {
      sim.upsertUser(`user-${role}`, [role]);
      const tok = makeToken(`user-${role}`);
      for (const action of SERVER_ACTIONS) {
        const expected = ROLE_ACTION_MATRIX[role].includes(action);
        if (expected) {
          expect(sim.authorize(tok, action, NOW).roles).toContain(role);
        } else {
          expect(() => sim.authorize(tok, action, NOW)).toThrow(AuthError);
        }
      }
    }

    // Immediate next-request revocation while JWT is still unexpired (LEAN-DEF-03)
    const opTok = makeToken("user-ACT-01");
    expect(sim.authorize(opTok, "import-submit", NOW).grantEpoch).toBe(1);
    const nextEpoch = sim.revokeRole("user-ACT-01", "ACT-01");
    expect(nextEpoch).toBe(2);
    expect(() => sim.authorize(opTok, "import-submit", NOW + 1)).toThrow(AuthError);
  });

  it("enforces deployment surface separation between internal and customer listeners (C7-03)", () => {
    const custSurface = new Cycle7ContractSimulator("https://idp.example.test", "dpp-suite-api", "customer");
    custSurface.upsertUser("admin-1", ["ACT-19", "ACT-01", "ACT-06"]);
    const tok = makeToken("admin-1");
    expect(custSurface.authorize(tok, "record-read-customer", NOW).surface).toBe("customer");
    expect(custSurface.authorize(tok, "release-customer", NOW).surface).toBe("customer");
    expect(() => custSurface.authorize(tok, "import-submit", NOW)).toThrow(/customer deployment surface/);
    expect(() => custSurface.authorize(tok, "role-manage", NOW)).toThrow(/customer deployment surface/);

    const intSurface = new Cycle7ContractSimulator("https://idp.example.test", "dpp-suite-api", "internal");
    intSurface.upsertUser("cust-1", ["ACT-06"]);
    expect(() => intSurface.authorize(makeToken("cust-1"), "record-read-customer", NOW)).toThrow(/internal-only/);
  });

  it("enforces four-eyes config release & rollback and drop-one-input contract tightness (C7-04)", () => {
    const sim = new Cycle7ContractSimulator("https://idp.example.test", "dpp-suite-api");
    sim.upsertUser("curator-a", ["ACT-20"]);
    sim.upsertUser("approver-b", ["ACT-19"]);
    const curTok = makeToken("curator-a");
    const appTok = makeToken("approver-b");

    // Drop-one-input auth preconditions
    expect(() => sim.authorize(null, "config-propose", NOW)).toThrow(/Bearer token/);
    expect(() => sim.authorize(makeToken("curator-a", { alg: "none" }), "config-propose", NOW)).toThrow(/not permitted/);
    expect(() => sim.authorize(makeToken("curator-a", { sigValid: false }), "config-propose", NOW)).toThrow(/Invalid JWS/);
    expect(() => sim.authorize(makeToken("curator-a", { issuer: "https://evil.test" }), "config-propose", NOW)).toThrow(/Issuer/);
    expect(() => sim.authorize(makeToken("curator-a", { audience: "other" }), "config-propose", NOW)).toThrow(/Audience/);
    expect(() => sim.authorize(makeToken("curator-a", { exp: NOW - 1 }), "config-propose", NOW)).toThrow(/expired/);

    // Drop-one-input release preconditions: mutable latest refused
    expect(() =>
      sim.proposeRelease(curTok, { packageId: "PACK-ALU", version: "latest", manifestSha256: "a".repeat(64), note: "bad" }, NOW),
    ).toThrow(/Mutable version/);

    // Valid propose v1.0.0
    const r1 = sim.proposeRelease(curTok, { packageId: "PACK-ALU", version: "1.0.0", manifestSha256: "a".repeat(64), note: "initial" }, NOW);
    // Cannot activate before approval
    expect(() => sim.activateRelease(curTok, r1.releaseId, NOW)).toThrow(/Only approved/);
    // Four-eyes: proposer cannot self-approve
    expect(() => sim.approveRelease(curTok, r1.releaseId, NOW)).toThrow(/Four-eyes/);
    // Distinct approver approves, then curator activates
    sim.approveRelease(appTok, r1.releaseId, NOW);
    sim.activateRelease(curTok, r1.releaseId, NOW);

    // Upgrade v1.0.1 requires matching predecessorReleaseId
    expect(() =>
      sim.proposeRelease(curTok, { packageId: "PACK-ALU", version: "1.0.1", manifestSha256: "b".repeat(64), predecessorReleaseId: null, note: "missing pred" }, NOW),
    ).toThrow(/Expected predecessor/);
    const r2 = sim.proposeRelease(curTok, { packageId: "PACK-ALU", version: "1.0.1", manifestSha256: "b".repeat(64), predecessorReleaseId: r1.releaseId, note: "update" }, NOW);
    sim.approveRelease(appTok, r2.releaseId, NOW);
    sim.activateRelease(curTok, r2.releaseId, NOW);

    // Rollback requires reason and restores v1.0.0 cleanly
    expect(() => sim.rollbackRelease(curTok, r1.releaseId, "   ", NOW)).toThrow(/reason/);
    const back = sim.rollbackRelease(curTok, r1.releaseId, "Revert defective mapping", NOW);
    expect(back.releaseId).toBe(r1.releaseId);
    expect(back.state).toBe("active");
    expect(r2.state).toBe("rolled_back");
  });
});
