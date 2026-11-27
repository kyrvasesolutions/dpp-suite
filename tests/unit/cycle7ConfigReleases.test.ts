// @vitest-environment node
/**
 * Cycle 7 Layer 3 (`C7-04`, `LEAN-DEF-14`, `EV-6`):
 * Verifies the complete controlled configuration package release lifecycle over HTTP:
 * bootstrap -> reject invalid/mutable/weakened-retention proposals -> propose valid upgrade
 * (code-list + RETENTION@1.1.0) -> four-eyes approve -> activate (live import immediately accepts
 * new code and applies new retention horizon) -> rollback with mandatory reason (live server
 * reverts code-list and retention policy cleanly) -> complete append-only audit trail.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readPack } from "../../config/contractPack";
import { GrantStore } from "../../server/auth/grantStore";
import { SqliteAdapter } from "../../server/db/adapter";
import { migrateUp } from "../../server/db/migrations";
import { createDppServer } from "../../server/http/api";
import { ConfigReleaseStore } from "../../server/releases/configReleaseStore";
import { PolicyStore } from "../../server/store/policyStore";
import type { PackSource, ProfilePack } from "../../src/model/profile";
import { fixtureBytes } from "../support/fixtures";
import { buildPackageProposal, createTestIdp } from "../support/oidc";
import { CLEAN, loadPack } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

const tmpDir = mkdtempSync(join(tmpdir(), "dpp-c7-cfg-"));
const idp = createTestIdp();
const NOW = "2026-11-22T12:00:00.000Z";

let pack: ProfilePack;
let packSource: PackSource;
let db: SqliteAdapter;
let baseUrl: string;
let closeServer: () => Promise<void>;
let initialReleaseId: string;

const jsonAuth = (token: string, extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  ...extra,
});

beforeAll(async () => {
  packSource = readPack("contracts/n");
  pack = await loadPack();
  db = new SqliteAdapter({ path: join(tmpDir, "cfg.sqlite") });
  migrateUp(db);
  new PolicyStore(db).activate(pack.policy.retention, NOW);

  const cfgStore = new ConfigReleaseStore(db, undefined, { now: () => NOW });
  const init = await cfgStore.bootstrapActivePack(packSource, pack.id, pack.version);
  initialReleaseId = init.releaseId;

  const grants = new GrantStore(db, undefined, { now: () => NOW });
  grants.upsertUser({ sub: "cur-1", displayName: "Curator One", roles: ["ACT-20"], actorSub: "bootstrap", reason: "Seed curator 1" });
  grants.upsertUser({ sub: "cur-2", displayName: "Curator Two", roles: ["ACT-20"], actorSub: "bootstrap", reason: "Seed curator 2" });
  grants.upsertUser({ sub: "op-1", displayName: "Operator", roles: ["ACT-01"], actorSub: "bootstrap", reason: "Seed operator" });

  const server = createDppServer({
    db,
    pack,
    software: TEST_SOFTWARE,
    authMode: "oidc",
    surface: "all",
    oidc: idp.oidcConfig,
    now: () => NOW,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

afterAll(async () => {
  await closeServer();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Cycle 7 controlled configuration package releases & rollback (C7-04)", () => {
  it("refuses mutable versions, wrong predecessors, broken digests, and weakened retention policies", async () => {
    const cur1 = idp.signRs256({ sub: "cur-1" });

    // 1. Mutable version "latest" refused
    const latestProp = buildPackageProposal(packSource, {
      version: "latest",
      predecessorReleaseId: initialReleaseId,
      note: "Mutable tag attempt",
    });
    const rLatest = await fetch(`${baseUrl}/api/config-releases/propose`, {
      method: "POST",
      headers: jsonAuth(cur1),
      body: JSON.stringify(latestProp),
    });
    expect(rLatest.status).toBe(400);
    expect(((await rLatest.json()) as { code: string }).code).toBe("mutable-version-forbidden");

    // 2. Wrong predecessor refused
    const badPred = buildPackageProposal(packSource, {
      version: "1.0.9",
      predecessorReleaseId: "REL-nonexistent",
      note: "Wrong predecessor",
    });
    const rPred = await fetch(`${baseUrl}/api/config-releases/propose`, {
      method: "POST",
      headers: jsonAuth(cur1),
      body: JSON.stringify(badPred),
    });
    expect(rPred.status).toBe(409);
    expect(((await rPred.json()) as { code: string }).code).toBe("predecessor-mismatch");

    // 3. Broken file digest refused
    const badDigest = buildPackageProposal(packSource, {
      version: "1.0.8",
      predecessorReleaseId: initialReleaseId,
      note: "Tampered digest",
    });
    badDigest.manifest.files["code-lists/TEMPER@1.0.0.csv"] = "0".repeat(64);
    const rDigest = await fetch(`${baseUrl}/api/config-releases/propose`, {
      method: "POST",
      headers: jsonAuth(cur1),
      body: JSON.stringify(badDigest),
    });
    expect(rDigest.status).toBe(400);
    expect(((await rDigest.json()) as { code: string }).code).toBe("invalid-package");

    // 4. Weakened retention policy (< 3650 days floor) refused
    const weakRet = buildPackageProposal(packSource, {
      version: "1.0.7",
      predecessorReleaseId: initialReleaseId,
      note: "Attempt to shorten retention to 1 year",
      mutateFiles: (files) => {
        const oldRet = files["policy/RETENTION@1.0.0.yaml"]!;
        delete files["policy/RETENTION@1.0.0.yaml"];
        files["policy/RETENTION@1.0.7.yaml"] = oldRet
          .replace("version: 1.0.0", "version: 1.0.7")
          .replaceAll("3650", "365");
        files["profile/PROFILE-ALU-24-01@1.0.0.yaml"] = files["profile/PROFILE-ALU-24-01@1.0.0.yaml"]!.replace(
          "RETENTION@1.0.0",
          "RETENTION@1.0.7",
        );
      },
    });
    const rWeak = await fetch(`${baseUrl}/api/config-releases/propose`, {
      method: "POST",
      headers: jsonAuth(cur1),
      body: JSON.stringify(weakRet),
    });
    expect(rWeak.status).toBe(400);
    expect(((await rWeak.json()) as { code: string }).code).toBe("retention-floor-violation");
  });

  it("proposes, four-eyes approves, activates a live pack upgrade, and rolls back cleanly with full audit trail", async () => {
    const cur1 = idp.signRs256({ sub: "cur-1" });
    const cur2 = idp.signEs256({ sub: "cur-2" });
    const op1 = idp.signRs256({ sub: "op-1" });

    // Helper: ERP CSV with temper "H14" (absent from initial TEMPER@1.0.0.csv, added in release 1.1.0)
    const cleanErpText = new TextDecoder().decode(fixtureBytes("n", CLEAN.erp));
    const delim = pack.inputs.erp.delimiter;
    const temperColName = pack.inputs.erp.columns.find((c) => c.code_list?.startsWith("TEMPER"))!.name;
    const lines = cleanErpText.split(/\r?\n/);
    const headers = lines[0]!.split(delim);
    const temperIdx = headers.indexOf(temperColName);
    expect(temperIdx).toBeGreaterThanOrEqual(0);
    const rowCols = lines[1]!.split(delim);
    rowCols[temperIdx] = "H14";
    lines[1] = rowCols.join(delim);
    const h14ErpText = lines.join("\n");
    expect(h14ErpText).not.toBe(cleanErpText);
    const labB64 = Buffer.from(fixtureBytes("n", CLEAN.lab)).toString("base64");

    // 0. Before upgrade: H14 temper is flagged `unknown-code` under initial 1.0.0 pack (and gets 3650-day retention)
    const preImp = await fetch(`${baseUrl}/api/jobs/import`, {
      method: "POST",
      headers: jsonAuth(op1, { "X-Idempotency-Key": "cfg-pre-h14" }),
      body: JSON.stringify({
        erp: { name: "erp-h14.csv", type: "text/csv", text: h14ErpText },
        lab: { name: CLEAN.lab, type: "application/json", base64: labB64 },
      }),
    });
    expect(preImp.status).toBe(200);
    const preBody = (await preImp.json()) as {
      ok: boolean;
      receipt: { policyPin: string; retentionUntil: string };
      snapshot: { model: string; batch: string; version: number };
    };
    // The import answer is a bounded summary (D8-12): the record is read from the history of the record.
    const preHist = (await (await fetch(`${baseUrl}/api/records/${encodeURIComponent(preBody.snapshot.model)}/${encodeURIComponent(preBody.snapshot.batch)}/history`, { headers: jsonAuth(op1) })).json()) as {
      history: Array<{ version: number; record: { values: Array<{ property: string; assertions: Array<{ flags: string[] }> }> } }>;
    };
    const preRecord = preHist.history.find((h) => h.version === preBody.snapshot.version)!.record;
    const temperProp = pack.inputs.erp.columns.find((c) => c.code_list?.startsWith("TEMPER"))!.maps_to.split("/")[0]!;
    const preTemperFlags = preRecord.values.find((v) => v.property === temperProp)!.assertions[0]!.flags;
    expect(preTemperFlags).toContain("unknown-code");
    expect(preBody.receipt.policyPin).toBe("RETENTION@1.0.0");
    expect(preBody.receipt.retentionUntil).toBe("2036-11-19T12:00:00.000Z");

    // Operator correction to H14 is refused under 1.0.0 because H14 is not in TEMPER@1.0.0.csv
    const preCorr = await fetch(
      `${baseUrl}/api/records/${encodeURIComponent(preBody.snapshot.model)}/${encodeURIComponent(preBody.snapshot.batch)}/correct`,
      {
        method: "POST",
        headers: jsonAuth(op1),
        body: JSON.stringify({ property: temperProp, member: "FLD-DesignationRef-designation", raw: "H14", reason: "Attempt H14 before code-list release" }),
      },
    );
    expect(preCorr.status).toBe(400);

    // 1. CURATOR #1 proposes 1.1.0 adding temper H14 + upgrading retention policy to RETENTION@1.1.0 (4015 days = 11 years)
    const upgrade = buildPackageProposal(packSource, {
      version: "1.1.0",
      predecessorReleaseId: initialReleaseId,
      note: "Add H14 temper code and extend retention horizon to 4015 days",
      mutateFiles: (files) => {
        files["code-lists/TEMPER@1.0.0.csv"] = `${files["code-lists/TEMPER@1.0.0.csv"]}H14\n`;
        const oldRet = files["policy/RETENTION@1.0.0.yaml"]!;
        delete files["policy/RETENTION@1.0.0.yaml"];
        files["policy/RETENTION@1.1.0.yaml"] = oldRet
          .replace("version: 1.0.0", "version: 1.1.0")
          .replaceAll("3650", "4015");
        files["profile/PROFILE-ALU-24-01@1.0.0.yaml"] = files["profile/PROFILE-ALU-24-01@1.0.0.yaml"]!.replace(
          "RETENTION@1.0.0",
          "RETENTION@1.1.0",
        );
      },
    });
    const propRes = await fetch(`${baseUrl}/api/config-releases/propose`, {
      method: "POST",
      headers: jsonAuth(cur1),
      body: JSON.stringify(upgrade),
    });
    expect(propRes.status).toBe(201);
    const { release: proposed } = (await propRes.json()) as {
      release: { releaseId: string; packageId: string; version: string; state: string; manifestSha256: string };
    };
    expect(proposed.packageId).toBe("PROFILE-ALU-24-01");
    expect(proposed.version).toBe("1.1.0");
    expect(proposed.state).toBe("validated");
    expect(proposed.manifestSha256).toMatch(/^[0-9a-f]{64}$/);

    // 2. CURATOR #2 approves under four-eyes
    const appRes = await fetch(`${baseUrl}/api/config-releases/${proposed.releaseId}/approve`, {
      method: "POST",
      headers: jsonAuth(cur2),
      body: JSON.stringify({ reason: "Verified H14 temper addition and 4015-day retention upgrade" }),
    });
    expect(appRes.status).toBe(200);
    expect(((await appRes.json()) as { release: { state: string; approvedBy: string } }).release).toMatchObject({
      state: "approved",
      approvedBy: "cur-2",
    });

    // 3. CURATOR #2 activates 1.1.0 -> live health, retention policy, and import validation immediately reflect 1.1.0!
    const actRes = await fetch(`${baseUrl}/api/config-releases/${proposed.releaseId}/activate`, {
      method: "POST",
      headers: jsonAuth(cur2),
      body: JSON.stringify({ reason: "Scheduled configuration release window" }),
    });
    expect(actRes.status).toBe(200);
    const activated = (await actRes.json()) as { activeRetentionPolicy: string; packManifestDigest: string };
    expect(activated.activeRetentionPolicy).toBe("RETENTION@1.1.0");
    expect(activated.packManifestDigest).not.toBe(pack.manifestDigest);

    const healthUp = (await (await fetch(`${baseUrl}/api/health`)).json()) as {
      activeRetentionPolicy: string;
      activeConfigReleaseId: string;
      packManifestDigest: string;
    };
    expect(healthUp.activeRetentionPolicy).toBe("RETENTION@1.1.0");
    expect(healthUp.activeConfigReleaseId).toBe(proposed.releaseId);
    expect(healthUp.packManifestDigest).toBe(activated.packManifestDigest);

    // Import with H14 temper NOW SUCCEEDS with NO `unknown-code` flag and gets 4015-day retention!
    const postImp = await fetch(`${baseUrl}/api/jobs/import`, {
      method: "POST",
      headers: jsonAuth(op1, { "X-Idempotency-Key": "cfg-post-h14" }),
      body: JSON.stringify({
        erp: { name: "erp-h14.csv", type: "text/csv", text: h14ErpText },
        lab: { name: CLEAN.lab, type: "application/json", base64: labB64 },
      }),
    });
    expect(postImp.status).toBe(200);
    const postBody = (await postImp.json()) as {
      ok: boolean;
      receipt: { retentionUntil: string; policyPin: string };
      snapshot: { model: string; batch: string; version: number };
    };
    expect(postBody.ok).toBe(true);
    expect(postBody.receipt.policyPin).toBe("RETENTION@1.1.0");
    expect(postBody.receipt.retentionUntil).toBe("2037-11-19T12:00:00.000Z");
    const postHist = (await (await fetch(`${baseUrl}/api/records/${encodeURIComponent(postBody.snapshot.model)}/${encodeURIComponent(postBody.snapshot.batch)}/history`, { headers: jsonAuth(op1) })).json()) as {
      history: Array<{ version: number; record: { values: Array<{ property: string; assertions: Array<{ flags: string[] }> }> } }>;
    };
    const postRecord = postHist.history.find((h) => h.version === postBody.snapshot.version)!.record;
    const postTemperFlags = postRecord.values.find((v) => v.property === temperProp)!.assertions[0]!.flags;
    expect(postTemperFlags).not.toContain("unknown-code");

    // Re-import clean H111 ERP, then verify operator correction H111 -> H14 NOW SUCCEEDS under 1.1.0!
    const cleanB64 = Buffer.from(fixtureBytes("n", CLEAN.erp)).toString("base64");
    expect(
      (
        await fetch(`${baseUrl}/api/jobs/import`, {
          method: "POST",
          headers: jsonAuth(op1, { "X-Idempotency-Key": "cfg-clean-before-corr" }),
          body: JSON.stringify({
            erp: { name: CLEAN.erp, type: "text/csv", base64: cleanB64 },
            lab: { name: CLEAN.lab, type: "application/json", base64: labB64 },
          }),
        })
      ).status,
    ).toBe(200);

    const postCorr = await fetch(
      `${baseUrl}/api/records/${encodeURIComponent(postBody.snapshot.model)}/${encodeURIComponent(postBody.snapshot.batch)}/correct`,
      {
        method: "POST",
        headers: jsonAuth(op1),
        body: JSON.stringify({ property: temperProp, member: "FLD-DesignationRef-designation", raw: "H14", reason: "Confirmed H14 under active 1.1.0 code list" }),
      },
    );
    expect(postCorr.status).toBe(200);

    // 4. CURATOR #2 rolls back to 1.0.0 with mandatory reason
    const rbRes = await fetch(`${baseUrl}/api/config-releases/rollback`, {
      method: "POST",
      headers: jsonAuth(cur2),
      body: JSON.stringify({
        packageId: "PROFILE-ALU-24-01",
        reason: "Reverting 1.1.0 after customer temper code table audit",
      }),
    });
    expect(rbRes.status).toBe(200);
    const rb = (await rbRes.json()) as {
      release: { releaseId: string; state: string };
      rolledBackFrom: string;
      activeRetentionPolicy: string;
      packManifestDigest: string;
    };
    expect(rb.release.releaseId).toBe(initialReleaseId);
    expect(rb.release.state).toBe("active");
    expect(rb.rolledBackFrom).toBe(proposed.releaseId);
    expect(rb.activeRetentionPolicy).toBe("RETENTION@1.0.0");
    expect(rb.packManifestDigest).toBe(pack.manifestDigest);

    // 5. After rollback, H14 temper is once again flagged `unknown-code`, retention reverts to 3650d,
    //    operator correction to H14 is once again refused, and events are recorded immutably!
    const afterRbImp = await fetch(`${baseUrl}/api/jobs/import`, {
      method: "POST",
      headers: jsonAuth(op1, { "X-Idempotency-Key": "cfg-after-rb-h14" }),
      body: JSON.stringify({
        erp: { name: "erp-h14.csv", type: "text/csv", text: h14ErpText },
        lab: { name: CLEAN.lab, type: "application/json", base64: labB64 },
      }),
    });
    expect(afterRbImp.status).toBe(200);
    const afterRbBody = (await afterRbImp.json()) as {
      receipt: { retentionUntil: string; policyPin: string };
      snapshot: { model: string; batch: string; version: number };
    };
    expect(afterRbBody.receipt.policyPin).toBe("RETENTION@1.0.0");
    expect(afterRbBody.receipt.retentionUntil).toBe("2036-11-19T12:00:00.000Z");
    const afterRbHist = (await (await fetch(`${baseUrl}/api/records/${encodeURIComponent(afterRbBody.snapshot.model)}/${encodeURIComponent(afterRbBody.snapshot.batch)}/history`, { headers: jsonAuth(op1) })).json()) as {
      history: Array<{ version: number; record: { values: Array<{ property: string; assertions: Array<{ flags: string[] }> }> } }>;
    };
    const afterRbRecord = afterRbHist.history.find((h) => h.version === afterRbBody.snapshot.version)!.record;
    expect(
      afterRbRecord.values.find((v) => v.property === temperProp)!.assertions.flatMap((a) => a.flags),
    ).toContain("unknown-code");

    const afterRbCorr = await fetch(
      `${baseUrl}/api/records/${encodeURIComponent(afterRbBody.snapshot.model)}/${encodeURIComponent(afterRbBody.snapshot.batch)}/correct`,
      {
        method: "POST",
        headers: jsonAuth(op1),
        body: JSON.stringify({ property: temperProp, member: "FLD-DesignationRef-designation", raw: "H14", reason: "Attempt H14 after rollback" }),
      },
    );
    expect(afterRbCorr.status).toBe(400);

    const detailUp = (await (
      await fetch(`${baseUrl}/api/config-releases/${proposed.releaseId}`, {
        headers: { Authorization: `Bearer ${cur1}` },
      })
    ).json()) as { release: { state: string }; events: Array<{ event: string }> };
    expect(detailUp.release.state).toBe("rolled_back");
    expect(detailUp.events.map((e) => e.event)).toEqual(["proposed", "approved", "activated", "rolled-back"]);

    const detailInit = (await (
      await fetch(`${baseUrl}/api/config-releases/${initialReleaseId}`, {
        headers: { Authorization: `Bearer ${cur1}` },
      })
    ).json()) as { release: { state: string }; events: Array<{ event: string }> };
    expect(detailInit.release.state).toBe("active");
    expect(detailInit.events.map((e) => e.event)).toEqual(["proposed", "approved", "activated", "superseded", "activated"]);
  });

  it("blocks Validator 4 hardening edge cases: rogue packageId, pin-conflict at propose, snapshot retention weakening, duplicate dataset, case four-eyes bypass, and rollback to never-activated release", async () => {
    const cur1 = idp.signRs256({ sub: "cur-1" });
    const cur2 = idp.signEs256({ sub: "cur-2" });
    const store = new ConfigReleaseStore(db, undefined, { now: () => NOW });

    // 1. Rogue packageId shadowing PROFILE-ALU-24-01 refused
    const roguePkg = buildPackageProposal(packSource, {
      packageId: "ROGUE-PKG",
      version: "1.0.0",
      predecessorReleaseId: null,
      note: "Attempt package shadowing",
    });
    const rRogue = await fetch(`${baseUrl}/api/config-releases/propose`, {
      method: "POST",
      headers: jsonAuth(cur1),
      body: JSON.stringify(roguePkg),
    });
    expect(rRogue.status).toBe(400);

    // 2. Weakening central-record-snapshot retention refused at propose()
    const weakSnap = buildPackageProposal(packSource, {
      version: "1.0.6",
      predecessorReleaseId: initialReleaseId,
      note: "Attempt snapshot downgrade",
      mutateFiles: (files) => {
        const oldRet = files["policy/RETENTION@1.0.0.yaml"]!;
        delete files["policy/RETENTION@1.0.0.yaml"];
        files["policy/RETENTION@1.0.6.yaml"] = oldRet
          .replace("version: 1.0.0", "version: 1.0.6")
          .replace(
            "  - dataset: central-record-snapshot\n    classification: restricted\n    retention_days: 3650",
            "  - dataset: central-record-snapshot\n    classification: public\n    retention_days: 1",
          );
        files["profile/PROFILE-ALU-24-01@1.0.0.yaml"] = files["profile/PROFILE-ALU-24-01@1.0.0.yaml"]!.replace(
          "RETENTION@1.0.0",
          "RETENTION@1.0.6",
        );
      },
    });
    const rWeakSnap = await fetch(`${baseUrl}/api/config-releases/propose`, {
      method: "POST",
      headers: jsonAuth(cur1),
      body: JSON.stringify(weakSnap),
    });
    expect(rWeakSnap.status).toBe(400);
    expect(((await rWeakSnap.json()) as { code: string }).code).toBe("retention-floor-violation");

    // 3. Reusing RETENTION@1.0.0 pin with modified content refused early at propose() with 409
    const pinReuse = buildPackageProposal(packSource, {
      version: "1.0.5",
      predecessorReleaseId: initialReleaseId,
      note: "Attempt reusing RETENTION@1.0.0 with changed days",
      mutateFiles: (files) => {
        files["policy/RETENTION@1.0.0.yaml"] = files["policy/RETENTION@1.0.0.yaml"]!.replaceAll("3650", "4015");
      },
    });
    const rPinReuse = await fetch(`${baseUrl}/api/config-releases/propose`, {
      method: "POST",
      headers: jsonAuth(cur1),
      body: JSON.stringify(pinReuse),
    });
    expect(rPinReuse.status).toBe(409);

    // 4. Case/whitespace four-eyes self-approval refused & rollback to never-activated approved release refused
    const prop = buildPackageProposal(packSource, {
      version: "1.2.0",
      predecessorReleaseId: initialReleaseId,
      note: "Approved but never activated release",
      mutateFiles: (files) => {
        files["code-lists/TEMPER@1.0.0.csv"] = `${files["code-lists/TEMPER@1.0.0.csv"]}H16\n`;
      },
    });
    const created = await store.propose(prop, "cur-1");
    expect(() => store.approve(created.releaseId, "CUR-1", "Case bypass")).toThrow(/Four-eyes/i);
    expect(() => store.approve(created.releaseId, " cur-1 ", "Whitespace bypass")).toThrow(/valid non-empty actor/i);

    // Approve legitimately by cur-2, then verify rollback cannot target never-activated approved release
    store.approve(created.releaseId, "cur-2", "Legitimate second reviewer");
    const rbUnact = await fetch(`${baseUrl}/api/config-releases/rollback`, {
      method: "POST",
      headers: jsonAuth(cur2),
      body: JSON.stringify({
        packageId: "PROFILE-ALU-24-01",
        targetReleaseId: created.releaseId,
        reason: "Attempt rollback to never-activated approved release",
      }),
    });
    expect(rbUnact.status).toBe(409);
    expect(((await rbUnact.json()) as { code: string }).code).toBe("invalid-state");

    // 5. Cross-domain PolicyStore isolation: activating in domain-b does NOT clobber default domain
    const domainBStore = new ConfigReleaseStore(db, "domain-b", { now: () => NOW });
    const bInit = await domainBStore.bootstrapActivePack(packSource);
    const bProp = buildPackageProposal(packSource, {
      version: "2.0.0",
      predecessorReleaseId: bInit.releaseId,
      note: "Domain-B retention upgrade",
      mutateFiles: (files) => {
        const oldRet = files["policy/RETENTION@1.0.0.yaml"]!;
        delete files["policy/RETENTION@1.0.0.yaml"];
        files["policy/RETENTION@2.0.0.yaml"] = oldRet.replace("version: 1.0.0", "version: 2.0.0").replaceAll("3650", "5000");
        files["profile/PROFILE-ALU-24-01@1.0.0.yaml"] = files["profile/PROFILE-ALU-24-01@1.0.0.yaml"]!.replace(
          "RETENTION@1.0.0",
          "RETENTION@2.0.0",
        );
      },
    });
    const bRel = await domainBStore.propose(bProp, "cur-1");
    domainBStore.approve(bRel.releaseId, "cur-2", "Approve domain-b");
    await domainBStore.activate(bRel.releaseId, "cur-2", "Activate domain-b");

    expect(new PolicyStore(db, "domain-b").requireActive().policyPin).toBe("RETENTION@2.0.0");
    expect(new PolicyStore(db).requireActive().policyPin).toBe("RETENTION@1.0.0");
  });
});
