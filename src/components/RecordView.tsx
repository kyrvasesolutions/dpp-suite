import { useCallback, useEffect, useMemo, useState } from "react";
import { CorrectionError, correctRecord, diffSnapshots, REASON_MAX } from "../model/correction";
import { byRole, flagTextFor, type Flag, type RecordValue } from "../model/ingress";
import { correctionEvent } from "../model/log";
import { generateRelease, type Release } from "../model/outputs/release";
import { decide } from "../model/policy";
import { ROUTES, ROUTE_NAMES, type Route } from "../model/profile";
import { assess, ruleText } from "../model/readiness";
import type { Snapshot } from "../model/recordRepository";
import { useRecordStore } from "../model/recordStore";

const short = (digest: string) => `${digest.slice(0, 12)}…`;
const ACCESS_TEXT = { permit: "Permitted", deny: "Withheld", derived: "Derived only" } as const;

/** The kind of a value, from the flags of the assertion that stands for it. */
function kindOf(v: RecordValue): string {
  const a = v.assertions[0];
  if (a.flags.includes("corrected")) return "corrected by the operator";
  if (a.flags.includes("measured")) return "measured";
  if (a.flags.includes("calculated-externally")) return "calculated externally";
  return "declared";
}

const keyOf = (v: { property: string; member?: string; qualifier?: string }) => `${v.property}|${v.member ?? ""}|${v.qualifier ?? ""}`;

/**
 * The Record screen (Cycle 5): one record, from its sources through its values and each route to the output.
 * It shows the files the record came from, every value with its status, flags and kind, what each route may see and
 * whether it is ready, and the output made or refused. It corrects one value of the selected record, always as a new
 * version with a reason, and shows the field-level difference between any two versions.
 */
export function RecordView() {
  const { profile, error, repository, state, imports, record: log, logVersion, selected, setSelected, repoVersion, touch } = useRecordStore();
  const [records, setRecords] = useState<Array<{ model: string; batch: string }>>([]);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const [release, setRelease] = useState<Release | null>(null);
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ kind: "info" | "warn"; text: string } | null>(null);
  const [diffFrom, setDiffFrom] = useState<number | null>(null);
  const [diffTo, setDiffTo] = useState<number | null>(null);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    repository.records().then((r) => live && setRecords(r), () => live && setRecords([]));
    return () => {
      live = false;
    };
  }, [repository, tick, repoVersion, logVersion]);

  useEffect(() => {
    if (selected && records.some((r) => r.model === selected.model && r.batch === selected.batch)) return;
    const fromState = state?.records.find((r) => records.some((x) => x.model === r.model && x.batch === r.batch));
    setSelected(fromState ? { model: fromState.model, batch: fromState.batch } : (records[0] ?? null));
  }, [records, selected, state]);

  useEffect(() => {
    let live = true;
    if (!selected) {
      setHistory([]);
      setVersion(null);
      return;
    }
    repository.history(selected.model, selected.batch).then((h) => {
      if (!live) return;
      setHistory(h);
      setVersion((v) => (v !== null && h.some((s) => s.version === v) ? v : (h[h.length - 1]?.version ?? null)));
    });
    return () => {
      live = false;
    };
  }, [repository, selected, tick, repoVersion]);

  const snapshot = history.find((s) => s.version === version) ?? null;
  const latest = history[history.length - 1];

  useEffect(() => {
    let live = true;
    setRelease(null);
    if (!profile || !snapshot) return;
    generateRelease(profile, snapshot).then((r) => live && setRelease(r), () => live && setRelease(null));
    return () => {
      live = false;
    };
  }, [profile, snapshot]);

  const label = useMemo(() => new Map(profile?.properties.map((p) => [p.id, p.labels.en]) ?? []), [profile]);
  const readiness = useMemo(() => (profile && snapshot ? assess(profile, snapshot.record) : []), [profile, snapshot]);

  if (error) {
    return (
      <div className="app import">
        <div className="banner warn" role="alert">
          <span>The contract pack could not be verified, so no record can be shown: {error}</span>
        </div>
      </div>
    );
  }
  if (!profile) {
    return (
      <div className="app import">
        <p className="hint" role="status">
          Verifying the contract pack…
        </p>
      </div>
    );
  }

  const from = history.find((s) => s.version === (diffFrom ?? (history.length > 1 ? history[history.length - 2].version : -1)));
  const to = history.find((s) => s.version === (diffTo ?? latest?.version));
  const diff = from && to ? diffSnapshots(from, to) : null;
  const goto = (screen: string) => () => {
    window.location.hash = screen;
  };

  const startEdit = (v: RecordValue) => {
    setEditing(keyOf(v));
    setText("");
    setReason("");
    setMessage(null);
  };

  const save = async (v: RecordValue) => {
    if (!selected) return;
    try {
      const made = await correctRecord(profile, repository, { model: selected.model, batch: selected.batch, property: v.property, member: v.member, qualifier: v.qualifier, raw: text, reason });
      await log([await correctionEvent(made.model, made.batch, made.version)]);
      setEditing(null);
      setVersion(null);
      setDiffFrom(null);
      setDiffTo(null);
      refresh();
      touch();
      setMessage({ kind: "info", text: `Corrected: version ${made.version} of the record was made. The earlier value stays visible.` });
    } catch (e) {
      setMessage({ kind: "warn", text: e instanceof CorrectionError || e instanceof Error ? e.message : String(e) });
    }
  };

  const importFiles = [imports.erp, imports.lab].filter((r): r is NonNullable<typeof r> => !!r);

  return (
    <div className="app import record" data-testid="record-view">
      <header className="profile-head">
        <h1>Record</h1>
        <p className="hint">
          One record from its source files to what each route receives. All values in this demonstrator are synthetic. Nothing is sent anywhere.
        </p>
      </header>

      {records.length > 1 && (
        <div className="import-samples">
          <label>
            Record
            <select
              value={selected ? `${selected.model}|${selected.batch}` : ""}
              onChange={(e) => {
                const [model, batch] = e.target.value.split("|");
                setSelected({ model, batch });
                setEditing(null);
              }}
            >
              {records.map((r) => (
                <option key={`${r.model}|${r.batch}`} value={`${r.model}|${r.batch}`}>
                  {r.model}, batch {r.batch}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {message && (
        <div className={`banner ${message.kind}`} role={message.kind === "warn" ? "alert" : "status"} data-testid="record-message">
          <span>{message.text}</span>
        </div>
      )}

      {!snapshot ? (
        <p className="hint" data-testid="record-empty">
          No record yet. Import an ERP extract and a laboratory file on the Import screen; each accepted import is stored as a version of the record.
        </p>
      ) : (
        <>
          <p className="hint small" data-testid="record-head">
            Record {snapshot.model}, batch {snapshot.batch}, version {snapshot.version} of {latest?.version}
            {snapshot.version !== latest?.version ? " (an earlier version, read only)" : ""}. Record digest (the one on the customer sheet):{" "}
            <code data-testid="record-digest-shown" title={snapshot.record.digest}>
              {short(snapshot.record.digest)}
            </code>
            . Version digest (this version with its sources, actor and reason):{" "}
            <code data-testid="version-digest" title={snapshot.digest}>
              {short(snapshot.digest)}
            </code>
            .
          </p>

          <section className="profile-section" aria-label="Sources">
            <h2>Sources</h2>
            <table className="profile-table import-table">
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Name</th>
                  <th scope="col">sha256</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.record.sources.map((s) => (
                  <tr key={`${s.role}|${s.name}`} data-testid="record-source" data-role={s.role} data-status="accepted">
                    <td>{s.role === "erp" ? "ERP extract" : s.role === "lab" ? "Laboratory file" : "Operator correction"}</td>
                    <td>{s.name}</td>
                    <td>
                      <code title={s.sha256}>{short(s.sha256)}</code>
                    </td>
                    <td>Accepted</td>
                  </tr>
                ))}
                {importFiles
                  .filter((r) => !r.ok)
                  .map((r) => (
                    <tr key={`rejected|${r.file.role}`} data-testid="record-source" data-role={r.file.role} data-status="rejected">
                      <td>{r.file.role === "erp" ? "ERP extract" : "Laboratory file"}</td>
                      <td>{r.file.name}</td>
                      <td>{r.file.sha256 ? <code title={r.file.sha256}>{short(r.file.sha256)}</code> : "not read"}</td>
                      <td>Rejected{!r.ok ? ` (${r.stage}: ${r.errors.map((e) => e.code).join(", ")})` : ""} in the latest import; it is not part of any record.</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>

          <section className="profile-section" aria-label="Record values">
            <h2>Record values</h2>
            <p className="hint small">
              Status is single, agreeing, challenged or corrected. After a correction the corrected value stands, and the earlier value stays visible with its source.
            </p>
            <table className="profile-table import-table">
              <thead>
                <tr>
                  <th scope="col">Property</th>
                  <th scope="col">Value</th>
                  <th scope="col">Status and kind</th>
                  <th scope="col">Flags</th>
                  <th scope="col">Sources</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {snapshot.record.values.map((v) => {
                  const k = keyOf(v);
                  const [now, ...earlier] = v.assertions;
                  const shown = v.status === "challenged" ? v.assertions : [now];
                  // only a value a correction replaced is "earlier" and struck through; sources that agree are simply also stated
                  const past = v.status === "corrected" ? earlier : [];
                  const alsoStated = v.status === "agreeing" ? earlier : [];
                  // only the latest version, and only a value a correction may change (not an identifier or an evidence reference)
                  const editable = snapshot.version === latest?.version && ![byRole(profile, "model"), byRole(profile, "batch"), byRole(profile, "evidence")].includes(v.property);
                  return (
                    <tr key={k} data-testid="record-value" data-property={v.property} data-status={v.status} data-key={k}>
                      <td>
                        {label.get(v.property) ?? v.property}
                        {v.member ? ` / ${v.member}` : ""}
                        {v.qualifier ? ` (${v.qualifier})` : ""}
                      </td>
                      <td>
                        {shown.map((a, i) => (
                          <div key={i}>
                            <code data-testid="current-value">{a.raw}</code>
                            {a.unit ? ` ${a.unit}` : ""}
                          </div>
                        ))}
                        {alsoStated.map((a, i) => (
                          <div key={`also-${i}`} className="small hint" data-testid="also-stated">
                            Also stated by {a.source.role === "erp" ? "the ERP extract" : "the laboratory file"}: {a.raw} ({a.source.location})
                          </div>
                        ))}
                        {past.map((a, i) => (
                          <div key={i} className="small hint" data-testid="earlier-value">
                            Earlier: <del>{a.raw}</del>
                            {a.unit ? ` ${a.unit}` : ""} ({a.source.location})
                          </div>
                        ))}
                      </td>
                      <td>
                        <span className="profile-status" data-status={v.status === "challenged" ? "pending-product-rules" : "voluntary"}>
                          {v.status}
                        </span>
                        <div className="small hint" data-testid="value-kind">
                          {kindOf(v)}
                        </div>
                      </td>
                      <td className="small">
                        {[...new Set(v.assertions.flatMap((a) => a.flags))].map((f: Flag) => (
                          <div key={f} data-flag={f}>
                            {flagTextFor(f, v.assertions.find((a) => a.flags.includes(f))!.source.role)}
                          </div>
                        ))}
                        {v.assertions.filter((a) => a.correction).map((a) => (
                          <div key={a.correction!.version} data-testid="correction-note">
                            Corrected in version {a.correction!.version} by {a.correction!.actor}: {a.correction!.reason}
                          </div>
                        ))}
                      </td>
                      <td className="small">{v.assertions.map((a) => a.source.location).join("; ")}</td>
                      <td>
                        {editable && (
                          <button type="button" className="ghost" data-testid="correct-button" onClick={() => startEdit(v)} aria-label={`Correct ${label.get(v.property) ?? v.property}`}>
                            Correct
                          </button>
                        )}
                        {editing === k && (
                          <form
                            data-testid="correct-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void save(v);
                            }}
                          >
                            <label>
                              Corrected value
                              <input data-testid="correct-value" value={text} onChange={(e) => setText(e.target.value)} />
                            </label>
                            <label>
                              Reason (required)
                              <input data-testid="correct-reason" value={reason} maxLength={REASON_MAX} onChange={(e) => setReason(e.target.value)} />
                            </label>
                            <button type="submit" data-testid="correct-save">
                              Save as a new version
                            </button>{" "}
                            <button type="button" className="ghost" onClick={() => setEditing(null)}>
                              Cancel
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="profile-section" aria-label="Routes">
            <h2>Routes and outputs</h2>
            <p className="hint small">What each route may see, whether it is ready, and the output made or refused for this version.</p>
            <div className="readiness-routes">
              {ROUTES.map((route: Route) => {
                const verdict = readiness.find((r) => r.route === route);
                const outcome = release?.outcomes.find((o) => o.route === route);
                return (
                  <article key={route} className="route-card" data-testid="record-route" data-route={route} data-status={verdict?.status}>
                    <h3>{ROUTE_NAMES[route]}</h3>
                    <p className="hint small">{profile.routes[route].recipient}</p>
                    <p>
                      <strong>{verdict?.status === "ready" ? "Ready" : "On hold"}</strong>
                    </p>
                    <ul>
                      {verdict?.holds.map((h, i) => (
                        <li key={i} data-testid="record-hold" data-rule={h.ruleId}>
                          <strong>{h.ruleId}</strong> {ruleText(profile, h.ruleId)}
                          {h.property && <span className="small hint"> ({label.get(h.property) ?? h.property})</span>}
                        </li>
                      ))}
                    </ul>
                    <p data-testid="record-output" data-state={!outcome ? "pending" : "refused" in outcome ? "refused" : outcome.file.status === "hold" ? "hold-draft" : "made"}>
                      {!outcome
                        ? "Making the output…"
                        : "refused" in outcome
                          ? "Output refused: no file is made."
                          : outcome.file.status === "hold"
                            ? `Draft on hold, never submitted: ${outcome.file.fileName}`
                            : `Output made: ${outcome.file.fileName}`}
                    </p>
                    <details>
                      <summary>Access to each property</summary>
                      <ul>
                        {profile.properties
                          .filter((p) => snapshot.record.values.some((v) => v.property === p.id))
                          .map((p) => {
                            const a = decide(profile, route, p.id);
                            return (
                              <li key={p.id} data-testid="record-access" data-property={p.id} data-access={a}>
                                {p.labels.en}: {ACCESS_TEXT[a]}
                              </li>
                            );
                          })}
                      </ul>
                    </details>
                  </article>
                );
              })}
            </div>
            <p>
              <button type="button" className="ghost" onClick={goto("readiness")}>
                Open Readiness
              </button>{" "}
              <button type="button" className="ghost" onClick={goto("outputs")}>
                Open Outputs
              </button>
            </p>
          </section>

          <section className="profile-section" aria-label="Versions and differences">
            <h2>Versions and differences</h2>
            <table className="profile-table import-table">
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Digest</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {history.map((s) => (
                  <tr key={s.version} data-testid="record-version" data-version={s.version}>
                    <td>{s.version}</td>
                    <td>{s.actor}</td>
                    <td>{s.reason}</td>
                    <td>
                      <code title={s.digest}>{short(s.digest)}</code>
                    </td>
                    <td>
                      <button type="button" className="ghost" onClick={() => setVersion(s.version)} aria-pressed={s.version === version}>
                        View version {s.version}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {history.length > 1 && (
              <>
                <div className="import-samples">
                  <label>
                    From version
                    <select data-testid="diff-from" value={from?.version ?? ""} onChange={(e) => setDiffFrom(Number(e.target.value))}>
                      {history.map((s) => (
                        <option key={s.version} value={s.version}>
                          {s.version}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    To version
                    <select data-testid="diff-to" value={to?.version ?? ""} onChange={(e) => setDiffTo(Number(e.target.value))}>
                      {history.map((s) => (
                        <option key={s.version} value={s.version}>
                          {s.version}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {diff && diff.changes.length === 0 && <p className="hint" data-testid="diff-empty">No value differs between version {diff.from} and version {diff.to}.</p>}
                {diff && diff.changes.length > 0 && (
                  <table className="profile-table import-table" data-testid="record-diff" data-from={diff.from} data-to={diff.to}>
                    <thead>
                      <tr>
                        <th scope="col">Property</th>
                        <th scope="col">Change</th>
                        <th scope="col">Field</th>
                        <th scope="col">Before (version {diff.from})</th>
                        <th scope="col">After (version {diff.to})</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diff.changes.flatMap((c) =>
                        c.fields.map((f, i) => (
                          <tr key={`${keyOf(c)}|${f.field}`} data-testid="diff-row" data-property={c.property} data-change={c.change} data-field={f.field}>
                            {i === 0 && (
                              <td rowSpan={c.fields.length}>
                                {label.get(c.property) ?? c.property}
                                {c.member ? ` / ${c.member}` : ""}
                                {c.qualifier ? ` (${c.qualifier})` : ""}
                              </td>
                            )}
                            {i === 0 && <td rowSpan={c.fields.length}>{c.change}</td>}
                            <td>{f.field}</td>
                            <td>{f.before ?? ""}</td>
                            <td>{f.after ?? ""}</td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
