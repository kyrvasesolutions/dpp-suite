/**
 * Main-thread side of the worker-isolated ingress (D8-10, C8-01, C8-02).
 *
 * One worker per job, with V8 `resourceLimits` derived from `execution_memory_max_bytes`. The main thread polls the job budget
 * while the worker runs and terminates the worker on CANCELLED or TIMEOUT, so a synchronous parse that never yields is stopped
 * within `forced_termination_max_ms`. A worker that dies (out of memory, crash) ends the job with a fixed code and commits nothing.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { JobBudget, OperationalLimits } from "../../src/model/c8Contracts";
import type { IngressTask, IngressTaskResult } from "./ingressTask";

const MIB = 1024 * 1024;

/** The worker died instead of answering: out of memory (OVER_LIMIT execution_memory_max_bytes) or any other crash. */
export class IngressExecutionError extends Error {
  override name = "IngressExecutionError";
  constructor(readonly kind: "oom" | "crash") {
    super(kind === "oom" ? "The ingress worker ran out of memory." : "The ingress worker stopped without an answer.");
  }
}

let devBuild: Promise<string> | null = null;

/** In the bundle the worker sits next to `server.mjs`. In source mode (tests, dev) it is built once into a cache directory. */
async function resolveWorkerEntry(): Promise<string> {
  const sibling = join(dirname(fileURLToPath(import.meta.url)), "ingressWorker.mjs");
  if (existsSync(sibling)) return sibling;
  devBuild ??= buildDevWorker();
  return devBuild;
}

function newestMtime(dir: string): number {
  let m = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    m = Math.max(m, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return m;
}

async function buildDevWorker(): Promise<string> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const key = Math.floor(Math.max(newestMtime(join(root, "server")), newestMtime(join(root, "src/model")), newestMtime(join(root, "config"))));
  const cache = join(root, "node_modules/.cache/dpp-ingress-worker");
  const out = join(cache, String(key));
  const entry = join(out, "ingressWorker.mjs");
  if (existsSync(entry)) return entry;
  mkdirSync(cache, { recursive: true });
  const tmp = mkdtempSync(join(cache, "build-"));
  const viteName = "vite"; // not analysable, so the server bundle never pulls vite in
  const { build } = (await import(/* @vite-ignore */ viteName)) as typeof import("vite");
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    build: {
      ssr: join(root, "server/jobs/ingressWorker.ts"),
      outDir: tmp,
      emptyOutDir: true,
      target: "node24",
      rollupOptions: { output: { entryFileNames: "ingressWorker.mjs", format: "es" } },
    },
  });
  try {
    renameSync(tmp, out); // atomic; a concurrent process that got there first wins
  } catch {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (!existsSync(entry)) throw new Error("the ingress worker could not be built");
  return entry;
}

/** An ArrayBuffer the worker may take over without touching a shared pool: the view's own, or a copy. */
function transferable(bytes: Uint8Array): { bytes: Uint8Array; buffer: ArrayBuffer } {
  const buf = bytes.buffer;
  if (buf instanceof ArrayBuffer && bytes.byteOffset === 0 && buf.byteLength === bytes.byteLength) return { bytes, buffer: buf };
  const copy = bytes.slice();
  return { bytes: copy, buffer: copy.buffer as ArrayBuffer };
}

export interface IngressRunnerOptions {
  limits: OperationalLimits;
  /** Override of the worker entry (tests). */
  entry?: string;
  /** How often the job budget is looked at while the worker runs. Default 10 ms, well inside `cancellation_poll_max_ms`. */
  pollMs?: number;
}

export class IngressRunner {
  readonly #limits: OperationalLimits;
  readonly #entry?: string;
  readonly #pollMs: number;
  /** Longest `worker.terminate()` seen, in ms (for the report and the tests). */
  maxTerminationMs = 0;
  terminations = 0;

  constructor(options: IngressRunnerOptions) {
    this.#limits = options.limits;
    this.#entry = options.entry;
    this.#pollMs = options.pollMs ?? Math.max(1, Math.min(10, Math.floor(options.limits.execution.cancellation_poll_max_ms / 4)));
  }

  /**
   * Heap limit of one worker: a quarter of the execution memory. The coordinator runs up to `max_active_jobs_total` jobs at
   * once, so the workers together stay inside the execution memory and the main thread keeps its headroom. A pair of source files
   * at the maximum size (about 20 MB) is ingested well inside it.
   */
  get workerHeapMb(): number {
    return Math.max(32, Math.floor(this.#limits.execution.execution_memory_max_bytes / 4 / MIB));
  }

  async run(task: IngressTask, budget: JobBudget): Promise<IngressTaskResult> {
    const entry = this.#entry ?? (await resolveWorkerEntry());
    const erp = transferable(task.erp.bytes);
    const lab = task.lab ? transferable(task.lab.bytes) : undefined;
    const message: IngressTask = { ...task, erp: { ...task.erp, bytes: erp.bytes }, ...(task.lab && lab ? { lab: { ...task.lab, bytes: lab.bytes } } : {}) };
    return new Promise<IngressTaskResult>((resolvePromise, rejectPromise) => {
      let settled = false;
      let killing = false;
      const worker = new Worker(entry, {
        resourceLimits: { maxOldGenerationSizeMb: this.workerHeapMb, maxYoungGenerationSizeMb: 32 },
        stdout: true,
        stderr: true,
      });
      worker.stdout.resume();
      worker.stderr.resume();
      const done = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        settle();
      };
      const kill = (reason: unknown) => {
        if (settled || killing) return;
        killing = true;
        clearInterval(timer);
        const t0 = performance.now();
        void worker.terminate().then(() => {
          const ms = performance.now() - t0;
          this.maxTerminationMs = Math.max(this.maxTerminationMs, ms);
          this.terminations++;
          done(() => rejectPromise(reason));
        });
      };
      // The deadline and the cancel token are looked at from the main thread, whatever the worker is doing.
      const timer = setInterval(() => {
        try {
          budget.check("ingress");
        } catch (e) {
          kill(e);
        }
      }, this.#pollMs);
      worker.once("message", (m: { ok: boolean; result?: IngressTaskResult }) => {
        if (m.ok && m.result) {
          done(() => resolvePromise(m.result!));
        } else {
          done(() => rejectPromise(new IngressExecutionError("crash")));
        }
        void worker.terminate();
      });
      worker.once("error", (e: Error & { code?: string }) => {
        if (killing) return;
        done(() => rejectPromise(new IngressExecutionError(e.code === "ERR_WORKER_OUT_OF_MEMORY" ? "oom" : "crash")));
      });
      worker.once("exit", () => {
        if (killing) return;
        done(() => rejectPromise(new IngressExecutionError("crash")));
      });
      worker.postMessage(message, [erp.buffer, ...(lab ? [lab.buffer] : [])]);
    });
  }
}
