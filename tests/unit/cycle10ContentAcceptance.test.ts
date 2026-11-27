// @vitest-environment node
/**
 * Cycle 10 Layer 3 (`FUNC-042`, `FUNC-043`, `FUNC-085`, `FUNC-126`):
 * Verifies deterministic production content acceptance across stand-in and private packs,
 * live `derive()` unrounded uncertainty-aware screening at the active pack's own threshold,
 * negative mutation tests proving tampered packs fail, bilingual terminology & string material-code
 * preservation, standing EU registry hold, and HTTP RBAC enforcement.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readPack } from "../../config/contractPack";
import { GrantStore } from "../../server/auth/grantStore";
import { SqliteAdapter } from "../../server/db/adapter";
import { migrateUp } from "../../server/db/migrations";
import { createDppServer } from "../../server/http/api";
import { evaluateContentAcceptance, evaluateLeadScreeningBound } from "../../server/ops/contentAcceptance";
import { PolicyStore } from "../../server/store/policyStore";
import { buildRegistryJson } from "../../src/model/outputs/registryJson";
import { loadProfilePack, type ProfilePack } from "../../src/model/profile";
import { createTestIdp } from "../support/oidc";
import { CLEAN, loadPack, recordsFor } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const tmpDir = mkdtempSync(join(tmpdir(), "dpp-c10-content-"));
const idp = createTestIdp();
const nowIso = "2026-11-27T11:15:00.000Z";
let pack: ProfilePack;

beforeAll(async () => {
  pack = await loadPack();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Cycle 10 production content acceptance & standing registry hold", () => {
  it("passes all content acceptance checks on the pinned stand-in pack and derives registry hold fields directly from the pack", () => {
    const report = evaluateContentAcceptance(pack);
    expect(report.passed).toBe(true);
    expect(report.propertyCount).toBe(24);
    expect(report.registryProfileConfirmed).toBe(false);
    expect(report.registrySubmission).toBe("never");
    expect(report.registryHoldReason).toContain("TARGET_PROFILE_UNCONFIRMED");
    expect(report.checks.every((c) => c.passed)).toBe(true);
  });

  it("enforces unrounded uncertainty-aware lead screening at the active pack threshold", () => {
    const T = pack.contracts.profilePolicy.screening_rule!.threshold_mg_per_kg;
    expect(evaluateLeadScreeningBound(T - 10, 2.5, T).passes).toBe(true);
    expect(evaluateLeadScreeningBound(T - 2.5, 2.5, T)).toEqual({ upperBound: T, passes: false });
    expect(evaluateLeadScreeningBound(T - 2.51, 2.52, T).passes).toBe(false);
    expect(evaluateLeadScreeningBound(T - 2.51, 2.5, T).passes).toBe(true);
  });

  it("fails content acceptance when screening threshold, operator, decimal separator, or registry hold is tampered with", () => {
    // 1. Tampered screening threshold parity mismatch
    const badScreen = structuredClone(pack);
    badScreen.contracts.profilePolicy.screening_rule!.threshold_mg_per_kg += 10;
    const rScreen = evaluateContentAcceptance(badScreen);
    expect(rScreen.passed).toBe(false);
    expect(rScreen.checks.find((c) => c.id === "P08-04-unrounded-uncertainty-threshold")?.passed).toBe(false);

    // 2. Missing required customer export operator
    const badOp = structuredClone(pack);
    badOp.contracts.exportCustomer.rules = badOp.contracts.exportCustomer.rules.filter(
      (r) => r.operator !== "synthetic_guard_band_screen",
    );
    const rOp = evaluateContentAcceptance(badOp);
    expect(rOp.passed).toBe(false);
    expect(rOp.checks.find((c) => c.id === "P08-03-release-pinned-operators")?.passed).toBe(false);

    // 3. Language-dependent decimal separator
    const badSep = structuredClone(pack);
    badSep.inputs.erp.decimal_separator = ",";
    const rSep = evaluateContentAcceptance(badSep);
    expect(rSep.passed).toBe(false);
    expect(rSep.checks.find((c) => c.id === "P08-06-terminology-and-company-encodings")?.passed).toBe(false);

    // 4. Registry profile prematurely flipped to confirmed
    const badReg = structuredClone(pack);
    badReg.contracts.profilePolicy.registry.aluminium_registration_profile_confirmed = true;
    const rReg = evaluateContentAcceptance(badReg);
    expect(rReg.passed).toBe(false);
    expect(rReg.registryProfileConfirmed).toBe(true);
    expect(rReg.checks.find((c) => c.id === "P08-07-standing-registry-hold")?.passed).toBe(false);
  });

  it("keeps RegistryRequest strictly on HOLD with TARGET_PROFILE_UNCONFIRMED and submission=never", async () => {
    const [record] = await recordsFor(pack, CLEAN);
    const reg = await buildRegistryJson(pack, record!);
    const parsed = JSON.parse(new TextDecoder().decode(reg.bytes)) as {
      status: string;
      submission: string;
      hold_reason: string;
    };
    expect(parsed.status).toBe("HOLD");
    expect(parsed.submission).toBe("never");
    expect(parsed.hold_reason).toContain("TARGET_PROFILE_UNCONFIRMED");
  });

  it("exposes GET /api/admin/content-acceptance to ACT-19, ACT-20, and ACT-17 while denying ACT-01 and ACT-06", async () => {
    const db = new SqliteAdapter({ path: join(tmpDir, "content-api.sqlite") });
    migrateUp(db);
    new PolicyStore(db).activate(pack.policy.retention, nowIso);
    const grants = new GrantStore(db, undefined, { now: () => nowIso });
    grants.upsertUser({ sub: "ops-1", displayName: "Ops", roles: ["ACT-19"], actorSub: "bootstrap", reason: "Seed" });
    grants.upsertUser({ sub: "cur-1", displayName: "Curator", roles: ["ACT-20"], actorSub: "ops-1", reason: "Seed" });
    grants.upsertUser({ sub: "aud-1", displayName: "Auditor", roles: ["ACT-17"], actorSub: "ops-1", reason: "Seed" });
    grants.upsertUser({ sub: "op-1", displayName: "Operator", roles: ["ACT-01"], actorSub: "ops-1", reason: "Seed" });
    grants.upsertUser({ sub: "cust-1", displayName: "Customer", roles: ["ACT-06"], actorSub: "ops-1", reason: "Seed" });

    const server = createDppServer({
      db,
      pack,
      software: TEST_SOFTWARE,
      authMode: "oidc",
      surface: "internal",
      oidc: idp.oidcConfig,
      now: () => nowIso,
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const nowSec = Math.floor(Date.parse(nowIso) / 1000);
    const sign = (sub: string) => idp.signRs256({ sub, iat: nowSec - 60, exp: nowSec + 3600 });
    try {
      for (const sub of ["ops-1", "cur-1", "aud-1"]) {
        const res = await fetch(`${base}/api/admin/content-acceptance`, {
          headers: { Authorization: `Bearer ${sign(sub)}` },
        });
        expect(res.status, sub).toBe(200);
        const body = (await res.json()) as { report: { passed: boolean; registrySubmission: string } };
        expect(body.report.passed).toBe(true);
        expect(body.report.registrySubmission).toBe("never");
      }
      for (const sub of ["op-1", "cust-1"]) {
        const denied = await fetch(`${base}/api/admin/content-acceptance`, {
          headers: { Authorization: `Bearer ${sign(sub)}` },
        });
        expect(denied.status, sub).toBe(403);
      }
    } finally {
      await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
      db.close();
    }
  });

  const PRIVATE_PACK_DIR = resolve("spec/contracts/n");
  it.runIf(existsSync(join(PRIVATE_PACK_DIR, "MANIFEST.json")))(
    "passes all content acceptance checks on the local private specification pack",
    async () => {
      const privatePack = await loadProfilePack(readPack(PRIVATE_PACK_DIR));
      const report = evaluateContentAcceptance(privatePack);
      expect(report.passed).toBe(true);
      expect(report.propertyCount).toBe(24);
      expect(report.registryProfileConfirmed).toBe(false);
      expect(report.registrySubmission).toBe("never");
    },
  );
});
