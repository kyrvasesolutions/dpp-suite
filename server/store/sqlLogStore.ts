/**
 * Relational append-only execution log implementing `LogStore` (`src/model/log.ts`).
 *
 * Scopes event identity by `security_domain` (EV-5) while strictly passing every entry through
 * `sanitise()` so only the fixed 12 public fields are ever persisted (C5-03 / LEAN-DEF-12).
 */
import { randomUUID } from "node:crypto";
import { sanitise, type LogEntry, type LogInput, type LogStore } from "../../src/model/log";
import { DEFAULT_SECURITY_DOMAIN } from "../../src/model/pContracts";
import type { DbAdapter } from "../db/adapter";

interface LogRow {
  seq: number;
  security_domain: string;
  event_id: string;
  recorded_at: string;
  event: LogEntry["event"];
  stage: LogEntry["stage"] | null;
  code: string | null;
  route: LogEntry["route"] | null;
  rule_id: string | null;
  step_id: string | null;
  record_model_sha: string | null;
  record_batch_sha: string | null;
  version: number | null;
  file_role: LogEntry["fileRole"] | null;
  file_sha256: string | null;
  outcome: LogEntry["outcome"];
}

export class SqlLogStore implements LogStore {
  constructor(
    private readonly db: DbAdapter,
    public readonly securityDomain: string = DEFAULT_SECURITY_DOMAIN,
  ) {}

  /** Synchronous append (usable inside `db.transaction(...)` blocks). Always sanitises input first. */
  addSync(input: LogInput | Omit<LogEntry, "seq">, recordedAt: string = new Date().toISOString()): number {
    const clean = sanitise(input as LogInput);
    const eventId = `${this.securityDomain}:${randomUUID()}`;
    const res = this.db.run(
      `INSERT INTO execution_log (
        security_domain, event_id, recorded_at, event, stage, code, route, rule_id, step_id,
        record_model_sha, record_batch_sha, version, file_role, file_sha256, outcome
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.securityDomain,
      eventId,
      recordedAt,
      clean.event,
      clean.stage ?? null,
      clean.code ?? null,
      clean.route ?? null,
      clean.ruleId ?? null,
      clean.stepId ?? null,
      clean.record?.model ?? null,
      clean.record?.batch ?? null,
      clean.version ?? null,
      clean.fileRole ?? null,
      clean.fileSha256 ?? null,
      clean.outcome,
    );
    return Number(res.lastInsertRowid);
  }

  async add(entry: Omit<LogEntry, "seq">): Promise<number> {
    return this.addSync(entry);
  }

  allSync(): LogEntry[] {
    const rows = this.db.query<LogRow>(
      "SELECT * FROM execution_log WHERE security_domain = ? ORDER BY seq ASC",
      this.securityDomain,
    );
    return rows.map((r) => {
      const entry: LogEntry = {
        seq: Number(r.seq),
        event: r.event,
        ...(r.stage ? { stage: r.stage } : {}),
        ...(r.code ? { code: r.code } : {}),
        ...(r.route ? { route: r.route } : {}),
        ...(r.rule_id ? { ruleId: r.rule_id } : {}),
        ...(r.step_id ? { stepId: r.step_id } : {}),
        ...(r.record_model_sha && r.record_batch_sha
          ? { record: { model: r.record_model_sha, batch: r.record_batch_sha } }
          : {}),
        ...(r.version !== null ? { version: Number(r.version) } : {}),
        ...(r.file_role ? { fileRole: r.file_role } : {}),
        ...(r.file_sha256 ? { fileSha256: r.file_sha256 } : {}),
        outcome: r.outcome,
      };
      return entry;
    });
  }

  async all(): Promise<LogEntry[]> {
    return this.allSync();
  }
}
