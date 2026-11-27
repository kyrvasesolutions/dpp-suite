// @vitest-environment node
/** Cycle 4: the release manifest (C4-05) and its verification. */
import { beforeAll, describe, expect, it } from "vitest";
import { canonical, canonicalPretty, sha256Bytes, utf8 } from "../../src/model/canonical";
import { generateRelease } from "../../src/model/outputs/release";
import { verifyRelease } from "../../src/model/outputs/manifest";
import type { ProfilePack } from "../../src/model/profile";
import { MemoryRepository, storeRecord } from "../../src/model/recordRepository";
import { CLEAN, loadPack, recordFor } from "../support/records";

const SOFTWARE = { name: "dpp-traceability", version: "0.0.0-test", commit: "test" };
let pack: ProfilePack;
beforeAll(async () => {
  pack = await loadPack();
});

const release = async (c = CLEAN, now?: () => Date) => {
  const repo = new MemoryRepository();
  const { snapshot } = await storeRecord(repo, await recordFor(pack, c));
  return { snapshot, release: await generateRelease(pack, snapshot, { software: SOFTWARE, ...(now ? { now } : {}) }) };
};

describe("release manifest", () => {
  it("lists the software, every pin of the pack, the inputs, the record version and every output with its digest", async () => {
    const { snapshot, release: r } = await release();
    const m = r.manifest;
    expect(m.software).toEqual(SOFTWARE);
    expect(m.pack.manifestDigest).toBe(pack.manifestDigest);
    const pinned = Object.values(m.pack.pins).flat().map((p) => p.path).sort();
    expect(pinned).toEqual(pack.pins.map((p) => p.path).sort());
    for (const p of Object.values(m.pack.pins).flat()) expect(pack.pins.find((x) => x.path === p.path)).toMatchObject({ ref: p.ref, digest: p.digest });
    expect(Object.keys(m.pack.pins)).toEqual(["profile", "terms", "legal", "units", "codeLists", "inputs", "routes", "policy", "contracts"]);
    expect(m.inputs.map((i) => i.role).sort()).toEqual(["erp", "lab"]);
    expect(m.inputs.map((i) => i.sha256).sort()).toEqual(snapshot.sources.map((s) => s.sha256).sort());
    expect(m.record).toEqual({ model: snapshot.model, batch: snapshot.batch, version: 1, digest: snapshot.record.digest, snapshotDigest: snapshot.digest });
    for (const f of r.files) {
      const o = m.outputs.find((x) => x.route === f.route)!;
      expect(o).toMatchObject({ fileName: f.fileName, mediaType: f.mediaType, sha256: await sha256Bytes(f.bytes), status: f.status });
    }
    expect(m.outputs.find((o) => o.route === "registry")!.status).toBe("HOLD");
    expect(m.outputs.find((o) => o.route === "internal")!.status).toBe("RELEASED");
    expect(m.lineage.length).toBeGreaterThan(10);
    expect(m.formulaPrefixedCells).toBe(0);
    // the only date and time in the manifest is the declared generated metadata
    expect(m.generated).toEqual({ at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/), by: "ACT-01" });
    expect(r.manifestFile.substantiveText).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    expect(r.manifestFile.text.match(/\d{4}-\d{2}-\d{2}T\d{2}:/g)).toHaveLength(1);
  });

  it("lists a route that is refused as a hold with its reasons and no digest", async () => {
    const { release: r } = await release({ erp: "erp-missing-thickness.csv", lab: CLEAN.lab });
    const internal = r.manifest.outputs.find((o) => o.route === "internal")!;
    expect(internal).toMatchObject({ fileName: null, sha256: null, status: "HOLD" });
    expect(internal.holds.map((h) => h.rule)).toContain("RR-MISSING");
    expect(r.files.map((f) => f.route)).toEqual(["registry"]);
  });

  it("is canonical, and its substantive content is the same on every run whatever the time", async () => {
    const a = (await release(CLEAN, () => new Date("2026-01-02T03:04:05.000Z"))).release;
    const b = (await release(CLEAN, () => new Date("2031-12-31T23:59:59.999Z"))).release;
    expect(a.manifestFile.sha256).toBe(await sha256Bytes(utf8(a.manifestFile.text)));
    expect(JSON.parse(a.manifestFile.text).software.commit).toBe("test");
    // only the generated metadata differs, and it is in no digest
    expect(a.manifestFile.text).not.toBe(b.manifestFile.text);
    expect(a.manifestFile.substantiveText).toBe(b.manifestFile.substantiveText);
    expect(a.manifestFile.substantiveDigest).toBe(b.manifestFile.substantiveDigest);
    expect(a.manifest.generated.at).toBe("2026-01-02T03:04:05.000Z");
    // the outputs stay byte-identical, and the manifest lists the same digests for them
    for (const f of a.files) expect(Buffer.from(f.bytes).equals(Buffer.from(b.files.find((x) => x.route === f.route)!.bytes)), f.fileName).toBe(true);
    expect(a.manifest.outputs).toEqual(b.manifest.outputs);
  });

  it("states a substantive digest over everything except the generated metadata", async () => {
    const { release: r } = await release();
    const { generated: _generated, substantiveDigest, ...rest } = r.manifest;
    expect(substantiveDigest).toBe(await sha256Bytes(utf8(canonical(rest))));
    expect(r.manifestFile.substantiveDigest).toBe(substantiveDigest);
    // no output file, and no other digest in the manifest, depends on the time
    expect(JSON.stringify(rest)).not.toContain(r.manifest.generated.at);
  });
});

describe("verifyRelease", () => {
  const supplied = (r: Awaited<ReturnType<typeof release>>["release"]) => r.files.map((f) => ({ name: f.fileName, bytes: f.bytes }));

  it("accepts the files it was made with, and checks the inputs and the pack when given", async () => {
    const { release: r } = await release();
    const result = await verifyRelease(r.manifestFile.bytes, supplied(r), pack);
    expect(result.ok).toBe(true);
    expect(result.checks.filter((c) => c.kind === "output").every((c) => c.status === "match")).toBe(true);
    expect(result.checks.filter((c) => c.kind === "input").every((c) => c.status === "not-supplied")).toBe(true);
    expect(result.checks.filter((c) => c.kind === "pack").every((c) => c.status === "match")).toBe(true);
  });

  it("catches a one-byte change in any output", async () => {
    const { release: r } = await release();
    for (const f of r.files) {
      const files = supplied(r).map((x) => (x.name === f.fileName ? { ...x, bytes: Uint8Array.from(x.bytes, (b, i) => (i === 3 ? b ^ 1 : b)) } : x));
      const result = await verifyRelease(r.manifestFile.bytes, files);
      expect(result.ok, f.fileName).toBe(false);
      expect(result.checks.filter((c) => c.status === "mismatch").map((c) => c.name)).toEqual([f.fileName]);
    }
  });

  it("reports a missing file, an unlisted file, a changed input and a changed manifest", async () => {
    const { release: r } = await release();
    const files = supplied(r);
    expect((await verifyRelease(r.manifestFile.bytes, files.slice(1))).checks.some((c) => c.status === "missing")).toBe(true);
    expect((await verifyRelease(r.manifestFile.bytes, [...files, { name: "extra.csv", bytes: utf8("x") }])).checks.some((c) => c.status === "unlisted")).toBe(true);
    const input = r.manifest.inputs[0];
    const bad = await verifyRelease(r.manifestFile.bytes, [...files, { name: input.name, bytes: utf8("not the file") }]);
    expect(bad.checks.find((c) => c.kind === "input" && c.name === input.name)!.status).toBe("mismatch");
    const tampered = utf8(r.manifestFile.text.replace(r.manifest.outputs[0].sha256 ?? "", "0".repeat(64)));
    expect((await verifyRelease(tampered, files)).ok).toBe(false);
    expect((await verifyRelease(utf8("{not json"), files)).ok).toBe(false);
    expect((await verifyRelease(utf8('{"a":1,"a":2}'), files)).ok).toBe(false);
  });

  it("accepts a manifest whose generated metadata was changed, and refuses one whose content was changed", async () => {
    const { release: r } = await release();
    const files = supplied(r);
    const later = utf8(r.manifestFile.text.replace(r.manifest.generated.at, "2040-01-01T00:00:00.000Z"));
    expect((await verifyRelease(later, files, pack)).ok).toBe(true);
    // a changed record version, with the substantive digest left as it was
    const doc = JSON.parse(r.manifestFile.text);
    doc.record.version += 1;
    const edited = utf8(canonicalPretty(doc));
    expect(edited).not.toEqual(r.manifestFile.bytes);
    const result = await verifyRelease(edited, files, pack);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "substantive content")!.status).toBe("mismatch");
    // a manifest without the generated metadata is not a valid manifest
    const { generated: _generated, ...without } = JSON.parse(r.manifestFile.text);
    expect((await verifyRelease(utf8(JSON.stringify(without)), files)).ok).toBe(false);
  });

  it("refuses a pack that is not the one the release used", async () => {
    const { release: r } = await release();
    const other = { ...pack, manifestDigest: "f".repeat(64) };
    expect((await verifyRelease(r.manifestFile.bytes, supplied(r), other)).ok).toBe(false);
  });
});
