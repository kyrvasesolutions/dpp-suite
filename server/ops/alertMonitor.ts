/**
 * Structured fault-class monitoring and zero-leak alert evaluator (`FUNC-132`).
 *
 * Evaluates seven explicit fault classes purely from counters, timestamps, and process gauges.
 * Emits ONLY fixed schema fields (`AlertRecordSchema`) so no input value, model/batch identifier,
 * property value, filename, or user subject can ever appear in an alert.
 * Persists to `operational_alerts` strictly on state transitions (`firing` <-> `resolved`) so
 * repeated read-only polls never trigger unbounded SQLite writes.
 */
import {
  AlertRecordSchema,
  DEFAULT_ALERT_THRESHOLDS,
  type AlertFaultClass,
  type AlertRecord,
  type AlertSeverity,
  type AlertThresholds,
} from "../../src/model/c10Contracts";
import type { DbAdapter } from "../db/adapter";

export interface FaultSignals {
  errors5xx: number;
  rateLimitedCount: number;
  jobTimeouts: number;
  egressBlockedCount: number;
  lastBackupAtIso: string | null;
  integrityFailureCount: number;
  rssBytes: number;
}

interface RuleSpec {
  faultClass: AlertFaultClass;
  severity: AlertSeverity;
  runbookRef: string;
  evaluate: (signals: FaultSignals, thresholds: AlertThresholds, nowMs: number) => { fired: boolean; count: number; threshold: number };
}

const RULES: readonly RuleSpec[] = [
  {
    faultClass: "server_error_burst",
    severity: "critical",
    runbookRef: "operations-runbook#incident-server-errors",
    evaluate: (s, t) => ({ fired: s.errors5xx >= t.serverError5xxCount, count: s.errors5xx, threshold: t.serverError5xxCount }),
  },
  {
    faultClass: "rate_limit_saturation",
    severity: "warning",
    runbookRef: "operations-runbook#incident-rate-limit",
    evaluate: (s, t) => ({ fired: s.rateLimitedCount >= t.rateLimitCount, count: s.rateLimitedCount, threshold: t.rateLimitCount }),
  },
  {
    faultClass: "job_timeout_or_stall",
    severity: "warning",
    runbookRef: "operations-runbook#incident-job-timeout",
    evaluate: (s, t) => ({ fired: s.jobTimeouts >= t.jobTimeoutCount, count: s.jobTimeouts, threshold: t.jobTimeoutCount }),
  },
  {
    faultClass: "egress_blocked_attempt",
    severity: "critical",
    runbookRef: "operations-runbook#incident-egress-blocked",
    evaluate: (s, t) => ({ fired: s.egressBlockedCount >= t.egressBlockedCount, count: s.egressBlockedCount, threshold: t.egressBlockedCount }),
  },
  {
    faultClass: "backup_overdue",
    severity: "critical",
    runbookRef: "operations-runbook#backup-and-restore",
    evaluate: (s, t, nowMs) => {
      if (!s.lastBackupAtIso) {
        return { fired: true, count: t.backupMaxAgeSeconds + 1, threshold: t.backupMaxAgeSeconds };
      }
      const parsed = Date.parse(s.lastBackupAtIso);
      const ageSeconds = Number.isFinite(parsed) ? Math.max(0, Math.round((nowMs - parsed) / 1000)) : t.backupMaxAgeSeconds + 1;
      return { fired: ageSeconds > t.backupMaxAgeSeconds, count: ageSeconds, threshold: t.backupMaxAgeSeconds };
    },
  },
  {
    faultClass: "integrity_or_pack_failure",
    severity: "critical",
    runbookRef: "operations-runbook#incident-integrity",
    evaluate: (s, t) => ({
      fired: s.integrityFailureCount >= t.integrityFailureCount,
      count: s.integrityFailureCount,
      threshold: t.integrityFailureCount,
    }),
  },
  {
    faultClass: "memory_budget_pressure",
    severity: "warning",
    runbookRef: "operations-runbook#incident-memory",
    evaluate: (s, t) => {
      const rssMiB = Math.round(s.rssBytes / (1024 * 1024));
      return { fired: rssMiB >= t.memoryRssMiB, count: rssMiB, threshold: t.memoryRssMiB };
    },
  },
];

export interface AlertMonitorOptions {
  serviceOwner?: string;
  thresholds?: Partial<AlertThresholds>;
  db?: DbAdapter;
  now?: () => string;
  /** Optional getter returning total blocked runtime egress attempts from `installEgressGuard().attempts.length`. */
  egressAttempts?: () => number;
}

/**
 * Stateful evaluator for the seven operational fault classes. Refreshes latest backup timestamps
 * from `backup_records` on every evaluation (so CLI backups clear `backup_overdue`) and persists
 * strictly schema-checked, value-free records ONLY on `firing` <-> `resolved` state transitions.
 */
export class AlertMonitor {
  readonly serviceOwner: string;
  readonly thresholds: AlertThresholds;
  private readonly db?: DbAdapter;
  private readonly now: () => string;
  private readonly egressAttempts?: () => number;
  private readonly active = new Map<AlertFaultClass, AlertRecord>();
  private egressBlocked = 0;
  private integrityFailures = 0;
  private lastBackupAt: string | null = null;

  constructor(options: AlertMonitorOptions = {}) {
    const rawOwner = options.serviceOwner?.trim() || "platform-ops-owner";
    this.serviceOwner = /^[A-Za-z0-9._:@/-]{1,64}$/.test(rawOwner) ? rawOwner : "platform-ops-owner";
    this.thresholds = { ...DEFAULT_ALERT_THRESHOLDS, ...(options.thresholds ?? {}) };
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.egressAttempts = options.egressAttempts;
    this.refreshLatestBackupTimestamp();
  }

  recordEgressBlocked(): void {
    this.egressBlocked++;
  }

  recordIntegrityFailure(): void {
    this.integrityFailures++;
  }

  recordBackupCompleted(timestampIso?: string): void {
    const candidate = timestampIso ?? this.now();
    if (!this.lastBackupAt || Date.parse(candidate) >= Date.parse(this.lastBackupAt)) {
      this.lastBackupAt = candidate;
    }
  }

  private refreshLatestBackupTimestamp(): void {
    if (!this.db) return;
    try {
      const hasTable = this.db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backup_records'",
      );
      if (!hasTable) return;
      const row = this.db.get<{ created_at: string }>("SELECT created_at FROM backup_records ORDER BY created_at DESC LIMIT 1");
      if (row?.created_at) {
        const dbTs = String(row.created_at);
        if (!this.lastBackupAt || Date.parse(dbTs) > Date.parse(this.lastBackupAt)) {
          this.lastBackupAt = dbTs;
        }
      }
    } catch {
      // ignore if table not yet migrated
    }
  }

  private persist(alert: AlertRecord): void {
    if (!this.db) return;
    try {
      const hasTable = this.db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operational_alerts'",
      );
      if (!hasTable) return;
      this.db.run(
        `INSERT INTO operational_alerts (
          alert_id, fault_class, severity, state, raised_at, resolved_at, count, threshold, service_owner, runbook_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        alert.alertId,
        alert.faultClass,
        alert.severity,
        alert.state,
        alert.raisedAt,
        alert.resolvedAt,
        alert.count,
        alert.threshold,
        alert.serviceOwner,
        alert.runbookRef,
      );
    } catch {
      // never crash request path on optional alert persistence
    }
  }

  /**
   * Evaluates all 7 fault classes against current metrics and counters, returning strictly validated
   * value-free `AlertRecord[]` (firing alerts). Persists only on state transitions (`firing` <-> `resolved`).
   */
  evaluate(partial: Partial<FaultSignals> = {}): {
    serviceOwner: string;
    evaluatedAt: string;
    firingCount: number;
    alerts: AlertRecord[];
  } {
    const evaluatedAt = this.now();
    const nowMs = Date.parse(evaluatedAt);
    // Always refresh latest backup timestamp so out-of-process CLI backups are visible immediately.
    this.refreshLatestBackupTimestamp();

    const signals: FaultSignals = {
      errors5xx: partial.errors5xx ?? 0,
      rateLimitedCount: partial.rateLimitedCount ?? 0,
      jobTimeouts: partial.jobTimeouts ?? 0,
      egressBlockedCount: (partial.egressBlockedCount ?? 0) + this.egressBlocked + (this.egressAttempts ? this.egressAttempts() : 0),
      lastBackupAtIso: partial.lastBackupAtIso !== undefined ? partial.lastBackupAtIso : this.lastBackupAt,
      integrityFailureCount: (partial.integrityFailureCount ?? 0) + this.integrityFailures,
      rssBytes: partial.rssBytes ?? process.memoryUsage().rss,
    };

    const alerts: AlertRecord[] = [];
    for (const rule of RULES) {
      const res = rule.evaluate(signals, this.thresholds, Number.isFinite(nowMs) ? nowMs : Date.now());
      const prev = this.active.get(rule.faultClass);

      if (res.fired) {
        const record = AlertRecordSchema.parse({
          alertId: `alert:${rule.faultClass}`,
          faultClass: rule.faultClass,
          severity: rule.severity,
          state: "firing",
          raisedAt: prev && prev.state === "firing" ? prev.raisedAt : evaluatedAt,
          resolvedAt: null,
          count: res.count,
          threshold: res.threshold,
          serviceOwner: this.serviceOwner,
          runbookRef: rule.runbookRef,
        });
        // Persist strictly on state transition (new or resolved -> firing), never on repeated poll count ticks.
        if (!prev || prev.state !== "firing") {
          this.persist(record);
        }
        this.active.set(rule.faultClass, record);
        alerts.push(record);
      } else if (prev && prev.state === "firing") {
        const resolved = AlertRecordSchema.parse({
          ...prev,
          state: "resolved",
          resolvedAt: evaluatedAt,
          count: res.count,
        });
        this.persist(resolved);
        this.active.set(rule.faultClass, resolved);
      }
    }

    return {
      serviceOwner: this.serviceOwner,
      evaluatedAt,
      firingCount: alerts.length,
      alerts,
    };
  }
}
