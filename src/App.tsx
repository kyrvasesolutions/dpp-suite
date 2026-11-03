import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { ConnectorLayer } from "./components/ConnectorLayer";
import { TraceTree, type NodeRef } from "./components/TraceTree";
import { passportTree, productTree, sampleMappings } from "./data/sample";
import { ancestorsOf, buildParentMap, endOn, isSelfOrDescendant, linkCounts } from "./model/tree";
import { otherSide, parseDndId, type Mapping, type Side } from "./model/types";
import { useInstallPrompt } from "./useInstallPrompt";
import { useMediaQuery } from "./useMediaQuery";

const STORAGE_KEY = "dpp-trace.mappings.v1";
const trees = { left: productTree, right: passportTree };
const parents = { left: buildParentMap(productTree), right: buildParentMap(passportTree) };

function loadMappings(): Mapping[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Mapping[];
  } catch {
    // Storage unavailable (private mode, blocked): fall back to sample data.
  }
  return sampleMappings;
}

// Only rows of the opposite tree are drop targets.
const oppositeSideOnly: CollisionDetection = (args) => {
  const from = parseDndId(args.active.id).side;
  return pointerWithin({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) => parseDndId(c.id).side !== from),
  });
};

export default function App() {
  const wide = useMediaQuery("(min-width: 768px)");
  const boardRef = useRef<HTMLDivElement>(null);

  const [mappings, setMappings] = useState<Mapping[]>(loadMappings);
  const [expandedLeft, setExpandedLeft] = useState<string[]>(["pack", "module", "cells", "docs"]);
  const [expandedRight, setExpandedRight] = useState<string[]>(["general", "materials", "carbon", "recycled"]);
  const [active, setActive] = useState<NodeRef | null>(null);
  const [pending, setPending] = useState<NodeRef | null>(null);
  const [dragging, setDragging] = useState<{ name: string; side: Side } | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "warn" } | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const installPrompt = useInstallPrompt();

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mappings));
    } catch {
      // Not persisted; the session still works.
    }
  }, [mappings]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!flashId) return;
    const t = setTimeout(() => setFlashId(null), 1200);
    return () => clearTimeout(t);
  }, [flashId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pending) setPending(null);
      else setActive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Long-press to drag on touch so normal swipes still scroll the list.
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );

  const existing = useMemo(() => new Set(mappings.map((m) => `${m.from}|${m.to}`)), [mappings]);
  const counts = useMemo(
    () => ({ left: linkCounts(mappings, "left", parents.left), right: linkCounts(mappings, "right", parents.right) }),
    [mappings],
  );

  // Mappings touching the active item or anything inside it.
  const activeMappings = useMemo(
    () =>
      active
        ? mappings.filter((m) => isSelfOrDescendant(endOn(m, active.side), active.nodeId, parents[active.side]))
        : [],
    [active, mappings],
  );

  const relatedSets = useMemo(() => {
    const make = (side: Side) => {
      const related = new Set(activeMappings.map((m) => endOn(m, side)));
      const ancestors = new Set<string>();
      for (const id of related) for (const a of ancestorsOf(id, parents[side], trees[side].rootId)) ancestors.add(a);
      return { related, ancestors };
    };
    return { left: make("left"), right: make("right") };
  }, [activeMappings]);

  const addMapping = useCallback(
    (a: NodeRef, b: NodeRef) => {
      if (a.side === b.side) return;
      const [l, r] = a.side === "left" ? [a, b] : [b, a];
      const name = (ref: NodeRef) => trees[ref.side].nodes[ref.nodeId]?.name;
      if (existing.has(`${l.nodeId}|${r.nodeId}`)) {
        setToast({ text: `Already mapped: ${name(l)} → ${name(r)}`, kind: "warn" });
        return;
      }
      const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      setMappings((ms) => [...ms, { id, from: l.nodeId, to: r.nodeId }]);
      setFlashId(id);
      setToast({ text: `Mapped ${name(l)} → ${name(r)}`, kind: "ok" });
    },
    [existing],
  );

  const removeMapping = (id: string) => setMappings((ms) => ms.filter((m) => m.id !== id));

  const activate = useCallback(
    (ref: NodeRef) => {
      if (pending && pending.side !== ref.side) {
        addMapping(pending, ref);
        setPending(null);
        return;
      }
      if (pending) setPending(ref);
      setActive((cur) => (cur && cur.side === ref.side && cur.nodeId === ref.nodeId && !pending ? null : ref));
    },
    [pending, addMapping],
  );

  const reveal = (side: Side, nodeId: string) => {
    const setExpanded = side === "left" ? setExpandedLeft : setExpandedRight;
    const ancestors = ancestorsOf(nodeId, parents[side], trees[side].rootId);
    setExpanded((cur) => Array.from(new Set([...cur, ...ancestors])));
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-anchor="${CSS.escape(`${side}:${nodeId}`)}"]`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }),
    );
  };

  const onDragStart = ({ active: a }: DragStartEvent) => {
    const { side, nodeId } = parseDndId(a.id);
    setDragging({ side, name: trees[side].nodes[nodeId]?.name ?? nodeId });
    setActive({ side, nodeId });
    setPending(null);
  };

  const onDragEnd = ({ active: a, over }: DragEndEvent) => {
    setDragging(null);
    if (over) addMapping(parseDndId(a.id), parseDndId(over.id));
  };

  const requirementLeaves = Object.values(passportTree.nodes).filter((n) => !n.children?.length);
  const covered = requirementLeaves.filter((n) => counts.right.direct[n.id]).length;
  const coverage = Math.round((covered / requirementLeaves.length) * 100);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(mappings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "dpp-mappings.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const treeProps = (side: Side) => ({
    side,
    data: trees[side],
    expanded: side === "left" ? expandedLeft : expandedRight,
    setExpanded: side === "left" ? setExpandedLeft : setExpandedRight,
    counts: counts[side],
    active,
    pending,
    related: relatedSets[side].related,
    relatedAncestors: relatedSets[side].ancestors,
    existing,
    onActivate: activate,
  });

  const activeNode = active ? trees[active.side].nodes[active.nodeId] : null;
  const activePath = active
    ? ancestorsOf(active.nodeId, parents[active.side], trees[active.side].rootId)
        .reverse()
        .map((id) => trees[active.side].nodes[id]?.name)
    : [];

  return (
    <div className={wide ? "app wide" : "app narrow"}>
      <header className="topbar">
        <div className="brand">
          <h1>DPP traceability</h1>
          <span className="stat">
            <strong>{mappings.length}</strong> mappings
          </span>
          <span className="stat" title={`${covered} of ${requirementLeaves.length} requirements have evidence`}>
            <span className="meter" aria-hidden="true">
              <span style={{ width: `${coverage}%` }} />
            </span>
            <strong>{coverage}%</strong> covered
          </span>
        </div>
        <div className="toolbar">
          {installPrompt.mode && (
            <button
              type="button"
              className="primary"
              aria-expanded={installPrompt.mode === "ios" ? showIosHint : undefined}
              onClick={() => (installPrompt.mode === "ios" ? setShowIosHint((v) => !v) : installPrompt.install())}
            >
              Install
            </button>
          )}
          <button type="button" className="ghost" onClick={exportJson}>
            Export
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setMappings(sampleMappings);
              setActive(null);
              setPending(null);
            }}
          >
            Reset
          </button>
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
          <button type="button" className="ghost icon" aria-label="Close" onClick={() => setShowIosHint(false)}>
            ×
          </button>
        </div>
      )}

      <p className="hint">
        {pending
          ? `Tap an item in “${trees[otherSide(pending.side)].title}” to map it. Esc to cancel.`
          : wide
            ? "Drag an item onto the other list to map it. Click an item to see its links."
            : "Long-press and drag to map, or tap an item and use “Map to…”."}
      </p>

      <DndContext
        sensors={sensors}
        collisionDetection={oppositeSideOnly}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
        autoScroll={{ threshold: { x: 0, y: 0.15 } }}
      >
        <main className="board" ref={boardRef} data-pending={pending ? otherSide(pending.side) : undefined}>
          <TraceTree {...treeProps("left")} />
          {wide && <div className="gutter" aria-hidden="true" />}
          <TraceTree {...treeProps("right")} />
          {wide && (
            <ConnectorLayer
              boardRef={boardRef}
              mappings={mappings}
              trees={trees}
              parents={parents}
              active={active}
              flashId={flashId}
              layoutKey={`${expandedLeft.join()}|${expandedRight.join()}|${wide}`}
            />
          )}
        </main>
        <DragOverlay dropAnimation={null}>
          {dragging && <div className={`drag-chip from-${dragging.side}`}>{dragging.name}</div>}
        </DragOverlay>
      </DndContext>

      <aside className={active ? "details open" : "details"} aria-live="polite">
        {active && activeNode ? (
          <>
            <div className="details-head">
              <div className="details-title">
                {activePath.length > 0 && <span className="crumbs">{activePath.join(" / ")}</span>}
                <strong>{activeNode.name}</strong>
              </div>
              <div className="details-actions">
                <button
                  type="button"
                  className={pending ? "primary on" : "primary"}
                  onClick={() => setPending(pending ? null : active)}
                >
                  {pending ? "Cancel" : "Map to…"}
                </button>
                <button type="button" className="ghost icon" aria-label="Close" onClick={() => setActive(null)}>
                  ×
                </button>
              </div>
            </div>
            {activeMappings.length === 0 ? (
              <p className="empty">No mappings yet.</p>
            ) : (
              <ul className="links">
                {activeMappings.map((m) => {
                  const other = otherSide(active.side);
                  const otherId = endOn(m, other);
                  const ownId = endOn(m, active.side);
                  return (
                    <li key={m.id}>
                      <button type="button" className="link-target" onClick={() => reveal(other, otherId)}>
                        {ownId !== active.nodeId && (
                          <span className="via">{trees[active.side].nodes[ownId]?.name} →</span>
                        )}
                        <span>{trees[other].nodes[otherId]?.name}</span>
                      </button>
                      <button
                        type="button"
                        className="ghost icon"
                        aria-label={`Remove mapping to ${trees[other].nodes[otherId]?.name}`}
                        onClick={() => removeMapping(m.id)}
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : (
          <p className="empty">Select an item to see and edit its mappings.</p>
        )}
      </aside>

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}
