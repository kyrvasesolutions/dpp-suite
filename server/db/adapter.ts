/**
 * Relational database adapter boundary and SQLite (WAL) implementation via Node 24 built-in `node:sqlite`.
 *
 * Isolates all SQLite specifics behind `DbAdapter` so a PostgreSQL adapter can later replace SQLite
 * without changing repositories, migrations, job orchestration, or retention logic (ADR-0004).
 * Zero external production npm dependencies.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type SqlParam = SQLInputValue;
export type SqlRow = Record<string, unknown>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface DbAdapter {
  /** Executes raw DDL/SQL statements (used by migrations). */
  exec(sql: string): void;
  /** Returns all matching rows. */
  query<T = SqlRow>(sql: string, ...params: SqlParam[]): T[];
  /** Returns the first matching row, or undefined. */
  get<T = SqlRow>(sql: string, ...params: SqlParam[]): T | undefined;
  /** Runs an INSERT/UPDATE/DELETE statement. */
  run(sql: string, ...params: SqlParam[]): RunResult;
  /**
   * Runs `fn` atomically inside a serializable write transaction (`BEGIN IMMEDIATE` in SQLite),
   * or a nested `SAVEPOINT` if already inside a transaction. `fn` must be synchronous so the
   * database lock is never held across awaited event-loop turns.
   */
  transaction<T>(fn: () => T): T;
  /** Creates a consistent hot point-in-time snapshot of the database at `destPath`. */
  backup(destPath: string): void;
  /** True when currently inside an active transaction. */
  readonly inTransaction: boolean;
  /** Closes the underlying database handle. */
  close(): void;
}

export interface SqliteOptions {
  /** File path or `":memory:"`. Parent directories are created automatically for file paths. */
  path: string;
  /** Milliseconds to wait on write-lock contention across connections (default 5000). */
  busyTimeoutMs?: number;
}

/**
 * Synchronous SQLite WAL adapter backed by Node 24 built-in `node:sqlite`.
 * Enables WAL mode, foreign keys, and `BEGIN IMMEDIATE` write transactions for deterministic concurrency.
 */
export class SqliteAdapter implements DbAdapter {
  private readonly db: DatabaseSync;
  private txDepth = 0;
  private savepointSeq = 0;
  private closed = false;

  constructor(options: SqliteOptions) {
    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true });
    }
    this.db = new DatabaseSync(options.path);
    const timeout = Math.max(100, Math.trunc(options.busyTimeoutMs ?? 5000));
    this.db.exec(`PRAGMA busy_timeout = ${timeout};`);
    this.db.exec("PRAGMA foreign_keys = ON;");
    if (options.path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
    }
  }

  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  query<T = SqlRow>(sql: string, ...params: SqlParam[]): T[] {
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as SqlRow[];
    // Convert null-prototype rows from node:sqlite into plain objects for predictable JSON/Vitest handling.
    return rows.map((r) => ({ ...r })) as T[];
  }

  get<T = SqlRow>(sql: string, ...params: SqlParam[]): T | undefined {
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as SqlRow | undefined;
    return row ? ({ ...row } as T) : undefined;
  }

  run(sql: string, ...params: SqlParam[]): RunResult {
    const stmt = this.db.prepare(sql);
    const res = stmt.run(...params);
    return {
      changes: Number(res.changes),
      lastInsertRowid: res.lastInsertRowid,
    };
  }

  transaction<T>(fn: () => T): T {
    if (this.txDepth === 0) {
      this.beginImmediateWithRetry();
      this.txDepth = 1;
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // ignore secondary rollback failure if SQLite already rolled back
        }
        throw err;
      } finally {
        this.txDepth = 0;
      }
    }

    const sp = `sp_${++this.savepointSeq}`;
    this.db.exec(`SAVEPOINT ${sp}`);
    this.txDepth += 1;
    try {
      const result = fn();
      this.db.exec(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
      } catch {
        // ignore secondary rollback error
      }
      throw err;
    } finally {
      this.txDepth -= 1;
    }
  }

  backup(destPath: string): void {
    mkdirSync(dirname(destPath), { recursive: true });
    // SQLite VACUUM INTO writes a clean atomic copy even while WAL connections are active.
    const stmt = this.db.prepare("VACUUM INTO ?");
    stmt.run(destPath);
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  private beginImmediateWithRetry(): void {
    const maxAttempts = 25;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/locked|busy/i.test(msg) || attempt === maxAttempts - 1) throw err;
        // Brief synchronous backoff using Atomics.wait on a throwaway buffer to let the peer finish.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + attempt * 5);
      }
    }
  }
}
