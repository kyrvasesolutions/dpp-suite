import { useCallback, useEffect, useMemo, useState } from "react";
import { importEvents, recordExportEvent, recordImportEvent, recordImportRefusedEvent, releaseEvents } from "../model/log";
import { CentralRecordError, exportCentralRecord, importCentralRecord, restoreCentralRecord } from "../model/centralRecord";
import { outputRef, trace } from "../model/lineage";
import { verifyRelease, type VerifyResult } from "../model/outputs/manifest";
import { generateRelease, type Release } from "../model/outputs/release";
import { RouteRefusedError } from "../model/outputs/items";
import { ROUTES, ROUTE_NAMES, type Route } from "../model/profile";
import { ruleText } from "../model/readiness";
import { useRecordStore } from "../model/recordStore";
import type { Snapshot } from "../model/recordRepository";
import { LogPanel } from "./LogPanel";
import { READINESS_SAMPLES, importSample } from "./sampleFiles";

const short = (digest: string) => `${digest.slice(0, 12)}…`;

/** Starts a browser download of bytes. The file is made on this device and goes nowhere else. */
function save(name: string, type: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const bytesOf = async (f: File) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });

/**
 * The Outputs screen (Cycle 4): the three route outputs for one version of the central record, the release manifest and its
 * verification, the snapshot history, the portable export and import of the central record, and a lineage panel that traces any
 * output value to its mapping step and source. Files are made on this device by the output builders, which build only
 * from the projection of each route; a route that is on hold shows its reasons and makes no file (the registry draft is
 * always a HOLD draft and is never sent).
 */
export function OutputsView() {
  const { profile, error, repository, state, setState, saveImport, record: log } = useRecordStore();
  const [records, setRecords] = useState<Array<{ model: string; batch: string }>>([]);
  const [selected, setSelected] = useState<{ model: string; batch: string } | null>(null);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const [release, setRelease] = useState<Release | null>(null);
  const [message, setMessage] = useState<{ kind: "info" | "warn"; text: string } | null>(null);
  const [sample, setSample] = useState(READINESS_SAMPLES[0].id);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    repository.records().then((r) => live && setRecords(r), () => live && setRecords([]));
    return () => {
      live = false;
    };
  }, [repository, tick]);

  // The record shown: the chosen one, else the one just imported or loaded, else the first stored
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
  }, [repository, selected, tick]);

  const snapshot = history.find((s) => s.version === version) ?? null;

  useEffect(() => {
    let live = true;
    setRelease(null);
    if (!profile || !snapshot) return;
    generateRelease(profile, snapshot).then(
      (r) => {
        if (!live) return;
        setRelease(r);
        void log(releaseEvents(snapshot.model, snapshot.batch, snapshot.version, r.outcomes));
      },
      (e: unknown) => live && setMessage({ kind: "warn", text: `The outputs could not be made: ${e instanceof Error ? e.message : String(e)}` }),
    );
    return () => {
      live = false;
    };
  }, [profile, snapshot, log]);

  if (error) {
    return (
      <div className="app import">
        <div className="banner warn" role="alert">
          <span>The contract pack could not be verified, so no outputs can be made: {error}</span>
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

  const latest = history[history.length - 1];
  return (
    <div className="app import outputs">
      <header className="profile-head">
        <h1>Outputs</h1>
        <p className="hint">
          Three outputs for one version of the central record, made on this device from what each recipient may see. Nothing is sent
          anywhere.
        </p>
      </header>

      <div className="import-samples">
        <label>
          Prepared record states
          <select value={sample} onChange={(e) => setSample(e.target.value)}>
            {READINESS_SAMPLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="ghost"
          onClick={async () => {
            try {
              const loaded = await importSample(profile, READINESS_SAMPLES.find((x) => x.id === sample)!);
              await log([loaded.results.erp, loaded.results.lab].flatMap((r) => (r ? importEvents(r) : [])));
              setState(loaded.state);
              await saveImport(loaded.state);
              setSelected(null);
              refresh();
              setMessage(null);
            } catch (e) {
              setMessage({ kind: "warn", text: e instanceof Error ? e.message : String(e) });
            }
          }}
        >
          Load record state
        </button>
        {records.length > 1 && (
          <label>
            Record
            <select
              value={selected ? `${selected.model}|${selected.batch}` : ""}
              onChange={(e) => {
                const [model, batch] = e.target.value.split("|");
                setSelected({ model, batch });
              }}
            >
              {records.map((r) => (
                <option key={`${r.model}|${r.batch}`} value={`${r.model}|${r.batch}`}>
                  {r.model}, batch {r.batch}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {message && (
        <div className={`banner ${message.kind}`} role={message.kind === "warn" ? "alert" : "status"} data-testid="outputs-message">
          <span>{message.text}</span>
        </div>
      )}

      {!snapshot ? (
        <p className="hint" data-testid="outputs-empty">
          No central record yet. Import an ERP extract on the Import screen, or load a prepared record state above. Each accepted import is stored
          as a version of the central record.
        </p>
      ) : (
        <>
          <p className="hint small" data-testid="outputs-record">
            Record {snapshot.model}, batch {snapshot.batch}, version {snapshot.version} of {latest?.version}
            {snapshot.version !== latest?.version ? " (an earlier version, read only)" : ""}. Digest <code title={snapshot.digest}>{short(snapshot.digest)}</code>.
          </p>

          <section className="profile-section" aria-label="Outputs by route">
            <h2>Outputs by route</h2>
            {!release ? (
              <p className="hint" role="status">
                Making the outputs…
              </p>
            ) : (
              <div className="readiness-routes">
                {ROUTES.map((route) => {
                  const outcome = release.outcomes.find((o) => o.route === route);
                  return <RouteOutput key={route} route={route} outcome={outcome} profile={profile} />;
                })}
              </div>
            )}
          </section>

          {release && (
            <section className="profile-section" aria-label="Release">
              <h2>Release</h2>
              <p className="hint small">
                The release manifest lists the software version, the contract pack and every file it pins, the input files, the record
                version and each output by digest, and where every output value came from. Its only date and time is the generated time and role, which are in no digest: the substantive digest covers everything else.
              </p>
              <p data-testid="manifest" data-digest={release.manifestFile.substantiveDigest}>
                <strong>{release.manifestFile.fileName}</strong>, substantive digest{" "}
                <code title={release.manifestFile.substantiveDigest}>{short(release.manifestFile.substantiveDigest)}</code>. Generated{" "}
                <span data-testid="manifest-generated">
                  {release.manifest.generated.at} by {release.manifest.generated.by}
                </span>{" "}
                <button type="button" className="ghost" onClick={() => save(release.manifestFile.fileName, release.manifestFile.mediaType, release.manifestFile.bytes)}>
                  Download manifest
                </button>
              </p>
              <Verify profile={profile} />
            </section>
          )}

          {release && <Lineage release={release} profile={profile} />}
        </>
      )}

      <section className="profile-section" aria-label="History">
        <h2>History of the record</h2>
        {history.length === 0 ? (
          <p className="hint">No versions yet.</p>
        ) : (
          <table className="profile-table import-table">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Replaces</th>
                <th scope="col">Actor</th>
                <th scope="col">Reason</th>
                <th scope="col">Digest</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {history.map((s) => (
                <tr key={s.version} data-testid="snapshot" data-version={s.version} aria-current={s.version === version ? "true" : undefined}>
                  <td>{s.version}</td>
                  <td>{s.supersedes ? `version ${s.supersedes.version} (${short(s.supersedes.digest)})` : "nothing"}</td>
                  <td>{s.actor}</td>
                  <td>
                    {s.reason}
                    {s.origin && <div className="small hint" data-testid="snapshot-origin">{s.origin}</div>}
                  </td>
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
        )}
        {snapshot && (
          <details data-testid="snapshot-values">
            <summary>Values of version {snapshot.version} (read only)</summary>
            <table className="profile-table import-table">
              <thead>
                <tr>
                  <th scope="col">Property</th>
                  <th scope="col">Value as in the source</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.record.values.map((v) => (
                  <tr key={`${v.property}|${v.member ?? ""}|${v.qualifier ?? ""}`}>
                    <td>
                      {profile.properties.find((p) => p.id === v.property)?.labels.en ?? v.property}
                      {v.member ? ` / ${v.member}` : ""}
                      {v.qualifier ? ` (${v.qualifier})` : ""}
                    </td>
                    <td>
                      <code>{v.assertions.map((a) => a.raw).join(" / ")}</code>
                    </td>
                    <td className="small">{v.assertions.map((a) => a.source.location).join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </section>

      <section className="profile-section" aria-label="Central record">
        <h2>Central record</h2>
        <p className="hint small">Export every version of the selected record as one file, or import such a file. Only the operator may do this.</p>
        <div className="import-samples">
          <button
            type="button"
            className="ghost"
            disabled={!selected || !history.length}
            onClick={async () => {
              try {
                const file = await exportCentralRecord(repository, profile, selected!.model, selected!.batch);
                await log([await recordExportEvent(selected!.model, selected!.batch, history[history.length - 1].version)]);
                save(file.fileName, file.mediaType, file.bytes);
                setMessage({ kind: "info", text: `Exported ${history.length} version${history.length === 1 ? "" : "s"} as ${file.fileName}.` });
              } catch (e) {
                setMessage({ kind: "warn", text: e instanceof Error ? e.message : String(e) });
              }
            }}
          >
            Export central record
          </button>
          <label className="import-picker">
            Import central record (.json)
            <input
              type="file"
              accept=".json,application/json"
              data-testid="pick-central"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                try {
                  const imported = await importCentralRecord((await bytesOf(f)).bytes, profile);
                  const { added, skipped } = await restoreCentralRecord(repository, imported);
                  await log([await recordImportEvent(imported.model, imported.batch, imported.snapshots[imported.snapshots.length - 1].version)]);
                  setSelected({ model: imported.model, batch: imported.batch });
                  // show the latest version of what was imported, not the version that was open before
                  setVersion(null);
                  refresh();
                  setMessage({ kind: "info", text: `Central record imported: ${added} version${added === 1 ? "" : "s"} added, ${skipped} already here.` });
                } catch (err) {
                  await log([recordImportRefusedEvent()]);
                  setMessage({ kind: "warn", text: err instanceof CentralRecordError || err instanceof Error ? err.message : String(err) });
                }
              }}
            />
          </label>
        </div>
      </section>

      <LogPanel />
    </div>
  );
}

function RouteOutput({ route, outcome, profile }: { route: Route; outcome: Release["outcomes"][number] | undefined; profile: NonNullable<ReturnType<typeof useRecordStore>["profile"]> }) {
  const info = profile.routes[route];
  if (!outcome) return null;
  if ("refused" in outcome) {
    const e: RouteRefusedError = outcome.refused;
    return (
      <article className="route-card" data-testid="output-route" data-route={route} data-state="refused">
        <h3>{ROUTE_NAMES[route]}</h3>
        <p className="hint small">{info.recipient}</p>
        <div className="banner warn" data-testid="refusal">
          <span>
            <strong>No file is made.</strong> {e.holds.length ? "The route is on hold:" : e.message}
          </span>
        </div>
        <ul>
          {e.holds.map((h, i) => (
            <li key={i} data-testid="hold-reason" data-rule={h.ruleId}>
              <strong>{h.ruleId}</strong> {ruleText(profile, h.ruleId)}
              {h.property && <span className="small hint"> ({profile.properties.find((p) => p.id === h.property)?.labels.en ?? h.property})</span>}
              {h.detail && <span className="small" data-testid="hold-detail"> Character {h.detail}.</span>}
              {h.sources.map((x, j) => (
                <div key={j} className="small hint" data-testid="hold-source">
                  {x.location}
                </div>
              ))}
            </li>
          ))}
        </ul>
      </article>
    );
  }
  const f = outcome.file;
  const draft = f.status === "hold";
  return (
    <article className="route-card" data-testid="output-route" data-route={route} data-state={draft ? "hold-draft" : "ready"}>
      <h3>{ROUTE_NAMES[route]}</h3>
      <p className="hint small">{info.recipient}</p>
      {draft && (
        <div className="banner warn" data-testid="draft-notice">
          <span>
            <strong>Draft, on hold, never submitted.</strong> {info.holdReason ?? ""}
          </span>
        </div>
      )}
      {draft && (
        <ul>
          {f.holds.map((h, i) => (
            <li key={i} data-testid="hold-reason" data-rule={h.ruleId}>
              <strong>{h.ruleId}</strong> {ruleText(profile, h.ruleId)}
            </li>
          ))}
        </ul>
      )}
      <p className="small">
        {f.fileName} ({f.bytes.length} bytes)
      </p>
      <button type="button" data-testid="download" data-route={route} onClick={() => save(f.fileName, f.mediaType, f.bytes)}>
        {draft ? "Download draft (HOLD)" : "Download"}
      </button>
    </article>
  );
}

function Verify({ profile }: { profile: NonNullable<ReturnType<typeof useRecordStore>["profile"]> }) {
  const [manifest, setManifest] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [files, setFiles] = useState<Array<{ name: string; bytes: Uint8Array }>>([]);
  const [result, setResult] = useState<VerifyResult | null>(null);
  return (
    <div className="import-pickers">
      <label className="import-picker">
        Manifest to verify against (.json)
        <input
          type="file"
          accept=".json,application/json"
          data-testid="verify-manifest"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            setResult(null);
            setManifest(f ? await bytesOf(f) : null);
          }}
        />
      </label>
      <label className="import-picker">
        Downloaded files to check
        <input
          type="file"
          multiple
          data-testid="verify-files"
          onChange={async (e) => {
            setResult(null);
            setFiles(await Promise.all([...(e.target.files ?? [])].map(bytesOf)));
          }}
        />
      </label>
      <button
        type="button"
        className="ghost"
        disabled={!manifest}
        onClick={async () => setResult(await verifyRelease(manifest!.bytes, files, profile))}
      >
        Verify files
      </button>
      {result && (
        <div className={`banner ${result.ok ? "info" : "warn"}`} data-testid="verify-result" data-ok={result.ok}>
          <span>
            {result.ok ? "Every file checked matches the manifest." : "The files do not match the manifest:"}
            <ul>
              {result.checks.map((c, i) => (
                <li key={i} data-status={c.status}>
                  {c.kind} {c.name}: {c.status}
                </li>
              ))}
            </ul>
          </span>
        </div>
      )}
    </div>
  );
}

function Lineage({ release, profile }: { release: Release; profile: NonNullable<ReturnType<typeof useRecordStore>["profile"]> }) {
  const [route, setRoute] = useState<Route>("customer-pdf");
  const file = release.files.find((f) => f.route === route);
  const present = useMemo(() => file?.items.filter((i) => i.present) ?? [], [file]);
  const [step, setStep] = useState("");
  const item = present.find((i) => i.step === step) ?? present[0];
  const chain = file && item ? trace(file.lineage, outputRef(route, item.step)) : [];
  return (
    <section className="profile-section" aria-label="Lineage">
      <h2>Where an output value comes from</h2>
      <div className="import-samples">
        <label>
          Output
          <select value={route} onChange={(e) => (setRoute(e.target.value as Route), setStep(""))}>
            {ROUTES.filter((r) => release.files.some((f) => f.route === r)).map((r) => (
              <option key={r} value={r}>
                {ROUTE_NAMES[r]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Value
          <select value={item?.step ?? ""} onChange={(e) => setStep(e.target.value)} data-testid="lineage-pick">
            {present.map((i) => (
              <option key={i.step} value={i.step}>
                {i.label.en}
                {i.role === "context" ? ` (${i.step})` : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {item && (
        <div data-testid="lineage" data-step={item.step} data-route={route}>
          <p>
            <strong>{item.label.en}</strong>: <code>{item.text}</code>
          </p>
          <p className="small">
            Mapping step <code>{item.step}</code>
            {item.ruleId && (
              <>
                , derived by rule <code>{item.ruleId}</code>
              </>
            )}
            . {chain.length} source value{chain.length === 1 ? "" : "s"}:
          </p>
          <ul>
            {chain.map((e, i) => (
              <li key={i} data-testid="lineage-source" className="small">
                {profile.properties.find((p) => p.id === e.property)?.labels.en ?? e.property}
                {e.member ? ` / ${e.member}` : ""}: {e.assertion.role === "erp" ? "ERP extract" : "Laboratory file"} <code>{e.assertion.location}</code>, sha256{" "}
                <code title={e.assertion.sha256}>{short(e.assertion.sha256)}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
