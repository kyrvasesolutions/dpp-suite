import { useEffect, useMemo, useState } from "react";
import pack from "virtual:contract-pack";
import type { Chain } from "../model/chain";
import { provisionUrl } from "../model/legislation";
import {
  ROUTES,
  ROUTE_NAMES,
  labelFor,
  loadProfilePack,
  lookup,
  memberCount,
  type ProfilePack,
  type ResolvedProperty,
} from "../model/profile";

const STATUS_TEXT: Record<string, string> = {
  "in-force": "In force",
  "pending-product-rules": "Pending product rules",
  voluntary: "Voluntary",
};

const short = (digest: string) => `${digest.slice(0, 12)}…`;

/**
 * Read-only view of the frozen N profile (Cycle 1). Shows what the pinned files hold: the 24 properties
 * with definitions, units, requiredness per route, EN/DE and sector labels, nested members and the
 * source status of each illustrative legal requirement; and the pins and code lists behind them.
 * Nothing here edits the profile (no generic profile editor, FUNC-001 slice).
 */
export function ProfileView({ chain }: { chain: Chain | null }) {
  const [profile, setProfile] = useState<ProfilePack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [lang, setLang] = useState<"en" | "de">("en");
  const [sector, setSector] = useState("");

  useEffect(() => {
    let live = true;
    loadProfilePack(pack).then(
      (loaded) => live && setProfile(loaded),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(() => (profile ? lookup(profile, query) : []), [profile, query]);

  if (error) {
    return (
      <div className="app profile">
        <div className="banner warn" role="alert">
          <span>The contract pack could not be verified, so no profile is shown: {error}</span>
        </div>
      </div>
    );
  }
  if (!profile) {
    return (
      <div className="app profile">
        <p className="hint" role="status">
          Verifying the contract pack…
        </p>
      </div>
    );
  }

  const counts = [
    { id: "properties", label: "Business properties", value: profile.properties.length },
    { id: "members", label: "Nested members", value: memberCount(profile) },
    { id: "routes", label: "Routes", value: ROUTES.length },
    { id: "terms", label: "Governed terms", value: profile.termCount },
    { id: "code-lists", label: "Code lists", value: profile.codeLists.length },
    { id: "files", label: "Pinned files", value: profile.fileCount },
  ];

  return (
    <div className="app profile">
      <header className="profile-head">
        <h1>
          {profile.id} <span className="profile-version">version {profile.version}</span>
        </h1>
        <p className="hint">
          {profile.productFamily}. Released {profile.release.released} by {profile.release.releasedBy}. Manifest digest{" "}
          <code title={profile.manifestDigest}>{short(profile.manifestDigest)}</code>
        </p>
        {profile.standIn && (
          <div className="banner info" data-testid="stand-in-banner">
            <span>
              Public stand-in: the identifiers, definitions and confidential codes are synthetic. The filled pack is kept
              private (decision D1-01).
            </span>
          </div>
        )}
      </header>

      <ul className="profile-counts" aria-label="Profile contents">
        {counts.map((c) => (
          <li key={c.id} className="profile-count" data-testid={`profile-count-${c.id}`}>
            <strong>{c.value}</strong> {c.label}
          </li>
        ))}
      </ul>

      <div className="profile-controls">
        <label>
          Find a property
          <input
            type="search"
            value={query}
            placeholder="ID or label, e.g. ALU-D110 or thickness"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label>
          Language
          <select value={lang} onChange={(e) => setLang(e.target.value as "en" | "de")}>
            <option value="en">English (en)</option>
            <option value="de">Deutsch (de)</option>
          </select>
        </label>
        <label>
          Sector
          <select value={sector} onChange={(e) => setSector(e.target.value)}>
            <option value="">Any sector</option>
            {profile.sectors.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="hint small">
        Source status is illustrative, from the regulatory chain; it is not a legal assessment and nothing monitors
        the law for changes.
      </p>

      <ol className="profile-list" aria-label="Business properties">
        {shown.map((p) => (
          <PropertyRow key={p.id} property={p} lang={lang} sector={sector} chain={chain} />
        ))}
        {shown.length === 0 && <li className="hint">No property matches “{query}”.</li>}
      </ol>

      <section className="profile-section" aria-labelledby="pins-title">
        <h2 id="pins-title">Pinned files</h2>
        <table className="profile-table">
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">File</th>
              <th scope="col">sha256</th>
            </tr>
          </thead>
          <tbody>
            {profile.pins.map((f) => (
              <tr key={f.path}>
                <td>{f.ref}</td>
                <td>
                  <code>{f.path}</code>
                </td>
                <td>
                  <code title={f.digest}>{short(f.digest)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="profile-section" aria-labelledby="codes-title">
        <h2 id="codes-title">Code lists</h2>
        <p className="hint small">
          Each list is a file in the pack. Editing one changes its digest, and the checker refuses it until the
          manifest is rewritten and signed again.
        </p>
        <div className="profile-codes">
          {profile.codeLists.map((c) => (
            <article key={c.ref} className="profile-code" data-testid={`code-list-${c.ref}`}>
              <h3>{c.ref}</h3>
              <p className="hint small">{c.description}</p>
              <p className="small">
                {c.codes.map((x) => (x.mapsTo ? `${x.code} → ${x.mapsTo}` : x.code)).join(", ")}
              </p>
              <code className="small" title={c.digest}>
                {short(c.digest)}
              </code>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function PropertyRow({
  property: p,
  lang,
  sector,
  chain,
}: {
  property: ResolvedProperty;
  lang: "en" | "de";
  sector: string;
  chain: Chain | null;
}) {
  const provision =
    p.legal.requirement && chain
      ? chain.provisions.find((pr) => pr.dataRequirement === p.legal.requirement && pr.legislation === p.legal.legislation)
      : undefined;
  const act = p.legal.legislation && chain ? chain.legislationById[p.legal.legislation] : undefined;
  const requirement = chain?.dataRequirements.find((r) => r.id === p.legal.requirement);

  return (
    <li className="profile-item" data-testid="profile-property" data-id={p.id}>
      <details>
        <summary>
          <span className="profile-id">{p.id}</span>
          <span className="profile-label" lang={lang}>
            {labelFor(p, lang, sector || undefined)}
          </span>
          <span className="profile-unit">{p.unit ?? "—"}</span>
          <span className="profile-routes" aria-label="Required by">
            {ROUTES.map((r) => (
              <span key={r} className="profile-route" data-on={p.requiredBy[r]} title={`${ROUTE_NAMES[r]}: ${p.requiredBy[r] ? "required" : "not required"}`}>
                {ROUTE_NAMES[r].split(" ")[0]}
              </span>
            ))}
          </span>
          <span className="profile-status" data-status={p.legal.status} data-testid="source-status">
            {STATUS_TEXT[p.legal.status] ?? p.legal.status}
          </span>
        </summary>
        <dl className="profile-detail">
          <dt>Definition</dt>
          <dd>
            {p.definition} <code className="small">{p.definitionRef}</code>
          </dd>
          <dt>Labels</dt>
          <dd>
            <span lang="en">en: {p.labels.en}</span>; <span lang="de">de: {p.labels.de}</span>
            {p.contextLabels.map((l) => (
              <span key={`${l.lang}-${l.context}`} className="profile-context">
                {" "}
                · <span lang={l.lang}>{l.text}</span> (language {l.lang}, sector {l.context})
              </span>
            ))}
          </dd>
          <dt>Unit</dt>
          <dd>{p.unit ? `${p.unit} (${p.unitName ?? "unnamed unit"})` : "No unit applies"}</dd>
          <dt>Required by</dt>
          <dd>{ROUTES.filter((r) => p.requiredBy[r]).map((r) => ROUTE_NAMES[r]).join(", ") || "No route"}</dd>
          {p.members.length > 0 && (
            <>
              <dt>Nested members</dt>
              <dd>
                <ul className="profile-members">
                  {p.members.map((m) => (
                    <li key={m.id}>
                      <code>{m.id}</code>: {m.definition}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          <dt>Source status</dt>
          <dd>
            {p.legal.statusText}
            {act && provision && (
              <>
                {" "}
                Illustrative requirement: {requirement?.name ?? p.legal.requirement} in{" "}
                <a href={provisionUrl(provision, act)} target="_blank" rel="noreferrer">
                  {act.short} {provision.ref}
                </a>
                {provision.quotes?.length ? " (quoted text checked against the Official Journal)" : ""}.
              </>
            )}
            {p.legal.requirement && !chain && ` Illustrative requirement: ${p.legal.requirement} in ${p.legal.legislation}.`}
          </dd>
        </dl>
      </details>
    </li>
  );
}
