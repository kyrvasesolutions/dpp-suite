import { useState } from "react";
import { Button, FileTrigger, TextArea, TextField } from "react-aria-components";
import { deleteSpec, parseSpec, saveSpec, type Spec } from "../model/spec";

interface SpecLibraryProps {
  specs: Spec[];
  selectedId: string | null;
  onSpecsChange: (specs: Spec[]) => void;
  onSelect: (id: string | null) => void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Uploading or pasting a specification YAML, and choosing among those saved in this browser. */
export function SpecLibrary({ specs, selectedId, onSpecsChange, onSelect }: SpecLibraryProps) {
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);

  /** Adds a specification from YAML text; it is saved here like an exported one and chosen. */
  const importSpec = (text: string, origin: string) => {
    const result = parseSpec(text);
    if (!result.ok) {
      setError(`${origin}: ${result.error}`);
      return false;
    }
    onSpecsChange(saveSpec(result.spec));
    onSelect(result.spec.id);
    setError(null);
    return true;
  };

  const importFile = async (list: FileList | null) => {
    const file = list?.[0];
    if (file) importSpec(await file.text(), file.name);
  };

  const remove = (id: string) => {
    const next = deleteSpec(id);
    onSpecsChange(next);
    if (selectedId === id) onSelect(next[0]?.id ?? null);
  };

  return (
    <>
      <div className="spec-import">
        <FileTrigger acceptedFileTypes={[".yaml", ".yml"]} onSelect={importFile}>
          <Button className="ghost">Upload YAML</Button>
        </FileTrigger>
        <Button className="ghost" aria-expanded={pasting} onPress={() => setPasting((v) => !v)}>
          Paste YAML
        </Button>
      </div>
      {pasting && (
        <div className="spec-paste">
          <TextField aria-label="Specification YAML" value={pasted} onChange={setPasted}>
            <TextArea
              className="spec-textarea"
              rows={8}
              placeholder={"name: Aluminum · ESPR\ndataRequirements:\n  - id: product-id\n    name: Unique product identifier"}
              spellCheck={false}
            />
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
      {error && (
        <p className="upload-error" role="alert">
          {error}
        </p>
      )}
      {specs.length === 0 && (
        <p className="empty">
          Upload or paste a specification YAML above, or export one from the Requirements tab: pick a product group and
          compliance targets, then choose Export.
        </p>
      )}
      <ul className="spec-list">
        {specs.map((s) => (
          <li key={s.id}>
            <Button
              className={s.id === selectedId ? "spec-option selected" : "spec-option"}
              aria-pressed={s.id === selectedId}
              onPress={() => onSelect(s.id)}
            >
              <span className="group-name">{s.name}</span>
              <span className="group-desc">
                {plural(s.dataRequirements.length, "data requirement")} · {plural(s.legislations.length, "target")}
              </span>
              <span className="group-count">Saved {new Date(s.savedAt).toLocaleString()}</span>
            </Button>
            <Button className="ghost icon" aria-label={`Delete ${s.name}`} onPress={() => remove(s.id)}>
              ×
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}
