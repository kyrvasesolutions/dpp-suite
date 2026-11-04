import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  ToggleButton,
  ToggleButtonGroup,
  type Key,
} from "react-aria-components";
import type { Database } from "sql.js";
import { ClaudeSettings } from "./components/ClaudeSettings";
import { ConnectorLayer } from "./components/ConnectorLayer";
import { HoverPreview } from "./components/HoverPreview";
import { ImportDialog } from "./components/ImportDialog";
import { ItemWindow, WINDOW_WIDTH, type WindowState } from "./components/ItemWindow";
import { MappingView } from "./components/MappingView";
import { RequirementsExplorer } from "./components/RequirementsExplorer";
import { SamplesSidebar } from "./components/SamplesSidebar";
import { TraceTree } from "./components/TraceTree";
import { ValidationView } from "./components/ValidationView";
import { loadApiKey, saveApiKey } from "./llm/apiKey";
import { LlmError, suggestMappings } from "./llm/suggest";
import { loadChain, persist, readProject, resetDatabase, writeProject } from "./db/database";
import type { Chain } from "./model/chain";
import { download, exportProject, type Project } from "./model/project";
import {
  ancestorsOf,
  buildParentMap,
  endOn,
  folderIds,
  isSelfOrDescendant,
  leafIds,
  linkCounts,
  nestedItems,
} from "./model/tree";
import { anchorId, otherSide, type Mapping, type NodeRef, type Side, type Suggestion } from "./model/types";
import { useInstallPrompt } from "./useInstallPrompt";
import { useMediaQuery } from "./useMediaQuery";

const SIDES: Side[] = ["left", "right"];
const HOVER_DELAY = 450;
const CLOSE_ANIMATION = 160;
const MAX_WINDOWS = 4;

type PerSide<T> = Record<Side, T>;

const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const SAVE_DELAY = 300;

interface WorkspaceProps {
  database: Database;
  /** View switcher shown next to the title. */
  nav?: ReactNode;
}

export function Workspace({ database, nav }: WorkspaceProps) {
  const wide = useMediaQuery("(min-width: 768px)");
  const boardRef = useRef<HTMLDivElement>(null);
  const installPrompt = useInstallPrompt();
  const dbRef = useRef(database);

  const [project, setProject] = useState<Project>(() => readProject(database));
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [expanded, setExpanded] = useState<PerSide<Set<Key>>>({
    left: new Set(["pack", "module", "cells", "docs"]),
    right: new Set(["espr-b"]),
  });
  const [selected, setSelected] = useState<PerSide<Set<Key>>>({ left: new Set(), right: new Set() });
  const [windows, setWindows] = useState<WindowState[]>([]);
  const [pending, setPending] = useState<NodeRef | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [hover, setHover] = useState<{ ref: NodeRef; el: HTMLElement } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "warn" } | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKey, setApiKey] = useState(loadApiKey);
  const [llm, setLlm] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const hoverTimer = useRef(0);
  const llmAbort = useRef<AbortController | null>(null);
  const zTop = useRef(10);

  const trees = useMemo(() => ({ left: project.left, right: project.right }), [project.left, project.right]);
  const parents = useMemo(
    () => ({ left: buildParentMap(project.left), right: buildParentMap(project.right) }),
    [project.left, project.right],
  );
  const { mappings } = project;

  // Every change is written to SQLite and the file saved in this browser (debounced).
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    const t = setTimeout(() => {
      try {
        writeProject(dbRef.current, project);
        persist(dbRef.current).catch(() => setToast({ text: "Couldn't save to this browser's storage", kind: "warn" }));
      } catch (error) {
        setToast({ text: `Database error: ${error instanceof Error ? error.message : String(error)}`, kind: "warn" });
      }
    }, SAVE_DELAY);
    return () => clearTimeout(t);
  }, [project]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!flashId) return;
    const t = setTimeout(() => setFlashId(null), 1200);
    return () => clearTimeout(t);
  }, [flashId]);

  // ---------- Derived state ----------

  const counts = useMemo(
    () => ({ left: linkCounts(mappings, "left", parents.left), right: linkCounts(mappings, "right", parents.right) }),
    [mappings, parents],
  );

  const selectedIds = useMemo(
    () => ({ left: [...selected.left].map(String), right: [...selected.right].map(String) }),
    [selected],
  );
  const hasSelection = selectedIds.left.length + selectedIds.right.length > 0;

  // Mappings touching anything selected, or inside a selected folder.
  const touchesSelection = useCallback(
    (m: Mapping) =>
      SIDES.some((side) => selectedIds[side].some((id) => isSelfOrDescendant(endOn(m, side), id, parents[side]))),
    [selectedIds, parents],
  );
  const activeMappings = useMemo(() => mappings.filter(touchesSelection), [mappings, touchesSelection]);
  const highlighted = useMemo(() => new Set(activeMappings.map((m) => m.id)), [activeMappings]);

  const relatedSets = useMemo(() => {
    const make = (side: Side) => {
      const related = new Set(activeMappings.map((m) => endOn(m, side)));
      const ancestors = new Set<string>();
      for (const id of related) for (const a of ancestorsOf(id, parents[side], trees[side].rootId)) ancestors.add(a);
      return { related, ancestors };
    };
    return { left: make("left"), right: make("right") };
  }, [activeMappings, parents, trees]);

  const suggestedIds = useMemo(
    () => ({ left: new Set(suggestions.map((s) => s.from)), right: new Set(suggestions.map((s) => s.to)) }),
    [suggestions],
  );

  // Focus mode: show only the selection, what it maps to, and the paths to them.
  const visible = useMemo<PerSide<Set<string>> | null>(() => {
    if (!focusMode || !hasSelection) return null;
    const make = (side: Side) => {
      const keep = new Set<string>(relatedSets[side].related);
      for (const id of selectedIds[side]) {
        keep.add(id);
        for (const n of Object.keys(trees[side].nodes)) if (isSelfOrDescendant(n, id, parents[side])) keep.add(n);
      }
      for (const id of [...keep]) for (const a of ancestorsOf(id, parents[side], trees[side].rootId)) keep.add(a);
      return keep;
    };
    return { left: make("left"), right: make("right") };
  }, [focusMode, hasSelection, relatedSets, selectedIds, trees, parents]);

  const items = useMemo(
    () => ({ left: nestedItems(trees.left, visible?.left), right: nestedItems(trees.right, visible?.right) }),
    [trees, visible],
  );

  // In focus mode, open every folder on the way to a visible item.
  const effectiveExpanded = useMemo<PerSide<Set<Key>>>(() => {
    if (!visible) return expanded;
    const open = (side: Side) =>
      new Set<Key>([...expanded[side], ...[...visible[side]].filter((id) => trees[side].nodes[id]?.children?.length)]);
    return { left: open("left"), right: open("right") };
  }, [visible, expanded, trees]);

  // ---------- Actions ----------

  const nodeName = (ref: NodeRef) => trees[ref.side].nodes[ref.nodeId]?.name ?? ref.nodeId;

  const addMappings = useCallback(
    (pairs: Array<{ from: string; to: string }>) => {
      const existing = new Set(mappings.map((m) => `${m.from}|${m.to}`));
      const fresh = pairs.filter((p) => !existing.has(`${p.from}|${p.to}`));
      if (fresh.length === 0) {
        setToast({ text: pairs.length > 1 ? "All already mapped" : "Already mapped", kind: "warn" });
        return;
      }
      const added = fresh.map((p) => ({ id: newId("m"), ...p }));
      setProject((p) => ({ ...p, mappings: [...p.mappings, ...added] }));
      setSuggestions((ss) => ss.filter((s) => !fresh.some((p) => p.from === s.from && p.to === s.to)));
      setFlashId(added[added.length - 1].id);
      const first = fresh[0];
      setToast({
        text:
          fresh.length === 1
            ? `Mapped ${trees.left.nodes[first.from]?.name} → ${trees.right.nodes[first.to]?.name}`
            : `Added ${fresh.length} mappings${fresh.length < pairs.length ? ` (${pairs.length - fresh.length} already existed)` : ""}`,
        kind: "ok",
      });
    },
    [mappings, trees],
  );

  const mapBetween = (sources: NodeRef[], target: NodeRef) =>
    addMappings(
      sources
        .filter((s) => s.side !== target.side)
        .map((s) => (s.side === "left" ? { from: s.nodeId, to: target.nodeId } : { from: target.nodeId, to: s.nodeId })),
    );

  const removeMapping = (id: string) => setProject((p) => ({ ...p, mappings: p.mappings.filter((m) => m.id !== id) }));

  const openWindow = (ref: NodeRef) => {
    const key = anchorId(ref.side, ref.nodeId);
    const z = ++zTop.current;
    setWindows((ws) => {
      const existing = ws.find((w) => w.key === key);
      if (existing) return ws.map((w) => (w.key === key ? { ...w, z, closing: false } : w));
      // Open just below the row, inside its own panel, so the other list and the lines stay visible.
      const row = document.querySelector(`[data-anchor="${CSS.escape(key)}"]`)?.getBoundingClientRect();
      const rawX = row ? (ref.side === "left" ? row.right - WINDOW_WIDTH - 12 : row.left + 12) : 80;
      const below = row ? row.bottom + 6 : 120;
      const rawY = row && below + 300 > window.innerHeight ? row.top - 306 : below;
      const x = Math.min(Math.max(rawX, 8), window.innerWidth - WINDOW_WIDTH - 8);
      const y = Math.min(Math.max(rawY, 8), window.innerHeight - 320);
      const kept = ws.filter((w) => !w.closing).slice(-(MAX_WINDOWS - 1));
      return [...kept, { key, ref, x, y, z, closing: false }];
    });
  };

  const closeWindow = (key: string) => {
    setWindows((ws) => ws.map((w) => (w.key === key ? { ...w, closing: true } : w)));
    setTimeout(() => setWindows((ws) => ws.filter((w) => w.key !== key || !w.closing)), CLOSE_ANIMATION);
    if (pending && anchorId(pending.side, pending.nodeId) === key) setPending(null);
  };

  const onSelectionChange = (side: Side, keys: Set<Key>) => {
    const added = [...keys].filter((k) => !selected[side].has(k)).map(String);
    // Tap-to-map: a tap on the other tree completes the pending mapping.
    if (pending && pending.side !== side && added.length > 0) {
      mapBetween([pending], { side, nodeId: added[added.length - 1] });
      setPending(null);
      return;
    }
    setSelected((s) => ({ ...s, [side]: keys }));
    if (added.length > 0) openWindow({ side, nodeId: added[added.length - 1] });
  };

  const reveal = (ref: NodeRef) => {
    const ancestors = ancestorsOf(ref.nodeId, parents[ref.side], trees[ref.side].rootId);
    setExpanded((e) => ({ ...e, [ref.side]: new Set([...e[ref.side], ...ancestors]) }));
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document
          .querySelector(`[data-anchor="${CSS.escape(anchorId(ref.side, ref.nodeId))}"]`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
      ),
    );
  };

  const onHoverStart = (ref: NodeRef, el: HTMLElement) => {
    clearTimeout(hoverTimer.current);
    if (dragging) return;
    hoverTimer.current = window.setTimeout(() => setHover({ ref, el }), HOVER_DELAY);
  };
  const onHoverEnd = () => {
    clearTimeout(hoverTimer.current);
    setHover(null);
  };

  const askClaude = async () => {
    if (!apiKey.key) {
      setSettingsOpen(true);
      return;
    }
    llmAbort.current?.abort();
    const controller = new AbortController();
    llmAbort.current = controller;
    setLlm({ busy: true, error: null });
    try {
      const result = await suggestMappings(apiKey.key, project, controller.signal);
      setSuggestions(result);
      setLlm({ busy: false, error: null });
      setToast({
        text: result.length ? `Claude suggested ${result.length} mappings` : "Claude found no new mappings",
        kind: "ok",
      });
    } catch (error) {
      const message = error instanceof LlmError ? error.message : "Something went wrong asking Claude.";
      setLlm({ busy: false, error: controller.signal.aborted ? null : message });
    }
  };

  const acceptSuggestion = (s: Suggestion) => addMappings([{ from: s.from, to: s.to }]);
  const rejectSuggestion = (id: string) => setSuggestions((ss) => ss.filter((s) => s.id !== id));

  const resetAll = async () => {
    dbRef.current = await resetDatabase();
    setProject(readProject(dbRef.current));
    setSuggestions([]);
    setSelected({ left: new Set(), right: new Set() });
    setWindows([]);
    setPending(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && pending) setPending(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  // ---------- Render ----------

  const requirementLeaves = leafIds(trees.right);
  const covered = requirementLeaves.filter((id) => counts.right.direct[id]).length;
  const coverage = requirementLeaves.length ? Math.round((covered / requirementLeaves.length) * 100) : 0;

  // Phones show one window as a bottom sheet, hidden while picking a "Map to…" target underneath it.
  const visibleWindows = wide ? windows : pending ? [] : windows.slice(-1);

  const treeProps = (side: Side) => ({
    side,
    data: trees[side],
    items: items[side],
    expanded: effectiveExpanded[side],
    onExpandedChange: (keys: Set<Key>) => setExpanded((e) => ({ ...e, [side]: keys })),
    selected: selected[side],
    onSelectionChange: (keys: Set<Key>) => onSelectionChange(side, keys),
    onExpandAll: () => setExpanded((e) => ({ ...e, [side]: new Set(folderIds(trees[side])) })),
    onCollapseAll: () => setExpanded((e) => ({ ...e, [side]: new Set() })),
    counts: counts[side],
    related: relatedSets[side].related,
    relatedAncestors: relatedSets[side].ancestors,
    suggested: suggestedIds[side],
    pending,
    isFiltered: !!visible,
    onMapDrop: (sourceIds: string[], targetId: string) =>
      mapBetween(
        sourceIds.map((nodeId) => ({ side: otherSide(side), nodeId })),
        { side, nodeId: targetId },
      ),
    onHoverStart,
    onHoverEnd,
    onDragActive: (active: boolean) => {
      setDragging(active);
      if (active) onHoverEnd();
    },
  });

  return (
    <div className={wide ? "app wide" : "app narrow"}>
      <header className="topbar">
        <div className="brand">
          <h1>DPP traceability</h1>
          {nav}
          <span className="stat">
            <strong>{mappings.length}</strong> mappings
          </span>
          <span className="stat" title={`${covered} of ${requirementLeaves.length} data categories have a mapping`}>
            <span className="meter" aria-hidden="true">
              <span style={{ width: `${coverage}%` }} />
            </span>
            <strong>{coverage}%</strong> covered
          </span>
        </div>
        <div className="toolbar">
          {installPrompt.mode && (
            <Button
              className="primary"
              aria-expanded={installPrompt.mode === "ios" ? showIosHint : undefined}
              onPress={() => (installPrompt.mode === "ios" ? setShowIosHint((v) => !v) : installPrompt.install())}
            >
              Install
            </Button>
          )}
          <Button className="primary claude" isDisabled={llm.busy} onPress={askClaude}>
            {llm.busy ? "Asking Claude…" : "Suggest with Claude"}
          </Button>
          <Button className="ghost icon" aria-label="Claude settings" onPress={() => setSettingsOpen(true)}>
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </Button>
          <ToggleButton className="ghost toggle" isSelected={focusMode} onChange={setFocusMode}>
            Focus
          </ToggleButton>
          <Button className="ghost" onPress={() => setImportOpen(true)}>
            Upload
          </Button>
          <MenuTrigger>
            <Button className="ghost">Export</Button>
            <Popover className="menu-popover" placement="bottom end">
              <Menu
                className="menu"
                onAction={(key) => {
                  if (key === "json") exportProject(project);
                  else download(new Blob([dbRef.current.export() as BlobPart]), "dpp-traceability.sqlite");
                }}
              >
                <MenuItem id="json" className="menu-item">
                  Project (JSON)
                </MenuItem>
                <MenuItem id="sqlite" className="menu-item">
                  Database (SQLite)
                </MenuItem>
              </Menu>
            </Popover>
          </MenuTrigger>
          <Button className="ghost" onPress={resetAll}>
            Reset
          </Button>
        </div>
      </header>

      {showIosHint && installPrompt.mode === "ios" && (
        <div className="install-hint" role="note">
          <span>
            Tap <strong>Share</strong>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-label="Share icon">
              <path
                d="M8 1.5v8M5 4.5l3-3 3 3M4 7H3v7.5h10V7h-1"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            then <strong>Add to Home Screen</strong>.
          </span>
          <Button className="ghost icon" aria-label="Close" onPress={() => setShowIosHint(false)}>
            ×
          </Button>
        </div>
      )}

      {pending ? (
        <div className="banner info" role="status">
          <span>
            Tap an item in “{trees[otherSide(pending.side)].title}” to map <strong>{nodeName(pending)}</strong>.
          </span>
          <Button className="ghost" onPress={() => setPending(null)}>
            Cancel
          </Button>
        </div>
      ) : (
        <p className="hint">
          {wide
            ? "Hover for a preview, click to select and pin details, drag onto the other list to map."
            : "Tap to select and pin details. Long-press the ⋮⋮ handle to drag, or use “Map to…”."}
        </p>
      )}

      {llm.error && (
        <div className="banner warn" role="alert">
          <span>{llm.error}</span>
          <Button className="ghost icon" aria-label="Dismiss" onPress={() => setLlm({ busy: false, error: null })}>
            ×
          </Button>
        </div>
      )}

      <main className="board" ref={boardRef} data-pending={pending ? otherSide(pending.side) : undefined}>
        <TraceTree {...treeProps("left")} />
        {wide && <div className="gutter" aria-hidden="true" />}
        <TraceTree {...treeProps("right")} />
        {wide && (
          <ConnectorLayer
            boardRef={boardRef}
            mappings={mappings}
            suggestions={suggestions}
            highlighted={highlighted}
            trees={trees}
            parents={parents}
            flashId={flashId}
            layoutKey={items}
          />
        )}
      </main>

      {suggestions.length > 0 && (
        <aside className="suggestions" aria-label="Suggestions from Claude">
          <div className="suggestions-head">
            <strong>{suggestions.length} suggested by Claude</strong>
            <div className="suggestions-actions">
              <Button className="ghost" onPress={() => addMappings(suggestions.map(({ from, to }) => ({ from, to })))}>
                Accept all
              </Button>
              <Button className="ghost" onPress={() => setSuggestions([])}>
                Dismiss
              </Button>
            </div>
          </div>
          <ul className="suggestion-chips">
            {suggestions.map((s) => (
              <li key={s.id} title={s.reason}>
                <span className={`conf ${s.confidence}`} aria-label={`${s.confidence} confidence`} />
                <span className="chip-text">
                  {trees.left.nodes[s.from]?.name} → {trees.right.nodes[s.to]?.name}
                </span>
                <Button className="ghost icon ok" aria-label="Accept" onPress={() => acceptSuggestion(s)}>
                  ✓
                </Button>
                <Button className="ghost icon" aria-label="Reject" onPress={() => rejectSuggestion(s.id)}>
                  ×
                </Button>
              </li>
            ))}
          </ul>
        </aside>
      )}

      {visibleWindows.map((win) => (
        <ItemWindow
          key={win.key}
          win={win}
          docked={!wide}
          trees={trees}
          parents={parents}
          mappings={mappings}
          suggestions={suggestions}
          sources={project.sources}
          isPending={!!pending && anchorId(pending.side, pending.nodeId) === win.key}
          onClose={() => closeWindow(win.key)}
          onRaise={() => {
            const z = ++zTop.current;
            setWindows((ws) => ws.map((w) => (w.key === win.key ? { ...w, z } : w)));
          }}
          onMove={(x, y) => setWindows((ws) => ws.map((w) => (w.key === win.key ? { ...w, x, y } : w)))}
          onTogglePending={() =>
            setPending((p) => (p && anchorId(p.side, p.nodeId) === win.key ? null : win.ref))
          }
          onReveal={reveal}
          onRemoveMapping={removeMapping}
          onAccept={acceptSuggestion}
          onReject={rejectSuggestion}
        />
      ))}

      {wide && !dragging && <HoverPreview target={hover} trees={trees} parents={parents} mappings={mappings} />}

      <ImportDialog
        isOpen={importOpen}
        onOpenChange={setImportOpen}
        current={project}
        onImport={(next, summary) => {
          setProject(next);
          setSuggestions([]);
          setSelected({ left: new Set(), right: new Set() });
          setWindows([]);
          setPending(null);
          setToast({ text: summary, kind: "ok" });
        }}
      />

      <ClaudeSettings
        isOpen={settingsOpen}
        onOpenChange={setSettingsOpen}
        apiKey={apiKey.key}
        remember={apiKey.remember}
        onSave={(key, remember) => {
          saveApiKey(key, remember);
          setApiKey({ key, remember });
          setToast({ text: key ? "Claude key saved" : "Claude key removed", kind: "ok" });
        }}
      />

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}

type View = "requirements" | "validation" | "mapping";

const LANES: Array<{ id: View; label: string }> = [
  { id: "requirements", label: "Requirements" },
  { id: "validation", label: "Validation" },
  { id: "mapping", label: "Mapping" },
];

const viewFromHash = (): View => {
  const hash = window.location.hash.slice(1);
  return LANES.some((l) => l.id === hash) ? (hash as View) : "requirements";
};

/**
 * Horizontal lanes share the height of a rail down the left edge, each with
 * its label turned to run along the lane; the chosen lane's view fills the rest.
 */
export default function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [chain, setChain] = useState<Chain | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadChain().then(
      (loaded) => live && setChain(loaded),
      (error: unknown) => live && setLoadError(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="shell">
      <ToggleButtonGroup
        aria-label="View"
        className="lanes"
        orientation="vertical"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[view]}
        onSelectionChange={(keys) => {
          const next = [...keys][0] as View;
          history.replaceState(null, "", `#${next}`);
          setView(next);
        }}
      >
        {LANES.map((lane) => (
          <ToggleButton key={lane.id} id={lane.id} className="lane">
            <span className="lane-label">{lane.label}</span>
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <SamplesSidebar />
      {view === "mapping" ? (
        <MappingView />
      ) : chain ? (
        view === "requirements" ? (
          <RequirementsExplorer chain={chain} />
        ) : (
          <ValidationView chain={chain} />
        )
      ) : (
        <div className="app">
          {loadError ? (
            <div className="banner warn" role="alert">
              <span>Couldn't open the database: {loadError}</span>
            </div>
          ) : (
            <p className="hint" role="status">
              Loading…
            </p>
          )}
        </div>
      )}
    </div>
  );
}
