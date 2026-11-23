/**
 * The ingress of one import job as a pure task (D8-10): bytes, encoding, CSV, JSON and mapping stages, then the record build.
 * It runs inside a `worker_threads` worker on the server, so a hostile input can burn CPU or memory only in a thread that the
 * main thread can terminate (TIMEOUT, CANCELLED) or that V8 stops at its heap limit. The browser keeps calling the same
 * pure functions in-process.
 */
import { buildRecords, importErpCsv, importLabJson, type ImportResult, type IngressLimits, type RecordState } from "../../src/model/ingress";
import type { ProfilePack } from "../../src/model/profile";
import { canonicalSha256Sync } from "../store/streamDigest";

export interface IngressTask {
  pack: ProfilePack;
  actor: string;
  erp: { bytes: Uint8Array; name: string; type: string };
  lab?: { bytes: Uint8Array; name: string; type: string };
  limits: IngressLimits;
  /** Test-only seam: a synchronous busy loop before ingress, to prove that a thread that never yields is still terminated. */
  spinMs?: number;
}

export interface IngressTaskResult {
  erpRes: ImportResult;
  labRes?: ImportResult;
  /** Present only when every file was accepted. */
  built?: RecordState;
}

export async function runIngressTask(task: IngressTask): Promise<IngressTaskResult> {
  if (task.spinMs) {
    const until = performance.now() + task.spinMs;
    while (performance.now() < until) {
      /* synchronous on purpose */
    }
  }
  const startedAt = performance.now();
  // The main thread owns the job deadline and the cancel; the worker has no deadline of its own.
  const limits: IngressLimits = { ...task.limits, deadlineMs: Number.MAX_SAFE_INTEGER };
  const erpRes = await importErpCsv(task.pack, { bytes: task.erp.bytes, name: task.erp.name, type: task.erp.type, startedAt, limits }, task.actor);
  const labRes = task.lab
    ? await importLabJson(task.pack, { bytes: task.lab.bytes, name: task.lab.name, type: task.lab.type, startedAt, limits }, task.actor)
    : undefined;
  if (!erpRes.ok || (labRes && !labRes.ok)) return { erpRes, labRes };
  const built = await buildRecords(labRes ? [erpRes, labRes] : [erpRes], canonicalSha256Sync); // streamed digest: no canonical text of a large record
  // The main thread needs the files and the verdicts (for the log) and the built record, not a second copy of every assertion.
  const slim = (r: ImportResult): ImportResult => (r.ok ? { ok: true, file: r.file, assertions: [], records: r.records } : r);
  return { erpRes: slim(erpRes), labRes: labRes ? slim(labRes) : undefined, built };
}
