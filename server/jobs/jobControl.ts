/**
 * Server job control for Cycle 8 (LEAN-DEF-08, LEAN-DEF-09, D8-02): the job coordinator (per-domain slots, a finite FIFO
 * queue, a global cap) wrapped around the pure `JobCoordinatorModel`, and the registry of jobs running now so a cancel
 * request can reach their budget.
 *
 * The server never retries a job on its own (`retry_count: 0`): a refused or stopped job is retried by the client with the
 * same idempotency key, and the Cycle 6 idempotent claim keeps that from duplicating assertions.
 */
import { randomUUID } from "node:crypto";
import {
  JobCoordinatorModel,
  LimitError,
  coordinatorConfigFrom,
  type CancellationToken,
  type JobBudget,
  type OperationalLimits,
} from "../../src/model/c8Contracts";

/** The queue of a security domain is full: HTTP 429 with `Retry-After`. */
export class QueueFullError extends LimitError {
  override name = "QueueFullError";
  constructor(readonly retryAfterSeconds: number) {
    super("OVER_LIMIT", "queue_full", "queue-full");
  }
}

export interface JobSlot {
  /** Resolves when the job may start (at once when a slot is free, later when it waits in the queue). Rejects with CANCELLED when abandoned while queued. */
  readonly ready: Promise<void>;
  readonly queued: boolean;
  /** Frees the slot, or leaves the queue. Safe to call on every terminal path, and more than once. */
  release(): void;
}

interface Waiter {
  resolve: () => void;
  reject: (e: unknown) => void;
}

export class JobCoordinator {
  #model: JobCoordinatorModel;
  readonly #waiters = new Map<string, Waiter>();
  readonly #domains = new Map<string, string>();
  readonly #config;

  constructor(limits: OperationalLimits) {
    this.#config = coordinatorConfigFrom(limits);
    this.#model = new JobCoordinatorModel(this.#config);
  }

  /** Admits a job of a security domain: starts it, queues it in arrival order, or refuses it with `QueueFullError`. */
  admit(domain: string): JobSlot {
    // The model keeps one small entry per job it ever saw. When nothing is active or queued it holds only finished jobs,
    // so a fresh model loses nothing and keeps counting cheap.
    if (this.#domains.size === 0) this.#model = new JobCoordinatorModel(this.#config);
    const ticket = randomUUID();
    const decision = this.#model.admit(ticket, domain);
    if (decision.kind === "rejected") throw new QueueFullError(decision.retryAfterSeconds);
    this.#domains.set(ticket, domain);
    let ready: Promise<void>;
    if (decision.kind === "started") {
      ready = Promise.resolve();
    } else {
      ready = new Promise<void>((resolve, reject) => this.#waiters.set(ticket, { resolve, reject }));
      ready.catch(() => undefined); // an abandoned wait is handled by the caller; never an unhandled rejection
    }
    return {
      ready,
      queued: decision.kind === "queued",
      release: () => this.#release(ticket),
    };
  }

  #start(ids: string[]): void {
    for (const id of ids) {
      const w = this.#waiters.get(id);
      this.#waiters.delete(id);
      w?.resolve();
    }
  }

  #release(ticket: string): void {
    const state = this.#model.stateOf(ticket);
    if (state === "active") {
      const done = this.#model.finish(ticket);
      this.#domains.delete(ticket);
      if (done.kind === "finished") this.#start(done.started);
    } else if (state === "queued") {
      const cancelled = this.#model.cancel(ticket);
      this.#domains.delete(ticket);
      const w = this.#waiters.get(ticket);
      this.#waiters.delete(ticket);
      w?.reject(new LimitError("CANCELLED", "cancellation", "cancelled", "queued"));
      if (cancelled.kind === "cancelled") this.#start(cancelled.started);
    } else {
      this.#domains.delete(ticket);
    }
  }

  /** Counters only: no job id, no subject. Domain names are not values. */
  snapshot(): { activeTotal: number; queuedTotal: number; byDomain: Record<string, { active: number; queued: number }> } {
    const byDomain: Record<string, { active: number; queued: number }> = {};
    for (const domain of new Set(this.#domains.values())) {
      byDomain[domain] = { active: this.#model.activeCount(domain), queued: this.#model.queuedCount(domain) };
    }
    return { activeTotal: this.#model.activeCount(), queuedTotal: this.#model.queuedCount(), byDomain };
  }
}

export interface LiveJob {
  budget: JobBudget;
  token: CancellationToken;
  securityDomain: string;
  submitterSub: string;
}

/** Jobs executing now in this process, so a cancel request can reach the budget of the job it names. */
export class LiveJobs {
  readonly #jobs = new Map<string, LiveJob>();
  register(jobId: string, job: LiveJob): void {
    this.#jobs.set(jobId, job);
  }
  unregister(jobId: string): void {
    this.#jobs.delete(jobId);
  }
  get(jobId: string, securityDomain: string): LiveJob | undefined {
    const job = this.#jobs.get(jobId);
    return job && job.securityDomain === securityDomain ? job : undefined;
  }
  get size(): number {
    return this.#jobs.size;
  }
}
