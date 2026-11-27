import { useEffect, useState } from "react";
import { exportLog, LOG_FIELDS, type LogEntry } from "../model/log";
import { useRecordStore } from "../model/recordStore";

const short = (digest: string | undefined) => (digest ? `${digest.slice(0, 8)}…` : "");

/**
 * The execution and error log (Cycle 5), kept in this browser. It shows only the fixed public fields: events, stages, error
 * codes, routes, rule IDs and digests, never a value, a file name or free text. It can be downloaded as one JSON file.
 */
export function LogPanel() {
  const { log, logVersion } = useRecordStore();
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useEffect(() => {
    let live = true;
    log.entries().then((e) => live && setEntries(e), () => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [log, logVersion]);

  return (
    <section className="profile-section" aria-label="Execution log">
      <h2>Execution log</h2>
      <p className="hint small">
        Kept in this browser and never sent anywhere. It records what happened (events, stages, error codes, routes, rule IDs, digests), not
        what the files contain. It is traceable bookkeeping, not a tamper-evident certification. Fields: {LOG_FIELDS.join(", ")}.
      </p>
      <button
        type="button"
        className="ghost"
        data-testid="download-log"
        disabled={!entries.length}
        onClick={async () => {
          const file = await exportLog(log);
          const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.mediaType }));
          const a = document.createElement("a");
          a.href = url;
          a.download = file.fileName;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 0);
        }}
      >
        Download log
      </button>
      <details data-testid="execution-log">
        <summary>
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </summary>
        <table className="profile-table import-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Event</th>
              <th scope="col">Stage</th>
              <th scope="col">Code</th>
              <th scope="col">Route</th>
              <th scope="col">Rule</th>
              <th scope="col">Record</th>
              <th scope="col">Version</th>
              <th scope="col">File</th>
              <th scope="col">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.seq} data-testid="log-entry" data-event={e.event}>
                <td>{e.seq}</td>
                <td>{e.event}</td>
                <td>{e.stage ?? ""}</td>
                <td>{e.code ?? ""}</td>
                <td>{e.route ?? ""}</td>
                <td>{e.ruleId ?? ""}</td>
                <td title={e.record ? `model ${e.record.model}, batch ${e.record.batch}` : undefined}>{short(e.record?.model)}</td>
                <td>{e.version ?? ""}</td>
                <td title={e.fileSha256}>{e.fileRole ? `${e.fileRole} ${short(e.fileSha256)}` : ""}</td>
                <td>{e.outcome}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
