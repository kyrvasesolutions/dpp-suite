import { useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { SAMPLE_DATA, SAMPLE_FILENAME } from "../model/sampleData";

const TEXT = JSON.stringify(SAMPLE_DATA, null, 2);

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API blocked (e.g. insecure origin): fall back to a hidden textarea.
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/**
 * Collapsible bar on the left edge. Its symbol opens the synthetic aluminium
 * product data as raw JSON, with a button to copy all of it.
 */
export function SamplesSidebar() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <aside className={open ? "samples open" : "samples"} aria-label="Example data">
      <Button
        className="samples-toggle"
        aria-expanded={open}
        aria-controls="samples-panel"
        aria-label={open ? "Hide example data" : "Show example data"}
        onPress={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M9 4C7 4 6 5 6 7v2c0 1.5-.8 3-2 3 1.200 0 2 1.500 2 3v2c0 2 1 3 3 3M15 4c2 0 3 1 3 3v2c0 1.500.8 3 2 3-1.200 0-2 1.500-2 3v2c0 2-1 3-3 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Button>
      {open && (
        <section id="samples-panel" className="samples-panel" aria-labelledby="samples-title">
          <header className="samples-head">
            <div>
              <h2 id="samples-title">Example data</h2>
              <p>{SAMPLE_FILENAME} · synthetic aluminium product</p>
            </div>
            <Button
              className="primary"
              onPress={async () => {
                await copyText(TEXT);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy whole text"}
            </Button>
          </header>
          <pre className="samples-code" tabIndex={0} aria-label="Raw JSON">
            <code>{TEXT}</code>
          </pre>
          <span className="sr-only" role="status">
            {copied ? "Copied to clipboard" : ""}
          </span>
        </section>
      )}
    </aside>
  );
}
