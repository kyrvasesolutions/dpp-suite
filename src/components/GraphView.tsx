import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  Button,
  Checkbox,
  CheckboxGroup,
  Disclosure,
  DisclosurePanel,
  Heading,
  Link,
  ToggleButton,
  ToggleButtonGroup,
} from "react-aria-components";
import type { Chain } from "../model/chain";
import { TARGET_TYPES } from "../model/legislation";
import { MATCH_LABEL } from "../model/ontologies";
import {
  loadHiddenLegislations,
  loadLastSpecId,
  loadSpecs,
  saveHiddenLegislations,
  saveLastSpecId,
  type Spec,
  type SpecSource,
} from "../model/spec";
import {
  REQUIREMENT_HEIGHT,
  REQUIREMENT_WIDTH,
  buildOntologyGraph,
  buildSpecGraph,
  filterGraph,
  hexagonPoints,
  hubReach,
  layoutGraph,
  legislationHubGraph,
  ontologyHubGraph,
  webUrl,
  wrapLabel,
  type HubGraph,
  type LegislationNode,
  type Lens,
  type OntologyGraph,
  type OntologyNode,
  type Positions,
  type RequirementNode,
  type SpecGraph,
} from "../model/specGraph";
import { useMediaQuery } from "../useMediaQuery";
import { SpecLibrary } from "./SpecLibrary";
import { TargetChip, targetStyle } from "./TargetChip";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ontologies = (n: number) => `${n} ${n === 1 ? "ontology" : "ontologies"}`;

const EDGE_LABEL: Record<Lens, string> = { legislation: "part of", ontology: "answered by" };

/** Above this many edges, "part of" is only written on those around the node in focus. */
const ALWAYS_LABEL_EDGES = 24;
const DRAG_THRESHOLD = 4;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const FIT_PADDING = 40;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

type Gesture =
  | { kind: "pan"; startX: number; startY: number; originX: number; originY: number; moved: boolean }
  | { kind: "node"; key: string; startX: number; startY: number; originX: number; originY: number; moved: boolean };

/** Where a line from a rectangle's centre towards a point leaves the rectangle. */
function rectangleExit(from: { x: number; y: number }, to: { x: number; y: number }, halfW: number, halfH: number) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return from;
  const scale = Math.min(dx ? halfW / Math.abs(dx) : Infinity, dy ? halfH / Math.abs(dy) : Infinity);
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

function NodeLabel({ lines, lineHeight = 14 }: { lines: string[]; lineHeight?: number }) {
  const top = -((lines.length - 1) * lineHeight) / 2;
  return (
    <text textAnchor="middle" dominantBaseline="central">
      {lines.map((line, i) => (
        <tspan key={i} x="0" y={top + i * lineHeight}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

interface CanvasProps {
  graph: HubGraph;
  selected: string | null;
  onSelect: (key: string | null) => void;
}

/** The graph itself: drag the background to pan, scroll to zoom, drag a node to move it, click to select. */
function GraphCanvas({ graph, selected, onSelect }: CanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const userMovedView = useRef(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [resting] = useState(() => layoutGraph(graph));
  const [moved, setMoved] = useState<Positions>({});
  const [hovered, setHovered] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  const at = useCallback((key: string) => moved[key] ?? resting[key], [moved, resting]);

  const fit = useCallback(() => {
    if (!size.w || !size.h) return;
    const boxes = [
      ...graph.requirements.map((r) => ({ key: r.key, hw: REQUIREMENT_WIDTH / 2, hh: REQUIREMENT_HEIGHT / 2 })),
      ...graph.hubs.map((h) => ({ key: h.key, hw: h.radius, hh: h.radius })),
    ];
    const left = Math.min(...boxes.map((b) => at(b.key).x - b.hw));
    const right = Math.max(...boxes.map((b) => at(b.key).x + b.hw));
    const top = Math.min(...boxes.map((b) => at(b.key).y - b.hh));
    const bottom = Math.max(...boxes.map((b) => at(b.key).y + b.hh));
    const k = clamp(
      Math.min((size.w - FIT_PADDING * 2) / (right - left), (size.h - FIT_PADDING * 2) / (bottom - top)),
      MIN_ZOOM,
      1.2,
    );
    setView({ k, x: size.w / 2 - (k * (left + right)) / 2, y: size.h / 2 - (k * (top + bottom)) / 2 });
  }, [graph, at, size]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // Keep the graph fitted as the window resizes, until the user positions it themselves.
  useEffect(() => {
    if (!userMovedView.current) fit();
  }, [size]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomAround = useCallback((cx: number, cy: number, factor: number) => {
    userMovedView.current = true;
    setView((v) => {
      const k = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM);
      const applied = k / v.k;
      return { k, x: cx - (cx - v.x) * applied, y: cy - (cy - v.y) * applied };
    });
  }, []);

  // React's own wheel listener is passive, which would leave the page able to scroll.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = svg.getBoundingClientRect();
      zoomAround(e.clientX - box.left, e.clientY - box.top, Math.exp(-e.deltaY * 0.0015));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomAround]);

  const onBackgroundDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { kind: "pan", startX: e.clientX, startY: e.clientY, originX: view.x, originY: view.y, moved: false };
  };

  const onNodeDown = (e: ReactPointerEvent<SVGGElement>, key: string) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(key);
    gesture.current = { kind: "node", key, startX: e.clientX, startY: e.clientY, originX: p.x, originY: p.y, moved: false };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const box = stageRef.current?.getBoundingClientRect();
    if (box) setTip({ x: e.clientX - box.left, y: e.clientY - box.top });
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    g.moved = true;
    if (g.kind === "pan") {
      userMovedView.current = true;
      setView((v) => ({ ...v, x: g.originX + dx, y: g.originY + dy }));
    } else {
      setMoved((m) => ({ ...m, [g.key]: { x: g.originX + dx / view.k, y: g.originY + dy / view.k } }));
    }
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.moved) return;
    if (g.kind === "pan") onSelect(null);
    else onSelect(g.key === selected ? null : g.key);
  };

  const focus = hovered ?? selected;
  const related = useMemo(() => {
    if (!focus) return null;
    const keys = new Set([focus]);
    for (const l of graph.links) {
      if (l.requirement === focus) keys.add(l.hub);
      if (l.hub === focus) keys.add(l.requirement);
    }
    return keys;
  }, [focus, graph]);

  const nodeProps = (key: string, label: string) => ({
    "data-key": key,
    tabIndex: 0,
    role: "button",
    "aria-label": label,
    "aria-pressed": key === selected,
    onPointerDown: (e: ReactPointerEvent<SVGGElement>) => onNodeDown(e, key),
    onPointerEnter: () => setHovered(key),
    onPointerLeave: () => setHovered(null),
    onFocus: () => setHovered(key),
    onBlur: () => setHovered(null),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(key === selected ? null : key);
      } else if (e.key === "Escape") onSelect(null);
    },
  });

  const stateClass = (key: string) =>
    `${key === selected ? " is-selected" : ""}${related && !related.has(key) ? " is-dimmed" : ""}`;

  const hubByKey = useMemo(() => new Map(graph.hubs.map((h) => [h.key, h])), [graph]);
  const hoveredRequirement = graph.requirements.find((r) => r.key === hovered);
  const hoveredHub = hovered ? hubByKey.get(hovered) : undefined;
  const isOntology = graph.lens === "ontology";
  const typesShown = TARGET_TYPES.filter((t) => graph.hubs.some((h) => h.type === t.id));
  const hasUntyped = !isOntology && graph.hubs.some((h) => !h.type);
  const hasPartial = graph.links.some((l) => l.partial);

  return (
    <div className="graph-stage" ref={stageRef}>
      <svg
        ref={svgRef}
        className="graph-svg"
        role="group"
        aria-label={isOntology ? "Data requirements and the ontologies that answer them" : "Data requirements and the legislation each is part of"}
        onPointerDown={onBackgroundDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (gesture.current = null)}
        onPointerLeave={() => setTip(null)}
      >
        <defs>
          {["rest", "active"].map((state) => (
            <marker
              key={state}
              id={`graph-arrow-${state}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="9"
              markerHeight="9"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path className={`graph-arrow ${state}`} d="M0 0 L10 5 L0 10 z" />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {graph.links.map((link) => {
            const hub = hubByKey.get(link.hub)!;
            const from = at(link.requirement);
            const to = at(link.hub);
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const distance = Math.hypot(dx, dy);
            const reach = hubReach(hub, graph.lens, dx, dy) + 2;
            if (distance <= reach) return null;
            const start = rectangleExit(from, to, REQUIREMENT_WIDTH / 2, REQUIREMENT_HEIGHT / 2);
            const end = { x: to.x - (dx / distance) * reach, y: to.y - (dy / distance) * reach };
            const active = focus === link.requirement || focus === link.hub;
            const dimmed = !!focus && !active;
            const labelled = active || graph.links.length <= ALWAYS_LABEL_EDGES;
            return (
              <g
                key={link.key}
                className={`graph-edge${active ? " is-active" : ""}${dimmed ? " is-dimmed" : ""}${link.partial ? " is-partial" : ""}`}
              >
                <line
                  x1={start.x}
                  y1={start.y}
                  x2={end.x}
                  y2={end.y}
                  markerEnd={`url(#graph-arrow-${active ? "active" : "rest"})`}
                />
                {labelled && !dimmed && (
                  <text x={(start.x + end.x) / 2} y={(start.y + end.y) / 2} textAnchor="middle" dominantBaseline="central">
                    {EDGE_LABEL[graph.lens]}
                  </text>
                )}
              </g>
            );
          })}
          {graph.requirements.map((r) => {
            const p = at(r.key);
            return (
              <g
                key={r.key}
                className={`graph-node requirement${graph.unlinked.has(r.key) ? " is-unattributed" : ""}${stateClass(r.key)}`}
                transform={`translate(${p.x} ${p.y})`}
                {...nodeProps(r.key, `Data requirement: ${r.name}`)}
              >
                <rect
                  x={-REQUIREMENT_WIDTH / 2}
                  y={-REQUIREMENT_HEIGHT / 2}
                  width={REQUIREMENT_WIDTH}
                  height={REQUIREMENT_HEIGHT}
                  rx={REQUIREMENT_HEIGHT / 2}
                />
                <NodeLabel lines={wrapLabel(r.name, 21, 2)} />
              </g>
            );
          })}
          {graph.hubs.map((h) => {
            const p = at(h.key);
            return (
              <g
                key={h.key}
                className={`graph-node ${isOntology ? "ontology" : "legislation"}${stateClass(h.key)}`}
                style={h.type ? targetStyle(h.type) : undefined}
                transform={`translate(${p.x} ${p.y})`}
                {...nodeProps(h.key, `${isOntology ? "Ontology" : "Legislation"}: ${h.title}, ${plural(h.count, "data requirement")}`)}
              >
                {isOntology ? <polygon points={hexagonPoints(h.radius)} /> : <circle r={h.radius} />}
                <NodeLabel lines={wrapLabel(h.label, Math.floor(h.radius / (isOntology ? 3.9 : 3.6)), 3)} />
              </g>
            );
          })}
        </g>
      </svg>

      <div className="graph-legend" aria-label="Legend">
        <span className="graph-key">
          <span className="graph-swatch requirement" aria-hidden="true" /> Data requirement
        </span>
        {isOntology && (
          <span className="graph-key">
            <span className="graph-swatch ontology" aria-hidden="true" /> Ontology
          </span>
        )}
        {typesShown.map((t) => (
          <span key={t.id} className="graph-key">
            <span className="graph-swatch legislation" style={targetStyle(t.id)} aria-hidden="true" />
            {t.audience} {t.name}
          </span>
        ))}
        {hasUntyped && (
          <span className="graph-key">
            <span className="graph-swatch legislation" aria-hidden="true" /> Type not stated
          </span>
        )}
        <span className="graph-key">
          <svg width="26" height="8" viewBox="0 0 26 8" aria-hidden="true">
            <line x1="0" y1="4" x2="19" y2="4" className="graph-key-line" />
            <path d="M18 0 L26 4 L18 8 z" className="graph-arrow rest" />
          </svg>
          {EDGE_LABEL[graph.lens]}
        </span>
        {hasPartial && (
          <span className="graph-key">
            <svg width="26" height="8" viewBox="0 0 26 8" aria-hidden="true">
              <line x1="0" y1="4" x2="19" y2="4" className="graph-key-line" strokeDasharray="5 4" />
              <path d="M18 0 L26 4 L18 8 z" className="graph-arrow rest" />
            </svg>
            partly (broader or narrower term)
          </span>
        )}
      </div>

      <div className="graph-controls" role="group" aria-label="Zoom">
        <Button className="ghost icon" aria-label="Zoom in" onPress={() => zoomAround(size.w / 2, size.h / 2, 1.25)}>
          +
        </Button>
        <Button className="ghost icon" aria-label="Zoom out" onPress={() => zoomAround(size.w / 2, size.h / 2, 0.8)}>
          −
        </Button>
        <Button
          className="ghost"
          onPress={() => {
            userMovedView.current = false;
            fit();
          }}
        >
          Fit
        </Button>
      </div>

      {tip && (hoveredRequirement || hoveredHub) && (
        <div
          className="graph-tip"
          aria-hidden="true"
          style={{ left: clamp(tip.x + 14, 4, Math.max(4, size.w - 264)), top: clamp(tip.y + 14, 4, Math.max(4, size.h - 80)) }}
        >
          <strong>{hoveredRequirement?.name ?? hoveredHub?.title}</strong>
          <span>
            {hoveredRequirement
              ? (() => {
                  const n = graph.links.filter((l) => l.requirement === hoveredRequirement.key).length;
                  return `${hoveredRequirement.theme} · ${isOntology ? `answered by ${ontologies(n)}` : `part of ${plural(n, "legislation")}`}`;
                })()
              : `${hoveredHub?.subtitle ?? ""} · ${plural(hoveredHub?.count ?? 0, "data requirement")}`}
          </span>
        </div>
      )}
    </div>
  );
}

function SourceEntry({ source }: { source: SpecSource }) {
  const url = webUrl(source.url);
  const name = source.provision || source.act || "Provision";
  return (
    <li>
      {url ? (
        <Link className="req-ref" href={url} target="_blank" rel="noreferrer">
          {name}
        </Link>
      ) : (
        <span className="graph-ref">{name}</span>
      )}
      {source.summary && <p className="muted small">{source.summary}</p>}
    </li>
  );
}

function RequirementDetails({
  node,
  graph,
  filteredOut,
  onSelect,
}: {
  node: RequirementNode;
  graph: SpecGraph;
  /** Legislations this requirement is also part of, that the filter hides. */
  filteredOut: number;
  onSelect: (key: string) => void;
}) {
  const edges = graph.edges.filter((e) => e.requirement === node.key);
  return (
    <>
      <div className="graph-detail-head">
        <span className="section-kicker">Data requirement · {node.theme}</span>
        <h3>{node.name}</h3>
      </div>
      {edges.length === 0 && <p className="empty">This specification names no legislation for this requirement.</p>}
      {edges.map((edge) => {
        const law = graph.legislations.find((l) => l.key === edge.legislation)!;
        return (
          <div key={edge.key} className="graph-detail-block">
            <div className="graph-part-of">
              <span className="muted small">part of</span>
              <Button className="graph-chip-button" onPress={() => onSelect(law.key)}>
                <TargetChip type={law.type}>{law.label}</TargetChip>
              </Button>
            </div>
            <ul className="graph-sources">
              {edge.sources.map((source, i) => (
                <SourceEntry key={i} source={source} />
              ))}
            </ul>
          </div>
        );
      })}
      {filteredOut > 0 && (
        <p className="muted small">Also part of {plural(filteredOut, "more target")} filtered out of this view.</p>
      )}
      {node.standards.length > 0 && (
        <div className="graph-detail-block">
          <span className="muted small">Standards</span>
          <ul className="graph-sources">
            {node.standards.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function LegislationDetails({
  node,
  graph,
  onSelect,
}: {
  node: LegislationNode;
  graph: SpecGraph;
  onSelect: (key: string) => void;
}) {
  const url = webUrl(node.url);
  const type = TARGET_TYPES.find((t) => t.id === node.type);
  const edges = graph.edges.filter((e) => e.legislation === node.key);
  return (
    <>
      <div className="graph-detail-head">
        <span className="section-kicker">{type ? `${type.audience} ${type.name}` : "Compliance target"}</span>
        <h3>{node.title || node.label}</h3>
        {node.ref &&
          (url ? (
            <Link className="req-ref" href={url} target="_blank" rel="noreferrer">
              {node.ref}
            </Link>
          ) : (
            <span className="graph-ref">{node.ref}</span>
          ))}
      </div>
      <div className="graph-detail-block">
        <span className="muted small">{plural(edges.length, "data requirement")} part of this</span>
        {edges.length === 0 && <p className="empty">No data requirement in this specification comes from it.</p>}
        <ul className="graph-sources">
          {edges.map((edge) => {
            const requirement = graph.requirements.find((r) => r.key === edge.requirement)!;
            return (
              <li key={edge.key}>
                <Button className="graph-text-button" onPress={() => onSelect(requirement.key)}>
                  {requirement.name}
                </Button>
                <p className="muted small">{edge.sources.map((s) => s.provision).filter(Boolean).join(", ")}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

function RequirementOntologyDetails({
  node,
  graph,
  laws,
  onSelect,
}: {
  node: RequirementNode;
  graph: OntologyGraph;
  /** The ticked legislations this requirement comes from. */
  laws: LegislationNode[];
  onSelect: (key: string) => void;
}) {
  const edges = graph.edges.filter((e) => e.requirement === node.key);
  return (
    <>
      <div className="graph-detail-head">
        <span className="section-kicker">Data requirement · {node.theme}</span>
        <h3>{node.name}</h3>
      </div>
      {laws.length > 0 && (
        <div className="graph-part-of graph-from">
          <span className="muted small">from</span>
          {laws.map((l) => (
            <TargetChip key={l.key} type={l.type}>
              {l.label}
            </TargetChip>
          ))}
        </div>
      )}
      {edges.length === 0 && <p className="empty">No ontology term in the catalogue answers this data requirement.</p>}
      {edges.map((edge) => {
        const ontology = graph.ontologies.find((o) => o.key === edge.ontology)!;
        return (
          <div key={edge.key} className="graph-detail-block">
            <div className="graph-part-of">
              <span className="muted small">answered by</span>
              <Button className="graph-text-button" onPress={() => onSelect(ontology.key)}>
                {ontology.name}
              </Button>
            </div>
            <ul className="graph-sources">
              {edge.terms.map(({ term, match, note }) => {
                const url = webUrl(term.uri);
                return (
                  <li key={term.id}>
                    {url ? (
                      <Link className="req-ref" href={url} target="_blank" rel="noreferrer">
                        {term.label}
                      </Link>
                    ) : (
                      <span className="graph-ref">{term.label}</span>
                    )}{" "}
                    <span className="muted small">· {MATCH_LABEL[match]}</span>
                    <p className="muted small">{term.definition}</p>
                    {note && <p className="muted small">Our reading: {note}</p>}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </>
  );
}

function OntologyDetails({
  node,
  graph,
  onSelect,
}: {
  node: OntologyNode;
  graph: OntologyGraph;
  onSelect: (key: string) => void;
}) {
  const url = webUrl(node.uri);
  const license = webUrl(node.licenseUrl);
  const edges = graph.edges.filter((e) => e.ontology === node.key);
  return (
    <>
      <div className="graph-detail-head">
        <span className="section-kicker">Ontology</span>
        <h3>{node.name}</h3>
        {url && (
          <Link className="req-ref" href={url} target="_blank" rel="noreferrer">
            {node.uri}
          </Link>
        )}
        <p className="muted small">{node.description}</p>
        {license ? (
          <Link className="req-ref" href={license} target="_blank" rel="noreferrer">
            {node.license}
          </Link>
        ) : (
          <span className="graph-ref">{node.license}</span>
        )}
      </div>
      <div className="graph-detail-block">
        <span className="muted small">Answers {plural(edges.length, "data requirement")} in this selection</span>
        <ul className="graph-sources">
          {edges.map((edge) => {
            const requirement = graph.requirements.find((r) => r.key === edge.requirement)!;
            return (
              <li key={edge.key}>
                <Button className="graph-text-button" onPress={() => onSelect(requirement.key)}>
                  {requirement.name}
                </Button>
                <p className="muted small">
                  {edge.terms.map((t) => `${t.term.label} (${MATCH_LABEL[t.match].toLowerCase()})`).join(", ")}
                </p>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

function GraphTable({ graph, selected, onSelect }: CanvasProps) {
  const isOntology = graph.lens === "ontology";
  const hubFor = (key: string) => graph.hubs.find((h) => h.key === key)!;
  return (
    <div className="graph-table-wrap">
      <table className="graph-table">
        <thead>
          <tr>
            <th scope="col">Data requirement</th>
            <th scope="col">Theme</th>
            <th scope="col">{isOntology ? "Answered by" : "Part of"}</th>
            <th scope="col" className="num">
              {isOntology ? "Terms" : "Provisions"}
            </th>
          </tr>
        </thead>
        <tbody>
          {graph.requirements.map((r) => {
            const links = graph.links.filter((l) => l.requirement === r.key);
            return (
              <tr key={r.key} className={r.key === selected ? "is-selected" : undefined}>
                <th scope="row">
                  <Button className="graph-text-button" onPress={() => onSelect(r.key)}>
                    {r.name}
                  </Button>
                </th>
                <td>{r.theme}</td>
                <td>
                  <span className="graph-table-laws">
                    {links.length === 0 && <span className="muted">{isOntology ? "No ontology term" : "None named"}</span>}
                    {links.map((l) => {
                      const hub = hubFor(l.hub);
                      return (
                        <TargetChip key={l.key} type={hub.type}>
                          {hub.label}
                        </TargetChip>
                      );
                    })}
                  </span>
                </td>
                <td className="num">{links.reduce((n, l) => n + l.weight, 0)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface FilterProps {
  legislations: LegislationNode[];
  hidden: Set<string>;
  onHiddenChange: (hidden: Set<string>) => void;
  /** The browser refused the cookie that remembers this choice. */
  notSaved: boolean;
}

/** A collapsible list of the specification's legislations, by type: only those ticked are in the graph. */
function LegislationFilter({ legislations, hidden, onHiddenChange, notSaved }: FilterProps) {
  const sections = [
    ...TARGET_TYPES.map((t) => ({
      id: t.id as string,
      name: `${t.audience} ${t.name}`,
      items: legislations.filter((l) => l.type === t.id),
    })),
    { id: "untyped", name: "Type not stated", items: legislations.filter((l) => !l.type) },
  ].filter((section) => section.items.length > 0);
  const shown = legislations.length - hidden.size;

  return (
    <Disclosure className="panel graph-filter" defaultExpanded>
      {({ isExpanded }) => (
        <>
          <Heading level={2} className="graph-filter-heading">
            <Button slot="trigger" className="panel-head graph-filter-trigger">
              <span className="graph-filter-title">
                <span className="graph-filter-name">Legislations</span>
                <span className="graph-filter-count">
                  {shown} of {legislations.length} shown
                </span>
              </span>
              <span className="chevron" data-open={isExpanded} aria-hidden="true">
                <svg viewBox="0 0 16 16" width="14" height="14">
                  <path d="M6 3.5l4.5 4.5-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </Button>
          </Heading>
          <DisclosurePanel className="graph-filter-body">
            <div className="spec-import">
              <Button className="ghost" isDisabled={hidden.size === 0} onPress={() => onHiddenChange(new Set())}>
                All
              </Button>
              <Button
                className="ghost"
                isDisabled={shown === 0}
                onPress={() => onHiddenChange(new Set(legislations.map((l) => l.key)))}
              >
                None
              </Button>
            </div>
            {notSaved && (
              <p className="upload-error" role="status">
                This browser didn't keep the cookie, so this choice won't be remembered next time.
              </p>
            )}
            <CheckboxGroup
              aria-label="Legislations to show in the graph"
              value={legislations.filter((l) => !hidden.has(l.key)).map((l) => l.key)}
              onChange={(chosen) =>
                onHiddenChange(new Set(legislations.map((l) => l.key).filter((key) => !chosen.includes(key))))
              }
            >
              {sections.map((section) => (
                <div key={section.id} role="group" aria-label={section.name}>
                  {sections.length > 1 && <div className="section-head">{section.name}</div>}
                  {section.items.map((l) => (
                    <Checkbox key={l.key} value={l.key} className="checkbox graph-filter-item">
                      <span className="box" aria-hidden="true" />
                      <span
                        className="graph-swatch legislation"
                        style={l.type ? targetStyle(l.type) : undefined}
                        aria-hidden="true"
                      />
                      <span className="graph-filter-label" title={l.title || l.label}>
                        {l.label}
                      </span>
                      <span className="graph-filter-reqs" title={plural(l.requirementCount, "data requirement")}>
                        {l.requirementCount}
                      </span>
                    </Checkbox>
                  ))}
                </div>
              ))}
            </CheckboxGroup>
          </DisclosurePanel>
        </>
      )}
    </Disclosure>
  );
}

/**
 * The explorer: import a specification, tick the legislations that matter, and see
 * either the legislation behind its data requirements or the ontologies that answer
 * them. Both lenses show the same data requirements: those the ticked legislations set.
 */
export function GraphView({ chain, chainError }: { chain: Chain | null; chainError: string | null }) {
  const wide = useMediaQuery("(min-width: 1024px)");
  const [specs, setSpecs] = useState<Spec[]>(loadSpecs);
  const [specId, setSpecId] = useState<string | null>(() => {
    const saved = loadSpecs();
    const last = loadLastSpecId();
    return saved.find((s) => s.id === last)?.id ?? saved[0]?.id ?? null;
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"graph" | "table">("graph");
  const [lens, setLens] = useState<Lens>("legislation");
  const [storedHidden, setStoredHidden] = useState<Set<string>>(() =>
    specId ? loadHiddenLegislations(specId) : new Set(),
  );
  const [notSaved, setNotSaved] = useState(false);

  const spec = specs.find((s) => s.id === specId) ?? null;
  const fullGraph = useMemo(() => (spec ? buildSpecGraph(spec) : null), [spec]);
  // A saved choice can name a legislation the specification no longer has.
  const hidden = useMemo(
    () => new Set(fullGraph?.legislations.map((l) => l.key).filter((key) => storedHidden.has(key)) ?? []),
    [fullGraph, storedHidden],
  );
  const graph = useMemo(() => fullGraph && filterGraph(fullGraph, hidden), [fullGraph, hidden]);
  const ontologyGraph = useMemo(
    () => (chain && graph ? buildOntologyGraph(chain, graph.requirements) : null),
    [chain, graph],
  );
  const drawn = useMemo(() => {
    if (lens === "ontology") return ontologyGraph && ontologyHubGraph(ontologyGraph);
    return graph && legislationHubGraph(graph);
  }, [lens, graph, ontologyGraph]);
  const filtering = hidden.size > 0;
  const isOntology = lens === "ontology";

  const updateHidden = (next: Set<string>) => {
    setStoredHidden(next);
    if (specId) setNotSaved(!saveHiddenLegislations(specId, next));
  };

  const chooseSpec = (id: string | null) => {
    setSpecId(id);
    setSelected(null);
    setStoredHidden(id ? loadHiddenLegislations(id) : new Set());
    setNotSaved(false);
    if (id) saveLastSpecId(id);
  };

  const requirement = graph?.requirements.find((r) => r.key === selected);
  const law = isOntology ? undefined : graph?.legislations.find((l) => l.key === selected);
  const ontology = isOntology ? ontologyGraph?.ontologies.find((o) => o.key === selected) : undefined;
  // A node this view doesn't have stops being selected, or the whole graph would dim around it.
  const shownSelected = requirement?.key ?? law?.key ?? ontology?.key ?? null;
  const filteredOut = fullGraph
    ? fullGraph.edges.filter((e) => e.requirement === selected && hidden.has(e.legislation)).length
    : 0;
  const lawsOfSelected = useMemo(
    () =>
      (graph?.edges ?? [])
        .filter((e) => e.requirement === requirement?.key)
        .map((e) => graph!.legislations.find((l) => l.key === e.legislation)!),
    [graph, requirement],
  );
  const ofTotal = (total: number | undefined) => (filtering ? ` of ${total}` : "");
  const answered = ontologyGraph ? ontologyGraph.requirements.length - ontologyGraph.unanswered.size : 0;
  // Reached only through broader or narrower terms: an ontology covers it, but not squarely.
  const partlyAnswered = useMemo(() => {
    if (!ontologyGraph) return 0;
    const direct = new Set(
      ontologyGraph.edges
        .filter((e) => e.terms.some((t) => t.match === "exact" || t.match === "close"))
        .map((e) => e.requirement),
    );
    return new Set(ontologyGraph.edges.map((e) => e.requirement).filter((key) => !direct.has(key))).size;
  }, [ontologyGraph]);

  return (
    <div className={wide ? "app wide" : "app narrow"}>
      <header className="topbar">
        <div className="brand">
          <h1>{isOntology ? "Ontology explorer" : "Legislation explorer"}</h1>
          <ToggleButtonGroup
            aria-label="Explore"
            className="graph-mode graph-lens"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[lens]}
            onSelectionChange={(keys) => setLens([...keys][0] as Lens)}
          >
            <ToggleButton id="legislation" className="ghost toggle">
              Legislation
            </ToggleButton>
            <ToggleButton id="ontology" className="ghost toggle">
              Ontologies
            </ToggleButton>
          </ToggleButtonGroup>
        </div>
        {graph && (
          <div className="brand">
            <span className="stat">
              <strong>{graph.requirements.length}</strong>
              {ofTotal(fullGraph?.requirements.length)} data requirements
            </span>
            {isOntology ? (
              ontologyGraph && (
                <>
                  <span className="stat" title="At least one exact or close term">
                    <strong>{answered - partlyAnswered}</strong> answered
                  </span>
                  <span className="stat" title="Only broader or narrower terms">
                    <strong>{partlyAnswered}</strong> partly
                  </span>
                  <span className="stat">
                    <strong>{ontologyGraph.unanswered.size}</strong> unanswered
                  </span>
                  <span className="stat">
                    <strong>{ontologyGraph.ontologies.length}</strong>{" "}
                    {ontologyGraph.ontologies.length === 1 ? "ontology" : "ontologies"}
                  </span>
                  <span className="stat">
                    <strong>{ontologyGraph.edges.reduce((n, e) => n + e.terms.length, 0)}</strong> terms
                  </span>
                </>
              )
            ) : (
              <>
                <span className="stat">
                  <strong>{graph.legislations.length}</strong>
                  {ofTotal(fullGraph?.legislations.length)} compliance targets
                </span>
                <span className="stat">
                  <strong>{graph.edges.length}</strong>
                  {ofTotal(fullGraph?.edges.length)} part-of links
                </span>
              </>
            )}
          </div>
        )}
      </header>

      <p className="hint">
        {!graph
          ? "Import a specification to see its data requirements and the legislation behind them."
          : isOntology
            ? "Each data requirement from the ticked legislations points to the ontologies whose terms answer it. Click a node for its terms, drag to move it, scroll to zoom."
            : "Each data requirement points to the legislation it is part of. Click a node for its provisions, drag to move it, scroll to zoom."}
      </p>

      <main className="graph-board">
        <div className="graph-side">
          <section className="panel graph-spec" aria-labelledby="g-spec-title">
            <header className="panel-head">
              <div>
                <h2 id="g-spec-title">Specification</h2>
                <p>{specs.length ? plural(specs.length, "saved specification") : "None saved yet"}</p>
              </div>
            </header>
            <div className="list">
              <SpecLibrary specs={specs} selectedId={specId} onSpecsChange={setSpecs} onSelect={chooseSpec} />
            </div>
          </section>
          {fullGraph && (
            <LegislationFilter
              legislations={fullGraph.legislations}
              hidden={hidden}
              onHiddenChange={updateHidden}
              notSaved={notSaved}
            />
          )}
        </div>

        <section className="panel graph-panel" aria-labelledby="g-graph-title">
          <header className="panel-head">
            <div className="graph-title">
              <h2 id="g-graph-title" title={spec?.name}>
                {spec?.name ?? "Graph"}
              </h2>
              {drawn && drawn.unlinked.size > 0 && (
                <p>
                  {plural(drawn.unlinked.size, "data requirement")} with{" "}
                  {isOntology ? "no ontology term" : "no legislation named"} (dashed)
                </p>
              )}
            </div>
            {graph && (
              <ToggleButtonGroup
                aria-label="Show as"
                className="graph-mode"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[mode]}
                onSelectionChange={(keys) => setMode([...keys][0] as "graph" | "table")}
              >
                <ToggleButton id="graph" className="ghost toggle">
                  Graph
                </ToggleButton>
                <ToggleButton id="table" className="ghost toggle">
                  Table
                </ToggleButton>
              </ToggleButtonGroup>
            )}
          </header>
          {!graph ? (
            <p className="empty graph-empty">No specification chosen yet.</p>
          ) : graph.legislations.length === 0 ? (
            <p className="empty graph-empty">No legislation ticked. Tick at least one in the Legislations list to see it here.</p>
          ) : !drawn ? (
            <p className="empty graph-empty" role={chainError ? "alert" : "status"}>
              {chainError ? `Couldn't open the ontology catalogue: ${chainError}` : "Loading the ontology catalogue…"}
            </p>
          ) : drawn.requirements.length + drawn.hubs.length === 0 ? (
            <p className="empty graph-empty">The ticked legislations set no data requirement in this specification.</p>
          ) : mode === "graph" ? (
            // A new set of nodes is a new graph: it lays out afresh to use the room it has.
            <GraphCanvas
              key={`${lens}|${spec?.id}@${spec?.savedAt}|${[...hidden].sort().join()}`}
              graph={drawn}
              selected={shownSelected}
              onSelect={setSelected}
            />
          ) : (
            <GraphTable graph={drawn} selected={shownSelected} onSelect={setSelected} />
          )}
        </section>

        <section className="panel" aria-labelledby="g-detail-title">
          <header className="panel-head">
            <div>
              <h2 id="g-detail-title">Details</h2>
              <p>{shownSelected ? "Selected node" : "Nothing selected"}</p>
            </div>
          </header>
          <div className="list graph-details">
            {requirement && isOntology && ontologyGraph ? (
              <RequirementOntologyDetails
                node={requirement}
                graph={ontologyGraph}
                laws={lawsOfSelected}
                onSelect={setSelected}
              />
            ) : requirement && !isOntology && graph ? (
              <RequirementDetails node={requirement} graph={graph} filteredOut={filteredOut} onSelect={setSelected} />
            ) : law && graph ? (
              <LegislationDetails node={law} graph={graph} onSelect={setSelected} />
            ) : ontology && ontologyGraph ? (
              <OntologyDetails node={ontology} graph={ontologyGraph} onSelect={setSelected} />
            ) : (
              <p className="empty">
                {isOntology
                  ? "Select a data requirement or ontology to see the terms that connect them."
                  : "Select a data requirement or legislation to see what connects them."}
              </p>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
