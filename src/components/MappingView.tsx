import { useEffect, useMemo, useState } from "react";
import {
  Button,
  DropZone,
  FileTrigger,
  TextArea,
  TextField,
  Link,
  ListBox,
  ListBoxItem,
  isFileDropItem,
  useDragAndDrop,
  type Key,
} from "react-aria-components";
import { extractFields, type DataField } from "../model/dataFields";
import { download } from "../model/project";
import { SAMPLE_DATA, SAMPLE_FILENAME, sampleFile } from "../model/sampleData";
import {
  deleteSpec,
  loadMapping,
  loadSpecs,
  parseSpec,
  saveSpec,
  saveMapping,
  type FieldMapping,
  type Spec,
  type SpecRequirement,
} from "../model/spec";
import { useMediaQuery } from "../useMediaQuery";

/** File kinds a user can bring their product data in (same as the Validation tab). */
const UPLOAD_KINDS = ["CSV", "Excel", "JSON", "JSON-LD", "XML", "RDF"];
const ACCEPT = [".csv", ".xlsx", ".json", ".jsonld", ".json-ld", ".xml", ".rdf"];
const FIELD_TYPE = "application/x-dpp-field";

interface LoadedFile {
  id: string;
  name: string;
  fields: DataField[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const groupByTheme = (requirements: SpecRequirement[]) => {
  const themes: Array<{ theme: string; items: SpecRequirement[] }> = [];
  for (const r of requirements) {
    const section = themes.find((t) => t.theme === r.theme);
    if (section) section.items.push(r);
    else themes.push({ theme: r.theme, items: [r] });
  }
  return themes;
};

/**
 * Map the fields of the user's own data onto the entries of a saved data
 * requirements specification: the specification is picked on the left, the fields
 * found in the uploaded files come next, and a field is dragged onto the entry it
 * answers. The sources saved with the specification are shown beside each entry.
 */
export function MappingView() {
  const wide = useMediaQuery("(min-width: 768px)");
  const [specs, setSpecs] = useState<Spec[]>(loadSpecs);
  const [specId, setSpecId] = useState<string | null>(() => loadSpecs()[0]?.id ?? null);
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<FieldMapping>({});
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [specError, setSpecError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<Key>>(new Set());

  const spec = specs.find((s) => s.id === specId) ?? null;

  // The mapping belongs to the specification; load it when another is chosen.
  useEffect(() => {
    setMapping(spec ? loadMapping(spec.id) : {});
    setPicked(new Set());
  }, [spec?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateMapping = (next: FieldMapping) => {
    setMapping(next);
    if (spec) saveMapping(spec.id, next);
  };

  const fields = useMemo(() => {
    const seen = new Set<string>();
    return files.flatMap((f) => f.fields.map((field) => ({ ...field, file: f.name }))).filter((field) => {
      if (seen.has(field.path)) return false;
      seen.add(field.path);
      return true;
    });
  }, [files]);

  const requirementById = useMemo(() => new Map((spec?.dataRequirements ?? []).map((r) => [r.id, r])), [spec]);
  const fieldsByRequirement = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const [path, id] of Object.entries(mapping)) {
      if (!requirementById.has(id) || !fields.some((f) => f.path === path)) continue;
      out.set(id, [...(out.get(id) ?? []), path]);
    }
    return out;
  }, [mapping, requirementById, fields]);

  const mappedCount = [...fieldsByRequirement.values()].reduce((n, p) => n + p.length, 0);
  const coveredCount = fieldsByRequirement.size;

  const addFiles = async (incoming: File[]) => {
    const loaded: LoadedFile[] = [];
    const problems: string[] = [];
    for (const file of incoming) {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (!ACCEPT.includes(`.${ext}`)) {
        problems.push(`Not supported: ${file.name}. Use ${UPLOAD_KINDS.join(", ")}.`);
        continue;
      }
      try {
        const found = await extractFields(file);
        if (found.length === 0) problems.push(`${file.name}: no fields found.`);
        else loaded.push({ id: `${file.name}-${file.size}-${file.lastModified}`, name: file.name, fields: found });
      } catch (e) {
        problems.push(e instanceof Error ? e.message : `${file.name} can't be read.`);
      }
    }
    if (loaded.length) setFiles((all) => [...all.filter((f) => !loaded.some((l) => l.id === f.id)), ...loaded]);
    setError(problems.length ? problems.join(" ") : null);
  };

  const removeFile = (id: string) => {
    const gone = files.find((f) => f.id === id);
    const rest = files.filter((f) => f.id !== id);
    setFiles(rest);
    if (!gone) return;
    // Mappings stay for fields another file still has.
    const kept = new Set(rest.flatMap((f) => f.fields.map((x) => x.path)));
    updateMapping(Object.fromEntries(Object.entries(mapping).filter(([path]) => kept.has(path))));
  };

  const mapFields = (paths: string[], requirementId: string) => {
    const known = new Set(fields.map((f) => f.path));
    const valid = paths.filter((p) => known.has(p));
    if (valid.length === 0) return;
    updateMapping({ ...mapping, ...Object.fromEntries(valid.map((p) => [p, requirementId])) });
    setPicked(new Set());
  };

  const unmap = (path: string) => {
    const { [path]: _gone, ...rest } = mapping;
    updateMapping(rest);
  };

  const { dragAndDropHooks: sourceHooks } = useDragAndDrop({
    getItems: (keys) => {
      // Dragging a field that is part of the selection takes the whole selection.
      const paths = keys.size === 1 && !picked.has([...keys][0]) ? [...keys] : [...new Set([...picked, ...keys])];
      return paths.map((k) => ({ [FIELD_TYPE]: String(k), "text/plain": String(k) }));
    },
    renderDragPreview: (items) => (
      <div className="drag-chip">
        {items.length === 1 ? items[0]["text/plain"] : `${items.length} fields`}
      </div>
    ),
  });

  const { dragAndDropHooks: targetHooks } = useDragAndDrop({
    acceptedDragTypes: [FIELD_TYPE],
    getDropOperation: () => "copy",
    shouldAcceptItemDrop: (target) => target.type === "item",
    onItemDrop: async (e) => {
      const paths = await Promise.all(e.items.filter((i) => i.kind === "text").map((i) => i.getText(FIELD_TYPE)));
      mapFields(paths, String(e.target.key));
    },
  });

  const chooseSpec = (id: string) => setSpecId(id);

  /** Adds a specification from YAML text; it is saved here like an exported one and chosen. */
  const importSpec = (text: string, origin: string) => {
    const result = parseSpec(text);
    if (!result.ok) {
      setSpecError(`${origin}: ${result.error}`);
      return false;
    }
    setSpecs(saveSpec(result.spec));
    setSpecId(result.spec.id);
    setSpecError(null);
    return true;
  };

  const importSpecFile = async (list: FileList | null) => {
    const file = list?.[0];
    if (file) importSpec(await file.text(), file.name);
  };

  const removeSpec = (id: string) => {
    const next = deleteSpec(id);
    setSpecs(next);
    if (specId === id) setSpecId(next[0]?.id ?? null);
  };

  const sections = spec ? groupByTheme(spec.dataRequirements) : [];

  return (
    <div className={wide ? "app wide" : "app narrow"}>
      <header className="topbar">
        <div className="brand">
          <h1>DPP mapping</h1>
        </div>
        <div className="brand">
          <span className="stat">
            <strong>{fields.length}</strong> data field{fields.length === 1 ? "" : "s"}
          </span>
          <span className="stat">
            <strong>{mappedCount}</strong> mapped
          </span>
          <span className="stat" title="Specification entries with at least one field mapped">
            <strong>{coveredCount}</strong> of {spec?.dataRequirements.length ?? 0} entries covered
          </span>
        </div>
      </header>

      <p className="hint">
        {specs.length === 0
          ? "Export a specification from the Requirements tab first; it is saved here to map against."
          : !spec
            ? "Choose a saved specification to map your data to."
            : fields.length === 0
              ? "Add your data, then drag its fields onto the entries they answer."
              : "Drag a field onto an entry of the specification. Select several fields to drag them together."}
      </p>

      <main className="req-board map-board">
        <section className="panel" aria-labelledby="m-spec-title">
          <header className="panel-head">
            <div>
              <h2 id="m-spec-title">Specification</h2>
              <p>{specs.length ? plural(specs.length, "saved specification") : "None saved yet"}</p>
            </div>
          </header>
          <div className="list">
            <div className="spec-import">
              <FileTrigger acceptedFileTypes={[".yaml", ".yml"]} onSelect={importSpecFile}>
                <Button className="ghost">Upload YAML</Button>
              </FileTrigger>
              <Button className="ghost" aria-expanded={pasting} onPress={() => setPasting((v) => !v)}>
                Paste YAML
              </Button>
            </div>
            {pasting && (
              <div className="spec-paste">
                <TextField aria-label="Specification YAML" value={pasted} onChange={setPasted}>
                  <TextArea className="spec-textarea" rows={8} placeholder={"name: Aluminum · ESPR\ndataRequirements:\n  - id: product-id\n    name: Unique product identifier"} spellCheck={false} />
                </TextField>
                <Button
                  className="primary"
                  isDisabled={!pasted.trim()}
                  onPress={() => {
                    if (importSpec(pasted, "Pasted YAML")) {
                      setPasted("");
                      setPasting(false);
                    }
                  }}
                >
                  Load specification
                </Button>
              </div>
            )}
            {specError && (
              <p className="upload-error" role="alert">
                {specError}
              </p>
            )}
            {specs.length === 0 && (
              <p className="empty">
                Upload or paste a specification YAML above, or export one from the Requirements tab: pick a product
                group and legislations, then choose Export.
              </p>
            )}
            <ul className="spec-list">
              {specs.map((s) => (
                <li key={s.id}>
                  <Button
                    className={s.id === specId ? "spec-option selected" : "spec-option"}
                    aria-pressed={s.id === specId}
                    onPress={() => chooseSpec(s.id)}
                  >
                    <span className="group-name">{s.name}</span>
                    <span className="group-desc">
                      {plural(s.dataRequirements.length, "data requirement")} ·{" "}
                      {plural(s.legislations.length, "legislation")}
                    </span>
                    <span className="group-count">Saved {new Date(s.savedAt).toLocaleString()}</span>
                  </Button>
                  <Button className="ghost icon" aria-label={`Delete ${s.name}`} onPress={() => removeSpec(s.id)}>
                    ×
                  </Button>
                </li>
              ))}
            </ul>
            {spec && (
              <div className="dp-section" role="group" aria-label="Legislations in this specification">
                <div className="section-head">Legislations</div>
                <ul className="val-list map-laws">
                  {spec.legislations.map((l) => (
                    <li key={l.id}>
                      <span className="law-chip strong">{l.short}</span>
                      <Link className="req-ref" href={l.url} target="_blank" rel="noreferrer">
                        {l.ref}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="m-data-title">
          <header className="panel-head">
            <div>
              <h2 id="m-data-title">Your data</h2>
              <p>{fields.length ? `${plural(fields.length, "field")} from ${plural(files.length, "file")}` : "Upload the data to map"}</p>
            </div>
          </header>
          <div className="list">
            <DropZone
              className="upload-zone"
              onDrop={async (e) => {
                const dropped = await Promise.all(e.items.filter(isFileDropItem).map((item) => item.getFile()));
                await addFiles(dropped);
              }}
            >
              <FileTrigger acceptedFileTypes={ACCEPT} allowsMultiple onSelect={(list) => addFiles(list ? [...list] : [])}>
                <Button className="upload-add" aria-label="Add data files">
                  <span aria-hidden="true">+</span>
                </Button>
              </FileTrigger>
              <span className="upload-text">
                Add or drop your data
                <small>{UPLOAD_KINDS.join(" · ")}</small>
              </span>
            </DropZone>
            <div className="map-sample">
              <Button className="ghost" onPress={() => addFiles([sampleFile()])}>
                Use aluminium example
              </Button>
              <Button
                className="ghost"
                onPress={() =>
                  download(new Blob([JSON.stringify(SAMPLE_DATA, null, 2)], { type: "application/json" }), SAMPLE_FILENAME)
                }
              >
                Download it
              </Button>
            </div>
            {error && (
              <p className="upload-error" role="alert">
                {error}
              </p>
            )}
            {files.length > 0 && (
              <ul className="upload-list">
                {files.map((f) => (
                  <li key={f.id}>
                    <span className="upload-name">{f.name}</span>
                    <span className="muted small">{plural(f.fields.length, "field")}</span>
                    <Button className="ghost icon" aria-label={`Remove ${f.name}`} onPress={() => removeFile(f.id)}>
                      ×
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {fields.length > 0 && (
              <ListBox
                aria-label="Fields in your data"
                className="field-list"
                selectionMode="multiple"
                selectedKeys={picked}
                onSelectionChange={(keys) => setPicked(keys === "all" ? new Set(fields.map((f) => f.path)) : keys)}
                dragAndDropHooks={sourceHooks}
                dependencies={[mapping]}
              >
                {fields.map((f) => {
                  const target = requirementById.get(mapping[f.path]);
                  return (
                    <ListBoxItem key={f.path} id={f.path} textValue={f.path} className="field-item">
                      <Button slot="drag" className="drag-handle" aria-label={`Drag ${f.path}`}>
                        ⋮⋮
                      </Button>
                      <span className="field-text">
                        <code className="field-path">{f.path}</code>
                        {f.sample !== undefined && <span className="field-sample">{f.sample}</span>}
                      </span>
                      {target && <span className="field-target">→ {target.name}</span>}
                    </ListBoxItem>
                  );
                })}
              </ListBox>
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="m-target-title">
          <header className="panel-head">
            <div>
              <h2 id="m-target-title">Data requirements</h2>
              <p>{spec ? `${spec.name} · ${`${spec.dataRequirements.length} ${spec.dataRequirements.length === 1 ? "entry" : "entries"}`}` : "Choose a specification"}</p>
            </div>
          </header>
          <div className="list">
            {spec ? (
              sections.map(({ theme, items }) => (
                <div key={theme} className="dp-section" role="group" aria-label={theme}>
                  <div className="section-head">{theme}</div>
                  <ListBox
                    aria-label={theme}
                    className="target-list"
                    dragAndDropHooks={targetHooks}
                    dependencies={[mapping, fields]}
                  >
                    {items.map((r) => {
                    const mapped = fieldsByRequirement.get(r.id) ?? [];
                    return (
                      <ListBoxItem
                        key={r.id}
                        id={r.id}
                        textValue={r.name}
                        className={mapped.length ? "target-item mapped" : "target-item"}
                      >
                        <span className="schema-name">{r.name}</span>
                        <code className="schema-key">{r.id}</code>
                        <span className="dp-laws" aria-label="Sources">
                          {r.sources.map((s) => (
                            <span key={`${s.legislation}-${s.provision}`} className="law-chip" title={`${s.act}, ${s.provision}`}>
                              {s.legislation} · {s.provision}
                            </span>
                          ))}
                        </span>
                        {r.standards.length > 0 && (
                          <span className="leg-ref">Standards: {r.standards.join(", ")}</span>
                        )}
                        {mapped.length > 0 && (
                          <ul className="mapped-fields">
                            {mapped.map((path) => (
                              <li key={path}>
                                <code>{path}</code>
                                <Button className="ghost icon" aria-label={`Unmap ${path}`} onPress={() => unmap(path)}>
                                  ×
                                </Button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </ListBoxItem>
                    );
                  })}
                  </ListBox>
                </div>
              ))
            ) : (
              <p className="empty">Saved specifications list their data requirements here, with the sources they come from.</p>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
