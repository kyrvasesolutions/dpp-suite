// @vitest-environment node
/**
 * Cycle 9 alignment verification tests:
 *  - C9-04: S5-EXCHANGE-rev2 portable DPPPayload (REC-ALU-24-01 with inline @context)
 *           vs RegistryRequest separation (refused by central-record import & exchange dispatcher).
 *  - C9-05: S5-SEM-CONTEXT-rev2 17-field typed operation context enforcement through assess(),
 *           including CONTEXT_TYPING_UNRESOLVED and CONTEXT_MISMATCH failure codes.
 *  - RT-21: Early HTTP 413 (oversize body) and 429 (rate limit) preserve Connection: close.
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../server/db/adapter";
import { migrateUp } from "../../server/db/migrations";
import { createDppServer } from "../../server/http/api";
import { PolicyStore } from "../../server/store/policyStore";
import { exportDppPayload, importCentralRecord } from "../../src/model/centralRecord";
import {
  REQUIRED_CONTEXT_FIELDS,
  buildOperationContext,
  buildOperationContextForRecord,
  dispatchExchangeEnvelope,
  validateOperationContext,
  type OperationContext,
} from "../../src/model/context";
import { buildRegistryJson } from "../../src/model/outputs/registryJson";
import type { ProfilePack } from "../../src/model/profile";
import { assess } from "../../src/model/readiness";
import { CLEAN, loadPack, recordFor } from "../support/records";
import { TEST_SOFTWARE } from "../support/release";

let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});

describe("C9-04 S5-EXCHANGE-rev2 exchange contract separation", () => {
  it("exports a deterministic REC-ALU-24-01 DPPPayload with inline @context and dispatches by explicit contract", async () => {
    const record = await recordFor(pack, CLEAN);
    const file = await exportDppPayload(pack, record);
    const payload = JSON.parse(file.text) as Record<string, unknown>;
    expect(payload["@context"]).toBeTypeOf("object");
    expect(payload.synthetic).toBe(true);
    expect(Object.keys(payload.properties as Record<string, unknown>)).toHaveLength(24);
    expect(dispatchExchangeEnvelope("DPPPayload", payload).ok).toBe(true);
    const wrongRoute = dispatchExchangeEnvelope("RegistryRequest", payload);
    expect(wrongRoute.ok).toBe(false);
    expect(wrongRoute.code).toBe("EXCHANGE_TYPE_MISMATCH");
  });

  it("produces a held RegistryRequest envelope that is rejected on DPPPayload and central-record import paths", async () => {
    const record = await recordFor(pack, CLEAN);
    const reg = buildRegistryJson(pack, record);
    const doc = JSON.parse(reg.text) as Record<string, unknown>;
    expect(doc.exchange_type).toBe("RegistryRequest");
    expect(doc.status).toBe("HOLD");
    expect(doc.code).toBe("TARGET_PROFILE_UNCONFIRMED");
    expect(doc.submission).toBe("never");
    expect(doc.not_a_registration_request).toBe(true);
    const onReg = dispatchExchangeEnvelope("RegistryRequest", doc);
    expect(onReg.status).toBe("HOLD");
    expect(onReg.code).toBe("HOLD_TARGET_PROFILE_UNCONFIRMED");
    const onDpp = dispatchExchangeEnvelope("DPPPayload", doc);
    expect(onDpp.ok).toBe(false);
    expect(onDpp.code).toBe("EXCHANGE_TYPE_MISMATCH");
    await expect(importCentralRecord(reg.bytes, pack)).rejects.toThrow();
  });
});

describe("C9-05 S5-SEM-CONTEXT-rev2 17-field typed operation context", () => {
  const ctxFor = (record: Awaited<ReturnType<typeof recordFor>>) =>
    buildOperationContext(pack, "customer", {
      model: record.model,
      revision: record.revision ?? "P01",
      batch: record.batch,
      manufacturerId: "ST-MFR-01",
    });

  it("constructs all 17 required fields and releases customer route when valid", async () => {
    const record = await recordFor(pack, CLEAN);
    const ctx = ctxFor(record);
    expect(Object.keys(ctx).sort()).toEqual([...REQUIRED_CONTEXT_FIELDS].sort());
    expect(REQUIRED_CONTEXT_FIELDS).toHaveLength(17);
    const r = assess(pack, record, { routes: ["customer"], context: { customer: ctx } })[0]!;
    expect(r.status).toBe("RELEASED");
  });

  it("holds with CONTEXT_TYPING_UNRESOLVED when a required field is missing, stale, or collides with tenant/recipient", async () => {
    const record = await recordFor(pack, CLEAN);
    const base = ctxFor(record);

    const missingField = { ...base, jurisdiction_context: "" } as OperationContext;
    const rMissing = assess(pack, record, { routes: ["customer"], context: { customer: missingField } })[0]!;
    expect(rMissing.status).toBe("HOLD");
    expect(rMissing.holds.some((h) => h.ruleId === "RR-CONTEXT-UNRESOLVED")).toBe(true);

    const staleProfile = { ...base, profile_release_id: "PROFILE-ALU-24-01@0.9.0" } as OperationContext;
    const rStale = assess(pack, record, { routes: ["customer"], context: { customer: staleProfile } })[0]!;
    expect(rStale.status).toBe("HOLD");
    expect(rStale.holds.some((h) => h.ruleId === "RR-CONTEXT-UNRESOLVED")).toBe(true);

    const recipientAsActor = { ...base, actor_id: base.recipient_id } as OperationContext;
    const rActor = assess(pack, record, { routes: ["customer"], context: { customer: recipientAsActor } })[0]!;
    expect(rActor.status).toBe("HOLD");
    expect(rActor.holds.some((h) => h.ruleId === "RR-CONTEXT-UNRESOLVED")).toBe(true);
  });

  it("enforces all 17 W-2 negative acceptance cases (rows 7-23 of context-bindings.tsv) and refuses missing context", async () => {
    const record = await recordFor(pack, CLEAN);
    const base = buildOperationContextForRecord(pack, "customer", record);

    // Explicit missing context holds with CONTEXT_TYPING_UNRESOLVED (never defaults away a missing binding)
    const missingCtx = assess(pack, record, { routes: ["customer"], context: {} })[0]!;
    expect(missingCtx.status).toBe("HOLD");
    expect(missingCtx.holds.some((h) => h.ruleId === "RR-CONTEXT-UNRESOLVED" && h.detail?.includes("CONTEXT_TYPING_UNRESOLVED"))).toBe(true);

    // All 17 W-2 rows negative acceptance cases:
    const cases: Array<[string, Partial<OperationContext>, "CONTEXT_TYPING_UNRESOLVED" | "CONTEXT_MISMATCH"]> = [
      ["row 7: manufacturer used as tenant", { tenant_or_security_domain_id: base.organization_id }, "CONTEXT_TYPING_UNRESOLVED"],
      ["row 8: site substituted for organization", { organization_id: "ST-SITE-01" }, "CONTEXT_TYPING_UNRESOLVED"],
      ["row 9: recipient ID in actor slot", { actor_id: base.recipient_id }, "CONTEXT_TYPING_UNRESOLVED"],
      ["row 10: mismatched or revoked role", { role_id: "REVOKED-ROLE" }, "CONTEXT_TYPING_UNRESOLVED"],
      ["row 11: bare model/URI substituted for batch subject", { subject_id: record.model, product_subject_id: record.model }, "CONTEXT_TYPING_UNRESOLVED"],
      ["row 12: record digest substituted for subject revision", { subject_revision: "a".repeat(64), product_revision: "a".repeat(64) }, "CONTEXT_TYPING_UNRESOLVED"],
      ["row 13: unknown product group code", { product_group_id: "unknown-group:9999" }, "CONTEXT_TYPING_UNRESOLVED"],
      ["row 14: stale profile release digest", { profile_release_id: "PROFILE-ALU-24-01@1.0.0#sha256:" + "0".repeat(64) }, "CONTEXT_TYPING_UNRESOLVED"],
      ["row 15: party substituted for chain node", { chain_node_id: base.organization_id, supplier_or_chain_node_id: base.organization_id }, "CONTEXT_TYPING_UNRESOLVED"],
      ["row 16: unknown encoded as inapplicable relation", { upstream_or_downstream_relation_id: { inapplicable: true, reason: "unknown relation" } }, "CONTEXT_TYPING_UNRESOLVED"],
      ["row 17: product_subject_id alias mismatch", { product_subject_id: "OTHER#batch:OTHER" }, "CONTEXT_MISMATCH"],
      ["row 18: product_revision alias mismatch", { product_revision: "P99" }, "CONTEXT_MISMATCH"],
      ["row 19: supplier_or_chain_node_id alias mismatch", { supplier_or_chain_node_id: "node:producer:OTHER" }, "CONTEXT_MISMATCH"],
      ["row 20: unknown recipient", { recipient_id: "UNKNOWN-RECIPIENT" }, "CONTEXT_TYPING_UNRESOLVED"],
      ["row 21: wrong-route purpose", { purpose: "synthetic_internal_staging" }, "CONTEXT_TYPING_UNRESOLVED"],
      ["row 22: recipient_country inferred from EU market", { jurisdiction_context: "site=DE;party=DE;target_market=EU;recipient_country=EU" }, "CONTEXT_TYPING_UNRESOLVED"],
      ["row 23a: zone-free timestamp", { relevant_time_basis: "production_date=2026-10-15;recorded=2026-10-16T12:00:00" }, "CONTEXT_TYPING_UNRESOLVED"],
      ["row 23b: invented midnight on date-only production_date", { relevant_time_basis: "production_date=2026-10-15T00:00:00Z;recorded=2026-10-16T00:00:00Z" }, "CONTEXT_TYPING_UNRESOLVED"],
    ];

    for (const [label, patch, expectedCode] of cases) {
      const mutated = { ...base, ...patch } as OperationContext;
      const r = assess(pack, record, { routes: ["customer"], context: { customer: mutated } })[0]!;
      expect(r.status, label).toBe("HOLD");
      expect(r.holds.some((h) => h.ruleId === "RR-CONTEXT-UNRESOLVED" && h.detail?.startsWith(expectedCode)), label).toBe(true);
    }

    // Also verify cross-tenant & unregistered-actor checks in validateOperationContext directly (W-2 rows 7 & 9)
    const pol = pack.contracts.profilePolicy;
    const baseOpts = {
      route: "customer" as const,
      expectedProfileReleaseId: `${pol.id}@${pol.version}#sha256:${pack.contracts.digests.profilePolicy}`,
      expectedRecipient: pol.customer.recipient,
      expectedPurpose: pol.customer.purpose,
      expectedTenantId: "tenant:dom-a",
      allowedActors: new Set(["actor:local-operator-01"]),
    };
    expect(validateOperationContext({ ...base, tenant_or_security_domain_id: "tenant:dom-b" }, baseOpts)).toMatchObject({
      ok: false,
      code: "CONTEXT_TYPING_UNRESOLVED",
    });
    expect(validateOperationContext({ ...base, tenant_or_security_domain_id: "tenant:dom-a", actor_id: "actor:unregistered" }, baseOpts)).toMatchObject({
      ok: false,
      code: "CONTEXT_TYPING_UNRESOLVED",
    });
  });
});

describe("RT-21 early HTTP 413 and 429 preserve Connection: close", () => {
  const dir = mkdtempSync(join(tmpdir(), "dpp-rt21-"));
  let db: SqliteAdapter;
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    db = new SqliteAdapter({ path: join(dir, "rt21.sqlite") });
    migrateUp(db);
    new PolicyStore(db).activate(pack.policy.retention);
    const limits = structuredClone(pack.operationalLimits);
    limits.http.max_request_body_bytes = 128;
    limits.http.rate_limit_write_per_window = 1;
    const server = createDppServer({
      db,
      pack,
      software: TEST_SOFTWARE,
      limits,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    close = () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  afterAll(async () => {
    await close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const sendPost = (body: string) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/jobs/import",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body)),
            Connection: "keep-alive",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });

  it("sends Connection: close on early 413 (body too large) and 429 (rate limited)", async () => {
    const r413 = await sendPost("x".repeat(512));
    expect(r413.status).toBe(413);
    expect(String(r413.headers.connection ?? "").toLowerCase()).toBe("close");

    // First small write consumes the 1/min write bucket, second hits 429
    await sendPost("{}");
    const r429 = await sendPost("{}");
    expect(r429.status).toBe(429);
    expect(String(r429.headers.connection ?? "").toLowerCase()).toBe("close");
  });
});
