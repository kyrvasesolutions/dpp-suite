// @vitest-environment node
/**
 * Cycle 8 validation round 3 regressions (V1-10, V1-11, V2-12, V2-13, R3-01, R3-02, R3-03).
 */
import { connect } from "node:net";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import { JobCoordinatorModel, OVERTAKE_LIMIT } from "../../src/model/c8Contracts";
import { byRole, importLabJson, MAX_TEXT_FIELD_CHARS } from "../../src/model/ingress";
import { wrap } from "../../src/model/outputs/customerPdf";
import { generateRelease } from "../../src/model/outputs/release";
import { assess } from "../../src/model/readiness";
import { readPack } from "../../config/contractPack";
import { ConfigReleaseStore } from "../../server/releases/configReleaseStore";
import { NO_RATE_PRESSURE, get, importBody, post, startC8Server, until, type C8Server, type LimitsPatch } from "../support/c8Server";
import { fixtureBytes } from "../support/fixtures";
import { CLEAN, loadPack, recordsFor } from "../support/records";

const open: C8Server[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const USERS = [
  { sub: "admin-1", roles: ["ACT-19" as const] },
  { sub: "op-1", roles: ["ACT-01" as const] },
];

async function start(patch: LimitsPatch = {}): Promise<C8Server> {
  const s = await startC8Server({
    mode: "oidc",
    users: USERS,
    patch: { ...NO_RATE_PRESSURE, ...patch, http: { ...(NO_RATE_PRESSURE.http as object), ...((patch.http as object) ?? {}) } as never },
  });
  open.push(s);
  return s;
}

describe("R3-01: linear assess() and buildLineage() on large evidence records", () => {
  it("9,000 evidence items (with and without digests) assess and release in well under 2 seconds", async () => {
    const pack = await loadPack();
    for (const missingDigest of [true, false]) {
      const [record] = await recordsFor(pack, {
        erp: CLEAN.erp,
        lab: CLEAN.lab,
        editLab: (doc) => {
          const base = doc.recycled_content.evidence[0];
          for (let i = 0; i < 9000; i++) {
            doc.recycled_content.evidence.push({
              ...base,
              evidence_id: `EV-R3-${i}`,
              digest: missingDigest ? null : "a".repeat(64),
            });
          }
        },
      });
      expect(record).toBeDefined();
      const t0 = performance.now();
      const readiness = assess(pack, record!);
      const assessMs = performance.now() - t0;
      const t1 = performance.now();
      const rel = await generateRelease(
        pack,
        { model: record!.model, batch: record!.batch, version: 1, actor: "ACT-01", reason: "r3", sources: [], record: record!, digest: "0".repeat(64) } as never,
        {},
      );
      const releaseMs = performance.now() - t1;
      process.stderr.write(`[R3-01] 9000 evidence (missingDigest=${missingDigest}): assess=${assessMs.toFixed(0)} ms, release=${releaseMs.toFixed(0)} ms\n`);
      expect(readiness.length).toBe(3);
      expect(rel.outcomes.length).toBe(3);
      expect(assessMs).toBeLessThan(1000);
      expect(releaseMs).toBeLessThan(2000);
    }
  }, 30_000);

  it("wrap() terminates cleanly even when called with width <= 0", async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    expect(wrap("hello world\nsecond line", font, 10, 0)).toEqual(["hello world", "second line"]);
    expect(wrap("hello world", font, 10, -5)).toEqual(["hello world"]);
  });
});

describe("R3-02 & R3-03: identifier allow-list and length cap on corrections and lab identifiers", () => {
  it("importLabJson refuses unsafe or padded lab batch_id while accepting clean stand-in batch_id (R3-03)", async () => {
    const pack = await loadPack();
    const base = JSON.parse(new TextDecoder().decode(fixtureBytes("n", CLEAN.lab)));
    for (const [bad, code] of [
      ["ST-LOT-2026-001\u061c\u0412", "unsafe-identifier"],
      ["ST-LOT-2026-001\u202e", "unsafe-identifier"],
      [" ST-LOT-2026-001", "padded-identifier"],
      ["ST-LOT-2026-001 ", "padded-identifier"],
    ] as const) {
      const mutated = { ...base, batch_id: bad };
      const res = await importLabJson(pack, { name: CLEAN.lab, type: "application/json", bytes: new TextEncoder().encode(JSON.stringify(mutated)) });
      expect(res.ok, bad).toBe(false);
      if (!res.ok) expect(res.errors.map((i) => i.code)).toContain(code);
    }
    const cleanRes = await importLabJson(pack, { name: CLEAN.lab, type: "application/json", bytes: new TextEncoder().encode(JSON.stringify(base)) });
    expect(cleanRes.ok).toBe(true);
  });

  it("POST /api/records/:model/:batch/correct refuses > MAX_TEXT_FIELD_CHARS and unsafe identifier values (R3-02)", async () => {
    const s = await start();
    const imp = await post(s, "/api/jobs/import", importBody({ key: "r3-corr" }), s.token("op-1"));
    expect(imp.status).toBe(200);
    const snap = ((await imp.json()) as { snapshot: { model: string; batch: string } }).snapshot;
    const baseUrl = `/api/records/${encodeURIComponent(snap.model)}/${encodeURIComponent(snap.batch)}/correct`;

    // Find customer_material_code (identifier) and product_designation (free text) from pack
    const idCol = s.pack.inputs.erp.columns.find((c) => c.name === "customer_material_code")!;
    const [idProp, idMember] = idCol.maps_to.split("/");
    const nameCol = s.pack.inputs.erp.columns.find((c) => c.name === "product_designation")!;
    const [nameProp, nameMember] = nameCol.maps_to.split("/");

    // 1. Confusable/bidi/overlong identifier is refused
    const badId = await post(
      s,
      baseUrl,
      JSON.stringify({ property: idProp, member: idMember, raw: "\u0412\u061c\u202e" + "X".repeat(200), reason: "bad id" }),
      s.token("op-1"),
    );
    expect(badId.status).toBe(400);

    // 2. Overlong free text (> MAX_TEXT_FIELD_CHARS) is refused
    const badText = await post(
      s,
      baseUrl,
      JSON.stringify({ property: nameProp, member: nameMember, raw: "W".repeat(MAX_TEXT_FIELD_CHARS + 1), reason: "too long" }),
      s.token("op-1"),
    );
    expect(badText.status).toBe(400);

    // 3. Alloy identifier with Cyrillic confusable is refused
    const alloyProp = byRole(s.pack, "alloy");
    const badAlloy = await post(
      s,
      baseUrl,
      JSON.stringify({ property: alloyProp, member: "FLD-DesignationRef-designation", raw: "5754\u0412", reason: "confusable alloy" }),
      s.token("op-1"),
    );
    expect(badAlloy.status).toBe(400);

    // 4. Valid German umlaut free text and valid ASCII identifier are still accepted
    const okDe = await post(
      s,
      baseUrl,
      JSON.stringify({ property: nameProp, member: nameMember, raw: "Aluminiumblech geprüfte Qualität, 2.0 mm", reason: "valid German text" }),
      s.token("op-1"),
    );
    expect(okDe.status).toBe(200);
    const okId = await post(
      s,
      baseUrl,
      JSON.stringify({ property: idProp, member: idMember, raw: "CUST-ART-9901", reason: "valid ASCII id" }),
      s.token("op-1"),
    );
    expect(okId.status).toBe(200);
  }, 30_000);
});

describe("V1-10, V1-11 & V2-12: dead-stream disconnect, strict OVERTAKE_LIMIT, and control-route caps", () => {
  it("JobCoordinatorModel.start() never overtakes a waiting job more than OVERTAKE_LIMIT in a single pass (V1-11)", () => {
    const coord = new JobCoordinatorModel({
      maxActivePerDomain: 4,
      maxQueuedPerDomain: 20,
      maxActiveTotal: 4,
      retryAfterSeconds: 2,
      maxInflightBytes: 1000,
    });
    // Hold 300 bytes with a0 and 700 bytes with x so b1 (800 bytes) cannot fit even after x finishes
    expect(coord.admit("a0", "dom-a", 300).kind).toBe("started");
    expect(coord.admit("b1", "dom-b", 800).kind).toBe("queued");

    // Let OVERTAKE_LIMIT - 2 (6) small jobs overtake b1 one by one
    for (let i = 0; i < OVERTAKE_LIMIT - 2; i++) {
      expect(coord.admit(`o-${i}`, `dom-o${i}`, 100).kind).toBe("started");
      coord.finish(`o-${i}`);
    }
    // 7th overtake: x takes the remaining 700 bytes (activeBytes=1000, activeTotal=2)
    expect(coord.admit("x", "dom-x", 700).kind).toBe("started");
    // Queue 3 small jobs behind b1 (all need 100 bytes; none fit while activeBytes=1000)
    expect(coord.admit("c1", "dom-c1", 100).kind).toBe("queued");
    expect(coord.admit("c2", "dom-c2", 100).kind).toBe("queued");
    expect(coord.admit("c3", "dom-c3", 100).kind).toBe("queued");

    // finish("x") frees 700 bytes and 3 slots are open; b1 (800 B) still doesn't fit (300+800>1000).
    // Only c1 (8th overtake = OVERTAKE_LIMIT) may start in this pass; c2 and c3 must remain queued.
    const r = coord.finish("x");
    expect(r.kind === "finished" ? r.started : []).toEqual(["c1"]);
    expect(coord.stateOf("c2")).toBe("queued");
    expect(coord.stateOf("c3")).toBe("queued");
  });

  it("immediate socket destroy after complete body on cold active config release leaves no stuck slots (V1-10)", async () => {
    const s = await start({ http: { body_read_timeout_ms: 4000 } as never });
    // Bootstrap active config release so loadRuntime() performs async pack validation on cold cache
    const releases = new ConfigReleaseStore(s.db, "default");
    await releases.bootstrapActivePack(readPack(join(process.cwd(), "contracts/n")), s.pack.id, s.pack.version);

    const payload = importBody({ key: "v1-10-abort" });
    const reqText =
      `POST /api/jobs/import HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nAuthorization: Bearer ${s.token("op-1")}\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;

    // Send 8 complete requests and destroy each socket immediately
    await Promise.all(
      Array.from({ length: 8 }, () =>
        new Promise<void>((resolve) => {
          const sock = connect(s.port, "127.0.0.1", () => {
            sock.write(reqText, () => {
              sock.destroy();
              resolve();
            });
          });
          sock.on("error", () => resolve());
        }),
      ),
    );

    // Slots must clear promptly (far faster than body_read_timeout_ms=4000) and a follow-up import succeeds right away
    await until(async () => {
      const m = (await (await get(s, "/api/admin/metrics", s.token("admin-1"))).json()) as { jobs: { activeTotal: number; queuedTotal: number } };
      return m.jobs.activeTotal === 0 && m.jobs.queuedTotal === 0;
    }, 1500);

    const t0 = performance.now();
    const ok = await post(s, "/api/jobs/import", importBody({ key: "v1-10-after" }), s.token("op-1"));
    expect(ok.status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(2000);
  }, 30_000);

  it("control routes enforce 256 KiB cap and body_read_timeout_ms (V2-12)", async () => {
    const s = await start({ http: { body_read_timeout_ms: 300 } as never });
    const big = await post(s, "/api/jobs/JOB-none/cancel", JSON.stringify({ reason: "x".repeat(300 * 1024) }), s.token("op-1"));
    expect(big.status).toBe(413);

    // Slow drip on a control route hits 408 body-timeout
    const response = await new Promise<string>((resolve) => {
      const sock = connect(s.port, "127.0.0.1");
      let data = "";
      sock.on("data", (d) => (data += d.toString("latin1")));
      sock.on("close", () => resolve(data));
      sock.on("error", () => resolve(data));
      sock.write(
        `POST /api/jobs/JOB-none/cancel HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nAuthorization: Bearer ${s.token("op-1")}\r\n` +
          `Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{"reason":`,
      );
    });
    expect(response).toMatch(/^HTTP\/1\.1 408 /);
  }, 20_000);
});
