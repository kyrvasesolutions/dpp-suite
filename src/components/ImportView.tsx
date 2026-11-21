import { useEffect, useMemo, useState } from "react";
import pack from "virtual:contract-pack";
import {
  FLAG_TEXT,
  STAGES,
  buildRecords,
  importErpCsv,
  importLabJson,
  type ImportResult,
  type RecordState,
  type RecordValue,
} from "../model/ingress";
import { loadProfilePack, type ProfilePack } from "../model/profile";

/** The synthetic N fixtures that match the embedded pack, served with the app so the operator can try a clean and a faulty import. */
const FIXTURES = import.meta.glob(["@n-fixtures/*.{csv,json}", "!@n-fixtures/MANIFEST.json"], { query: "?url", import: "default", eager: true }) as Record<string, string>;
const BY_NAME = new Map(Object.entries(FIXTURES).map(([path, url]) => [path.split("/").pop()!, url]));
const fixtureUrl = (name: string) => {
  const url = BY_NAME.get(name);
  if (!url) throw new Error(`Sample file ${name} is not in the fixture pack`);
  return url;
};

interface Sample {
  id: string;
  label: string;
  erp?: string;
  lab?: string;
}

const SAMPLES: Sample[] = [
  { id: "clean", label: "Clean pair", erp: "d03a-erp-extract.csv", lab: "d03a-lab-assessment.json" },
  { id: "conflict", label: "Sources disagree on the alloy", erp: "d03a-erp-extract.csv", lab: "lab-conflicting-alloy.json" },
  { id: "unknown-code", label: "Unknown company code", erp: "erp-unknown-company-code.csv", lab: "d03a-lab-assessment.json" },
  { id: "two-footprints", label: "Two footprint results", erp: "d03a-erp-extract.csv", lab: "lab-two-footprints.json" },
  { id: "digest", label: "Evidence without digest", erp: "d03a-erp-extract.csv", lab: "lab-evidence-digest-missing.json" },
  { id: "encoding", label: "ERP extract not UTF-8", erp: "erp-latin1.csv" },
  { id: "missing-column", label: "ERP extract without the alloy column", erp: "erp-missing-alloy-column.csv" },
  { id: "decimal-comma", label: "ERP value with a decimal comma", erp: "erp-decimal-comma.csv" },
  { id: "duplicate-key", label: "Lab file with a duplicate key", lab: "lab-duplicate-key.json" },
  { id: "non-finite", label: "Lab file with 1e999", lab: "lab-non-finite.json" },
  { id: "missing-unit", label: "Lab value without a unit", lab: "lab-missing-unit.json" },
  { id: "wrong-unit", label: "Lab value in inches", lab: "lab-wrong-unit.json" },
  { id: "unit-alias", label: "Lab value in N/mm²", lab: "lab-unit-alias.json" },
];

interface Input {
  bytes: Uint8Array;
  name: string;
  type: string;
}

const short = (digest: string) => `${digest.slice(0, 12)}…`;

const readFile = async (file: File): Promise<Input> => ({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, type: file.type });

async function readFixture(name: string): Promise<Input> {
  const response = await fetch(fixtureUrl(name));
  // The served type of a fixture depends on the web server; the name stands for what the operator's browser would send.
  return { bytes: new Uint8Array(await response.arrayBuffer()), name, type: name.endsWith(".csv") ? "text/csv" : "application/json" };
}

/**
 * Imports the ERP CSV extract and the laboratory/assessment JSON against their pinned contracts and shows the
 * resulting source assertions (Cycle 2). Each file shows how far it got through the ingress stages and every
 * typed error; accepted files show each value verbatim with its source location, status and flags.
 */
export function ImportView() {
  const [profile, setProfile] = useState<ProfilePack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<{ erp?: Input; lab?: Input }>({});
  const [results, setResults] = useState<{ erp?: ImportResult; lab?: ImportResult }>({});
  const [state, setState] = useState<RecordState | null>(null);
  const [previousDigests, setPreviousDigests] = useState<string[] | null>(null);
  const [sample, setSample] = useState(SAMPLES[0].id);

  useEffect(() => {
    loadProfilePack(pack).then(setProfile, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const run = async (next: { erp?: Input; lab?: Input }, again = false) => {
    if (!profile) return;
    const erp = next.erp ? await importErpCsv(profile, next.erp) : undefined;
    const lab = next.lab ? await importLabJson(profile, next.lab) : undefined;
    const built = await buildRecords([erp, lab].filter((r): r is ImportResult => !!r));
    setPreviousDigests(again && state ? state.records.map((r) => r.digest) : null);
    setInputs(next);
    setResults({ erp, lab });
    setState(built);
  };

  const label = useMemo(() => new Map(profile?.properties.map((p) => [p.id, p.labels.en]) ?? []), [profile]);

  if (error) {
    return (
      <div className="app import">
        <div className="banner warn" role="alert">
          <span>The contract pack could not be verified, so nothing can be imported: {error}</span>
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

  const sameAgain =
    previousDigests && state ? previousDigests.length === state.records.length && state.records.every((r, i) => r.digest === previousDigests[i]) : null;

  return (
    <div className="app import">
      <header className="profile-head">
        <h1>Import source files</h1>
        <p className="hint">
          One ERP extract ({profile.inputs.erp.id}@{profile.inputs.erp.version}, CSV with “{profile.inputs.erp.delimiter}”) and one
          laboratory and assessment file ({profile.inputs.lab.id}@{profile.inputs.lab.version}, JSON). Nothing leaves this device.
        </p>
      </header>

      <div className="import-pickers">
        <FilePicker
          role="erp"
          title="ERP extract (.csv)"
          accept=".csv,text/csv"
          onFile={async (f) => run({ ...inputs, erp: await readFile(f) })}
        />
        <FilePicker
          role="lab"
          title="Laboratory and assessment file (.json)"
          accept=".json,application/json"
          onFile={async (f) => run({ ...inputs, lab: await readFile(f) })}
        />
        <div className="import-samples">
          <label>
            Sample files
            <select value={sample} onChange={(e) => setSample(e.target.value)}>
              {SAMPLES.map((s) => (
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
              const s = SAMPLES.find((x) => x.id === sample)!;
              await run({ erp: s.erp ? await readFixture(s.erp) : undefined, lab: s.lab ? await readFixture(s.lab) : undefined });
            }}
          >
            Import sample
          </button>
          <button type="button" className="ghost" disabled={!inputs.erp && !inputs.lab} onClick={() => run(inputs, true)}>
            Import the same files again
          </button>
        </div>
      </div>

      <div className="import-results">
        {results.erp && <FileResult result={results.erp} />}
        {results.lab && <FileResult result={results.lab} />}
      </div>

      {sameAgain !== null && (
        <p className={`banner ${sameAgain ? "info" : "warn"}`} data-testid="reimport" data-same={sameAgain}>
          <span>{sameAgain ? "Imported again: the record state and its digest are identical." : "Imported again: the record state changed."}</span>
        </p>
      )}

      {state && state.unattached.length > 0 && (
        <div className="banner warn" data-testid="unattached">
          <span>
            The laboratory file reports on a model or batch that the ERP extract does not contain. Its {state.unattached.length} values are
            kept but not attached to a record.
          </span>
        </div>
      )}

      {state?.records.map((r) => (
        <section key={`${r.model}|${r.batch}`} className="profile-section" aria-label={`Record ${r.model}, batch ${r.batch}`}>
          <h2>
            Record {r.model}, batch {r.batch}
          </h2>
          <p className="hint small">
            From {r.sources.map((s) => `${s.name} (${short(s.sha256)})`).join(" and ")}. Record digest{" "}
            <code data-testid="record-digest" title={r.digest}>
              {short(r.digest)}
            </code>
            . {r.values.filter((v) => v.status === "challenged").length} challenged,{" "}
            {r.values.filter((v) => v.assertions.some((a) => a.flags.includes("unknown-code"))).length} with an unknown code. There is no
            overall quality score; each flag stands on its own.
          </p>
          <table className="profile-table import-table">
            <thead>
              <tr>
                <th scope="col">Property</th>
                <th scope="col">Value as in the source</th>
                <th scope="col">Source</th>
                <th scope="col">Status and flags</th>
              </tr>
            </thead>
            <tbody>
              {r.values.map((v) => (
                <ValueRow key={`${v.property}|${v.member ?? ""}|${v.qualifier ?? ""}`} value={v} label={label.get(v.property)} />
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

function FilePicker({ role, title, accept, onFile }: { role: string; title: string; accept: string; onFile: (f: File) => void }) {
  return (
    <label className="import-picker">
      {title}
      <input
        type="file"
        accept={accept}
        data-testid={`pick-${role}`}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </label>
  );
}

function FileResult({ result }: { result: ImportResult }) {
  const reached = result.ok ? STAGES.indexOf("authorisation") : STAGES.indexOf(result.stage);
  return (
    <article className="import-file" data-testid={`import-${result.file.role}`} data-ok={result.ok}>
      <h3>
        {result.file.name} <span className="import-verdict">{result.ok ? "Accepted" : `Rejected at stage “${result.stage}”`}</span>
      </h3>
      <ol className="import-stages" aria-label="Ingress stages">
        {STAGES.map((s, i) => (
          <li
            key={s}
            data-state={s === "route" ? "later" : i < reached || (result.ok && i === reached) ? "passed" : i === reached ? "failed" : "not-reached"}
          >
            {s}
          </li>
        ))}
      </ol>
      {result.ok ? (
        <p className="small">
          {result.assertions.length} source assertions kept verbatim. sha256 <code>{short(result.file.sha256)}</code>
        </p>
      ) : (
        <ul className="import-errors">
          {result.errors.map((e, i) => (
            <li key={i} data-testid="import-error" data-code={e.code} data-stage={e.stage}>
              <strong>{e.code}</strong> at {e.location}: {e.message}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function ValueRow({ value: v, label }: { value: RecordValue; label?: string }) {
  return (
    <tr data-testid="record-value" data-property={v.property} data-status={v.status}>
      <td>
        <strong>{v.property}</strong> {label}
        {v.member && <div className="small hint">{v.member}</div>}
        {v.qualifier && <div className="small hint">{v.qualifier}</div>}
      </td>
      <td>
        {v.assertions.map((a, i) => (
          <div key={i}>
            <code>{a.raw === "" ? "(empty)" : a.raw}</code>
            {a.unit ? ` ${a.unit}` : ""}
            {a.value !== a.raw && a.value !== null && typeof a.value === "string" ? ` → ${a.value}` : ""}
          </div>
        ))}
      </td>
      <td className="small">
        {v.assertions.map((a, i) => (
          <div key={i}>{a.source.location}</div>
        ))}
      </td>
      <td>
        <span className="profile-status" data-status={v.status === "challenged" ? "pending-product-rules" : "voluntary"}>
          {v.status}
        </span>
        <span className="import-flags">
          {[...new Set(v.assertions.flatMap((a) => a.flags))].map((f) => (
            <span key={f} className="import-flag" data-flag={f} title={FLAG_TEXT[f]}>
              {f}
            </span>
          ))}
        </span>
      </td>
    </tr>
  );
}

