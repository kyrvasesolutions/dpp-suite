import { useMemo, useState } from "react";
import {
  Button,
  DropZone,
  FileTrigger,
  Header,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  ToggleButton,
  ToggleButtonGroup,
  isFileDropItem,
  type Key,
} from "react-aria-components";
import {
  CATEGORIES,
  DATA_POINTS,
  LEGISLATIONS,
  PRODUCT_GROUPS,
  THEMES,
  appliesTo,
  legislationById,
  legislationCount,
  requirementsByDataPoint,
  type ProductGroup,
  type Requirement,
} from "../model/legislation";
import { useMediaQuery } from "../useMediaQuery";

/** File kinds a user can bring their product data in. */
const UPLOAD_KINDS = [
  { ext: "csv", label: "CSV" },
  { ext: "xlsx", label: "Excel" },
  { ext: "json", label: "JSON" },
  { ext: "jsonld", label: "JSON-LD" },
  { ext: "xml", label: "XML" },
  { ext: "rdf", label: "RDF" },
] as const;

/** "json-ld" is how people write it; the file extension is .jsonld. Both are accepted. */
const EXTENSIONS: string[] = [...UPLOAD_KINDS.map((k) => k.ext), "json-ld"];
const ACCEPT = EXTENSIONS.map((e) => `.${e}`);

interface UploadedFile {
  id: string;
  file: File;
  kind: string;
}

const kindOf = (name: string): string | null => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (!EXTENSIONS.includes(ext)) return null;
  const canonical = ext === "json-ld" ? "jsonld" : ext;
  return UPLOAD_KINDS.find((k) => k.ext === canonical)?.label ?? null;
};

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const NO_REQUIREMENTS: Requirement[] = [];

/**
 * Pick a product group and the legislations to validate against; the data
 * points they require form the data schema. The user's own data is added
 * below the schema with the "+" tile.
 */
export function ValidationView() {
  const wide = useMediaQuery("(min-width: 768px)");
  const [group, setGroup] = useState<ProductGroup | null>(null);
  const [selected, setSelected] = useState<Set<Key>>(new Set());
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const selectedIds = useMemo(() => new Set([...selected].map(String)), [selected]);
  const disabled = useMemo(
    () => LEGISLATIONS.filter((l) => !group || !appliesTo(l, group)).map((l) => l.id),
    [group],
  );
  const required = useMemo(
    () => (group ? requirementsByDataPoint(group, selectedIds) : new Map<string, Requirement[]>()),
    [group, selectedIds],
  );

  const activeLaws = LEGISLATIONS.filter((l) => selectedIds.has(l.id));
  const standards = [...new Map(activeLaws.flatMap((l) => l.standards ?? []).map((st) => [st.ref, st])).values()];

  const groupName = PRODUCT_GROUPS.find((g) => g.id === group)?.name;

  const chooseGroup = (next: ProductGroup | null) => {
    setGroup(next);
    setSelected((s) => new Set([...s].filter((id) => next && appliesTo(legislationById[String(id)], next))));
  };

  const addFiles = (incoming: File[]) => {
    const accepted: UploadedFile[] = [];
    const rejected: string[] = [];
    for (const file of incoming) {
      const kind = kindOf(file.name);
      if (kind) accepted.push({ id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file, kind });
      else rejected.push(file.name);
    }
    if (accepted.length) setFiles((f) => [...f, ...accepted]);
    setError(
      rejected.length
        ? `Not supported: ${rejected.join(", ")}. Use ${UPLOAD_KINDS.map((k) => k.label).join(", ")}.`
        : null,
    );
  };

  const rows = THEMES.map((theme) => ({
    theme,
    fields: DATA_POINTS.filter((d) => d.theme === theme.id && required.has(d.id)).map((d) => ({
      point: d,
      reqs: required.get(d.id) ?? NO_REQUIREMENTS,
    })),
  })).filter((section) => section.fields.length > 0);

  return (
    <div className={wide ? "app wide" : "app narrow"}>
      <header className="topbar">
        <div className="brand">
          <h1>DPP validation</h1>
        </div>
        <div className="brand">
          <span className="stat">
            <strong>{selectedIds.size}</strong> legislation{selectedIds.size === 1 ? "" : "s"}
          </span>
          <span className="stat">
            <strong>{required.size}</strong> schema fields
          </span>
          <span className="stat">
            <strong>{files.length}</strong> file{files.length === 1 ? "" : "s"}
          </span>
        </div>
      </header>

      <p className="hint">
        {!group
          ? "Choose a product group, then the legislations to validate against."
          : selectedIds.size === 0
            ? `Select one or more legislations for ${groupName}; their data requirements become your data schema.`
            : "Add your data with + to check it against this schema."}
      </p>

      <main className="req-board val-board">
        <section className="panel req-groups" aria-labelledby="v-group-title">
          <header className="panel-head">
            <div>
              <h2 id="v-group-title">Product Group</h2>
              <p>Industry to check</p>
            </div>
          </header>
          <div className="list">
            <ToggleButtonGroup
              aria-labelledby="v-group-title"
              className="group-options"
              orientation="vertical"
              selectionMode="single"
              selectedKeys={group ? [group] : []}
              onSelectionChange={(keys) => chooseGroup(([...keys][0] as ProductGroup | undefined) ?? null)}
            >
              {PRODUCT_GROUPS.map((g) => (
                <ToggleButton key={g.id} id={g.id} className="group-option">
                  <span className="group-name">{g.name}</span>
                  <span className="group-desc">{g.description}</span>
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </div>
        </section>

        <section className="panel req-legislation" aria-labelledby="v-legislation-title">
          <header className="panel-head">
            <div>
              <h2 id="v-legislation-title">Legislation</h2>
              <p>
                {group
                  ? `${LEGISLATIONS.length - disabled.length} of ${LEGISLATIONS.length} apply to ${groupName}`
                  : "Pick a product group first"}
              </p>
            </div>
            {selectedIds.size > 0 && (
              <div className="panel-tools">
                <Button className="ghost" onPress={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            )}
          </header>
          <div className="list">
            <ListBox
              aria-labelledby="v-legislation-title"
              className="leg-list"
              selectionMode="multiple"
              selectedKeys={selected}
              onSelectionChange={(keys) =>
                setSelected(
                  keys === "all" ? new Set(LEGISLATIONS.map((l) => l.id).filter((id) => !disabled.includes(id))) : keys,
                )
              }
              disabledKeys={disabled}
              dependencies={[group]}
            >
              {CATEGORIES.map((c) => (
                <ListBoxSection key={c.id} id={c.id} className="leg-section">
                  <Header className="section-head">{c.name}</Header>
                  {LEGISLATIONS.filter((l) => l.category === c.id).map((l) => (
                    <ListBoxItem
                      key={l.id}
                      id={l.id}
                      textValue={`${l.short} ${l.title}`}
                      className={group && appliesTo(l, group) ? "leg-item relevant" : "leg-item"}
                    >
                      {({ isSelected }) => (
                        <>
                          <span className="leg-check" aria-hidden="true">
                            {isSelected && (
                              <svg viewBox="0 0 16 16" width="12" height="12">
                                <path
                                  d="M3.5 8.5l3 3 6-7"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </span>
                          <span className="leg-text">
                            <span className="leg-name">
                              <strong>{l.short}</strong> {l.title}
                            </span>
                            <span className="leg-ref">{l.ref}</span>
                          </span>
                        </>
                      )}
                    </ListBoxItem>
                  ))}
                </ListBoxSection>
              ))}
            </ListBox>
          </div>
        </section>

        <section className="panel req-data" aria-labelledby="v-schema-title">
          <header className="panel-head">
            <div>
              <h2 id="v-schema-title">Data schema</h2>
              <p>
                {required.size
                  ? `${required.size} fields from ${selectedIds.size} legislation${selectedIds.size === 1 ? "" : "s"}`
                  : "Fields appear once you select legislations"}
              </p>
            </div>
          </header>
          <div className="list">
            {rows.map(({ theme, fields }) => (
              <div key={theme.id} className="dp-section" role="group" aria-label={theme.name}>
                <div className="section-head">{theme.name}</div>
                <ul className="schema-fields">
                  {fields.map(({ point, reqs }) => (
                    <li key={point.id} className="schema-field">
                      <span className="schema-name">{point.name}</span>
                      <code className="schema-key">{point.id}</code>
                      <span className="dp-laws" aria-label="Required by">
                        {[...new Set(reqs.map((r) => r.legislation))].map((id) => (
                          <span key={id} className="law-chip">
                            {legislationById[id].short}
                          </span>
                        ))}
                      </span>
                      {legislationCount(reqs) > 1 && <span className="schema-shared">shared</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section className="panel val-data" aria-labelledby="v-data-title">
          <header className="panel-head">
            <div>
              <h2 id="v-data-title">Your data</h2>
              <p>Upload the data to validate</p>
            </div>
          </header>
          <div className="list">
            <DropZone
              className="upload-zone"
              onDrop={async (e) => {
                const dropped = await Promise.all(
                  e.items.filter(isFileDropItem).map((item) => item.getFile()),
                );
                addFiles(dropped);
              }}
            >
              <FileTrigger acceptedFileTypes={ACCEPT} allowsMultiple onSelect={(list) => addFiles(list ? [...list] : [])}>
                <Button className="upload-add" aria-label="Add data files">
                  <span aria-hidden="true">+</span>
                </Button>
              </FileTrigger>
              <span className="upload-text">
                Add or drop your data
                <small>{UPLOAD_KINDS.map((k) => k.label).join(" · ")}</small>
              </span>
            </DropZone>
            {error && (
              <p className="upload-error" role="alert">
                {error}
              </p>
            )}
            {files.length > 0 && (
              <ul className="upload-list">
                {files.map((f) => (
                  <li key={f.id}>
                    <span className="law-chip strong">{f.kind}</span>
                    <span className="upload-name">{f.file.name}</span>
                    <span className="muted small">{formatSize(f.file.size)}</span>
                    <Button
                      className="ghost icon"
                      aria-label={`Remove ${f.file.name}`}
                      onPress={() => setFiles((all) => all.filter((x) => x.id !== f.id))}
                    >
                      ×
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="dp-section" role="group" aria-label="Validation scope">
              <div className="section-head">Validation scope</div>
              <dl className="val-stats">
                <div>
                  <dt>Required data points</dt>
                  <dd className="val-big">{required.size}</dd>
                </div>
                <div>
                  <dt>Active legislations</dt>
                  <dd>
                    {activeLaws.length ? (
                      <ul className="val-list">
                        {activeLaws.map((l) => (
                          <li key={l.id}>
                            <span className="law-chip strong">{l.short}</span>
                            <span className="val-ref">{l.ref}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="muted">None selected</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Standards</dt>
                  <dd>
                    {standards.length ? (
                      <ul className="val-list">
                        {standards.map((st) => (
                          <li key={st.ref}>
                            <span className="law-chip strong">{st.ref}</span>
                            <span className="val-ref">{st.title}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="muted">None recorded for the selected legislations</span>
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
