import { useEffect, useMemo, useState } from "react";
import { importEvents, readinessEvents } from "../model/log";
import { project, type Projection } from "../model/disclosure";
import type { ProductRecord } from "../model/ingress";
import { assess, ruleText, structuralChecks, type RouteReadiness } from "../model/readiness";
import { useLatestSnapshot, useRecordStore } from "../model/recordStore";
import { ROUTES, ROUTE_NAMES, type ProfilePack, type Route } from "../model/profile";
import { READINESS_SAMPLES, importSample } from "./sampleFiles";

/** Fixed notice: what these checks are and are not (criterion C3-06). */
export const READINESS_NOTICE =
  "These are selected structural, completeness and route checks on the imported record. They are not a conformity assessment, and nothing here says that a product or a record is compliant with any standard or regulation.";

const STATE_TEXT = { present: "Present", missing: "Missing", inaccessible: "Not accessible to this recipient", challenged: "Challenged" } as const;

/**
 * Shows, for each imported product record, which routes are ready and which are on hold, and why (Cycle 3).
 * Every hold names its rule, the property and where the source assertions are. The recipient view renders only
 * what `project` returns, so it cannot show a value the matrix does not permit for that recipient.
 */
export function ReadinessView() {
  const { profile, error, saveImport, record } = useRecordStore();
  const { setSelected } = useRecordStore();
  const { records, selected, latest } = useLatestSnapshot();
  const [sample, setSample] = useState(READINESS_SAMPLES[0].id);
  const [loadError, setLoadError] = useState<string | null>(null);

  if (error) {
    return (
      <div className="app import">
        <div className="banner warn" role="alert">
          <span>The contract pack could not be verified, so no readiness can be shown: {error}</span>
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

  return (
    <div className="app import readiness">
      <header className="profile-head">
        <h1>Route readiness</h1>
        <p className="banner info" data-testid="readiness-notice">
          <span>{READINESS_NOTICE}</span>
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
            setLoadError(null);
            try {
              const loaded = await importSample(profile, READINESS_SAMPLES.find((x) => x.id === sample)!);
              await record([loaded.results.erp, loaded.results.lab].flatMap((r) => (r ? importEvents(r) : [])));
              await saveImport(loaded.state, undefined, loaded.inputs);
            } catch (e) {
              setLoadError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Load record state
        </button>
      </div>
      {loadError && (
        <div className="banner warn" role="alert">
          <span>{loadError}</span>
        </div>
      )}

      {records.length > 1 && (
        <div className="import-samples">
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
        </div>
      )}

      {!latest ? (
        <p className="hint" data-testid="readiness-empty">
          No record yet. Import an ERP extract and a laboratory file on the Import screen, or load a prepared record state above. A record is
          stored once both files are accepted.
        </p>
      ) : (
        <>
          <p className="hint small" data-testid="readiness-version">
            Latest version of the record: version {latest.version}. It is the version the Record and Outputs screens show.
          </p>
          <RecordReadiness key={`${latest.model}|${latest.batch}|${latest.version}`} profile={profile} record={latest.record} />
        </>
      )}
    </div>
  );
}

function RecordReadiness({ profile, record }: { profile: ProfilePack; record: ProductRecord }) {
  const readiness = useMemo(() => assess(profile, record), [profile, record]);
  const { record: log } = useRecordStore();
  // Each assessment of a record state is logged once: the verdict per route and the rules that hold it, never a value.
  useEffect(() => {
    void log(readinessEvents(record.model, record.batch, readiness));
  }, [log, record, readiness]);
  const checks = useMemo(() => structuralChecks(profile, record), [profile, record]);
  const label = useMemo(() => new Map(profile.properties.map((p) => [p.id, p.labels.en])), [profile]);
  const [viewRoute, setViewRoute] = useState<Route>("customer-pdf");
  const projection = useMemo(() => project(profile, record, viewRoute), [profile, record, viewRoute]);
  const propertyName = (id: string | null) => (id === null ? "the route itself" : (label.get(id) ?? id));

  return (
    <section className="profile-section" aria-label={`Readiness of record ${record.model}, batch ${record.batch}`}>
      <h2>
        Record {record.model}, batch {record.batch}
      </h2>

      <ul className="readiness-checks" aria-label="Structural checks">
        {checks.map((c) => (
          <li key={c.id} data-testid="structural-check" data-check={c.id} data-state={c.passed ? "passed" : "failed"}>
            <strong>{c.passed ? "Passed" : "Not passed"}</strong> {c.text}
            {c.detail && <span className="small hint"> ({c.detail})</span>}
          </li>
        ))}
      </ul>

      <div className="readiness-routes">
        {readiness.map((r) => (
          <RouteCard key={r.route} readiness={r} profile={profile} label={propertyName} />
        ))}
      </div>

      <div className="readiness-recipient">
        <h3>View as recipient</h3>
        <div role="group" aria-label="Recipient" className="readiness-switch">
          {ROUTES.map((route) => (
            <button
              key={route}
              type="button"
              className="ghost"
              aria-pressed={viewRoute === route}
              data-route={route}
              onClick={() => setViewRoute(route)}
            >
              {ROUTE_NAMES[route]}
            </button>
          ))}
        </div>
        <RecipientView projection={projection} label={(id) => label.get(id) ?? id} />
        <Withheld projection={projection} label={(id) => label.get(id) ?? id} />
      </div>
    </section>
  );
}

function RouteCard({ readiness: r, profile, label }: { readiness: RouteReadiness; profile: ProfilePack; label: (id: string | null) => string }) {
  return (
    <article className="import-file readiness-route" data-testid="route-status" data-route={r.route} data-state={r.status}>
      <h3>
        {ROUTE_NAMES[r.route]} <span className="import-verdict">{r.status === "ready" ? "Ready" : "On hold"}</span>
      </h3>
      <p className="small hint">Recipient: {r.recipient}</p>

      {r.holds.length > 0 && (
        <ul className="import-errors">
          {r.holds.map((h, i) => (
            <li key={i} data-testid="hold-reason" data-rule={h.ruleId}>
              <strong>{h.ruleId}</strong>: {ruleText(profile, h.ruleId)}
              <div className="small">
                Property: {h.property === null ? label(null) : `${h.property} ${label(h.property)}`}
                {h.member ? ` (${h.member})` : ""}
              </div>
              <div className="small hint">
                {h.sources.length ? `Source: ${h.sources.map((s) => s.location).join("; ")}` : h.ruleId === "RR-STANDING-HOLD" ? profile.routes[r.route].holdReason : "No source value exists: the value is missing."}
              </div>
            </li>
          ))}
        </ul>
      )}

      <table className="profile-table import-table">
        <thead>
          <tr>
            <th scope="col">Required property</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {r.required.map((p) => (
            <tr key={p.property} data-testid="required-property" data-property={p.property} data-state={p.state} data-assured={p.assured}>
              <td>
                <strong>{p.property}</strong> {label(p.property)}
              </td>
              <td>
                {STATE_TEXT[p.state]}
                {p.state !== "missing" && p.state !== "inaccessible" && !p.assured ? ", not sufficiently assured" : ""}
                <span className="import-flags">
                  {p.flags
                    .filter((f) => ["unknown-code", "several-results", "draft-text", "evidence-digest-missing", "challenged"].includes(f))
                    .map((f) => (
                      <span key={f} className="import-flag" data-flag={f}>
                        {f}
                      </span>
                    ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}

/** Renders only what `project` returned for the recipient, nothing taken from the record directly. */
function RecipientView({ projection, label }: { projection: Projection; label: (id: string) => string }) {
  return (
    <div className="readiness-view" data-testid="recipient-view" data-route={projection.route} data-on-hold={projection.onHold}>
      <p className="small hint">
        What the recipient ({projection.recipient}) would receive{projection.onHold ? ". The route is on hold, so nothing would be sent." : "."}
      </p>
      <table className="profile-table import-table">
        <thead>
          <tr>
            <th scope="col">Property</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {projection.values.map((v) => (
            <tr key={`${v.property}|${v.member ?? ""}|${v.qualifier ?? ""}`} data-testid="recipient-value" data-property={v.property}>
              <td>
                {label(v.property)}
                {v.member && <div className="small hint">{v.member}</div>}
                {v.qualifier && <div className="small hint">{v.qualifier}</div>}
              </td>
              <td>
                {v.assertions.map((a, i) => (
                  <div key={i}>
                    <code>{a.raw}</code>
                    {a.unit ? ` ${a.unit}` : ""}
                    <div className="small hint" data-testid="recipient-source">{a.source.role}, {a.source.position}</div>
                  </div>
                ))}
                {v.status === "challenged" && <span className="import-flag" data-flag="challenged">challenged</span>}
              </td>
            </tr>
          ))}
          {projection.derived.map((d) => (
            <tr key={d.property} data-testid="recipient-derived" data-property={d.property}>
              <td>{label(d.property)}</td>
              <td>
                {d.within ? "Within" : "Outside"} the limits ({d.basis})
                <div className="small hint">{[...new Set(d.sources.map((s) => `${s.role}, ${s.position}`))].join("; ")}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Operator-side list of what the matrix keeps from this recipient. It is outside the recipient view on purpose. */
function Withheld({ projection, label }: { projection: Projection; label: (id: string) => string }) {
  if (!projection.withheld.length) return null;
  return (
    <div className="readiness-withheld">
      <p className="small hint">Withheld from this recipient (shown to you, not to them):</p>
      <ul>
        {projection.withheld.map((w) => (
          <li key={w.property} data-testid="withheld" data-property={w.property} data-decision={w.decision} className="small">
            {w.property} {label(w.property)}: {w.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
