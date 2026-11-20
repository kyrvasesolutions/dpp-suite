/**
 * Turns a data requirements specification into a directed graph: data requirements
 * are the core nodes, each with a "part of" edge to the legislation (or other
 * compliance target) that originates it. Several provisions of one act behind a
 * requirement make one edge carrying all of them.
 */
import { forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import type { Chain } from "./chain";
import type { TargetType } from "./legislation";
import type { Ontology, OntologyTerm, TermMatch } from "./ontologies";
import type { Spec, SpecSource } from "./spec";

export interface RequirementNode {
  key: string;
  id: string;
  name: string;
  theme: string;
  standards: string[];
}

export interface LegislationNode {
  key: string;
  label: string;
  title: string;
  ref: string;
  url: string;
  type?: TargetType;
  requirementCount: number;
}

export interface PartOfEdge {
  key: string;
  requirement: string;
  legislation: string;
  sources: SpecSource[];
}

export interface SpecGraph {
  requirements: RequirementNode[];
  legislations: LegislationNode[];
  edges: PartOfEdge[];
  /** Requirements whose sources name no legislation, so they have no edge. */
  unattributed: Set<string>;
}

const normal = (name: string) => name.trim().toLowerCase();

export function buildSpecGraph(spec: Spec): SpecGraph {
  const legislations = new Map<string, LegislationNode>();
  const byName = new Map<string, LegislationNode>();

  for (const l of spec.legislations) {
    const key = `law:${l.id}`;
    if (legislations.has(key)) continue;
    const node: LegislationNode = {
      key,
      label: l.short || l.title || l.ref || l.id,
      title: l.title,
      ref: l.ref,
      url: l.url,
      type: l.type,
      requirementCount: 0,
    };
    legislations.set(key, node);
    for (const name of [l.id, l.short, l.title, l.ref]) if (name) byName.set(normal(name), node);
  }

  /** The legislation a source comes from; a hand-written spec may name one it doesn't list. */
  const originOf = (source: SpecSource) => {
    const known = byName.get(normal(source.legislation)) ?? byName.get(normal(source.act));
    if (known) return known;
    const name = source.legislation.trim() || source.act.trim();
    if (!name) return null;
    const node: LegislationNode = {
      key: `law:named:${normal(name)}`,
      label: name,
      title: "",
      ref: source.act,
      url: "",
      requirementCount: 0,
    };
    legislations.set(node.key, node);
    byName.set(normal(name), node);
    return node;
  };

  const requirements = new Map<string, RequirementNode>();
  const edges = new Map<string, PartOfEdge>();

  for (const r of spec.dataRequirements) {
    const key = `req:${r.id}`;
    const known = requirements.get(key);
    if (known) known.standards = [...new Set([...known.standards, ...r.standards])];
    else requirements.set(key, { key, id: r.id, name: r.name, theme: r.theme, standards: r.standards });

    for (const source of r.sources) {
      const origin = originOf(source);
      if (!origin) continue;
      const edgeKey = `${key}->${origin.key}`;
      const edge = edges.get(edgeKey);
      if (edge) edge.sources.push(source);
      else {
        edges.set(edgeKey, { key: edgeKey, requirement: key, legislation: origin.key, sources: [source] });
        origin.requirementCount += 1;
      }
    }
  }

  const connected = new Set([...edges.values()].map((e) => e.requirement));
  return {
    requirements: [...requirements.values()],
    legislations: [...legislations.values()],
    edges: [...edges.values()],
    unattributed: new Set([...requirements.keys()].filter((key) => !connected.has(key))),
  };
}

/**
 * The graph without these legislations, and without any requirement that leaves
 * with no edge. A requirement naming no legislation is part of none of those still
 * chosen, so it only shows while nothing is filtered out.
 */
export function filterGraph(graph: SpecGraph, hidden: Set<string>): SpecGraph {
  if (hidden.size === 0) return graph;
  const edges = graph.edges.filter((e) => !hidden.has(e.legislation));
  const connected = new Set(edges.map((e) => e.requirement));
  return {
    requirements: graph.requirements.filter((r) => connected.has(r.key)),
    legislations: graph.legislations.filter((l) => !hidden.has(l.key)),
    edges,
    unattributed: new Set(),
  };
}

// ---------- Ontologies ----------

export interface OntologyNode extends Ontology {
  key: string;
  requirementCount: number;
}

export interface TermLink {
  term: OntologyTerm;
  match: TermMatch;
  note?: string;
}

export interface AnsweredByEdge {
  key: string;
  requirement: string;
  ontology: string;
  terms: TermLink[];
}

export interface OntologyGraph {
  requirements: RequirementNode[];
  ontologies: OntologyNode[];
  edges: AnsweredByEdge[];
  /** Requirements no ontology term covers. */
  unanswered: Set<string>;
}

const MATCH_ORDER: TermMatch[] = ["exact", "close", "broad", "narrow"];

/**
 * The ontologies whose terms answer these data requirements. A specification doesn't
 * record them, so they come from the catalogue, by the requirement's id, or its name
 * for a hand-written one with ids of its own.
 */
export function buildOntologyGraph(chain: Chain, requirements: RequirementNode[]): OntologyGraph {
  const known = new Set(chain.dataRequirements.map((d) => d.id));
  const idByName = new Map(chain.dataRequirements.map((d) => [normal(d.name), d.id]));
  const terms = new Map(chain.ontologyTerms.map((t) => [t.id, t]));
  const edges = new Map<string, AnsweredByEdge>();

  for (const r of requirements) {
    const catalogueId = known.has(r.id) ? r.id : idByName.get(normal(r.name));
    for (const link of chain.requirementTerms) {
      if (link.dataRequirement !== catalogueId) continue;
      const term = terms.get(link.term);
      if (!term) continue;
      const key = `${r.key}->ont:${term.ontology}`;
      const edge = edges.get(key) ?? { key, requirement: r.key, ontology: `ont:${term.ontology}`, terms: [] };
      edge.terms.push({ term, match: link.match, note: link.note });
      edges.set(key, edge);
    }
  }

  const all = [...edges.values()];
  for (const edge of all) edge.terms.sort((a, b) => MATCH_ORDER.indexOf(a.match) - MATCH_ORDER.indexOf(b.match));
  const answered = new Set(all.map((e) => e.requirement));
  return {
    requirements,
    ontologies: chain.ontologies
      .map((o) => ({
        ...o,
        key: `ont:${o.id}`,
        requirementCount: all.filter((e) => e.ontology === `ont:${o.id}`).length,
      }))
      .filter((o) => o.requirementCount > 0),
    edges: all,
    unanswered: new Set(requirements.map((r) => r.key).filter((key) => !answered.has(key))),
  };
}

// ---------- What the canvas and table draw ----------

export type Lens = "legislation" | "ontology";

/** A node the data requirements point at: a legislation or an ontology. */
export interface GraphHub {
  key: string;
  label: string;
  title: string;
  subtitle: string;
  radius: number;
  count: number;
  type?: TargetType;
}

export interface GraphLink {
  key: string;
  requirement: string;
  hub: string;
  /** Provisions or terms behind the link. */
  weight: number;
  /** Only a partial answer: no term matches better than broader or narrower. */
  partial: boolean;
}

export interface HubGraph {
  lens: Lens;
  requirements: RequirementNode[];
  hubs: GraphHub[];
  links: GraphLink[];
  /** Requirements with no link, drawn dashed. */
  unlinked: Set<string>;
}

export const legislationHubGraph = (graph: SpecGraph): HubGraph => ({
  lens: "legislation",
  requirements: graph.requirements,
  hubs: graph.legislations.map((l) => ({
    key: l.key,
    label: l.label,
    title: l.title || l.label,
    subtitle: l.ref || l.title,
    radius: legislationRadius(l.requirementCount),
    count: l.requirementCount,
    type: l.type,
  })),
  links: graph.edges.map((e) => ({
    key: e.key,
    requirement: e.requirement,
    hub: e.legislation,
    weight: e.sources.length,
    partial: false,
  })),
  unlinked: graph.unattributed,
});

export const ontologyHubGraph = (graph: OntologyGraph): HubGraph => ({
  lens: "ontology",
  requirements: graph.requirements,
  hubs: graph.ontologies.map((o) => ({
    key: o.key,
    label: o.name,
    title: o.name,
    subtitle: o.description,
    radius: ontologyRadius(o.requirementCount),
    count: o.requirementCount,
  })),
  links: graph.edges.map((e) => ({
    key: e.key,
    requirement: e.requirement,
    hub: e.ontology,
    weight: e.terms.length,
    partial: e.terms.every((t) => t.match === "broad" || t.match === "narrow"),
  })),
  unlinked: graph.unanswered,
});

// ---------- Layout ----------

export const REQUIREMENT_WIDTH = 148;
export const REQUIREMENT_HEIGHT = 44;

/** A legislation's circle grows with the data requirements that are part of it. */
const legislationRadius = (requirementCount: number) => 32 + 3.5 * Math.sqrt(requirementCount);

/** Room inside the hexagon for an ontology's longer name. */
const ontologyRadius = (requirementCount: number) => 46 + 3 * Math.sqrt(requirementCount);

export type Positions = Record<string, { x: number; y: number }>;

interface SimNode {
  id: string;
  /** Half the node's width and height, gap included. */
  halfW: number;
  halfH: number;
  x?: number;
  y?: number;
}

/**
 * Keeps nodes apart by the ellipses around their boxes, so a wide pill gets room to
 * its sides without wasting any above and below, and pushes spread both ways.
 * `reach` is how far apart to hold them: above 1 clears the boxes' corners too.
 */
function separateNodes(nodes: SimNode[], reach: number) {
  return () => {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const spanX = a.halfW + b.halfW;
        const spanY = a.halfH + b.halfH;
        // Exactly coincident nodes still need a direction to part in.
        const dx = (b.x ?? 0) - (a.x ?? 0) || 1e-3;
        const dy = (b.y ?? 0) - (a.y ?? 0);
        const distance = Math.hypot(dx / spanX, dy / spanY);
        if (distance >= reach) continue;
        const push = (reach - distance) / distance / 2;
        a.x = (a.x ?? 0) - dx * push;
        a.y = (a.y ?? 0) - dy * push;
        b.x = (b.x ?? 0) + dx * push;
        b.y = (b.y ?? 0) + dy * push;
      }
    }
  };
}

/** A force layout, run to rest up front. It is seeded, so one graph always lays out the same way. */
export function layoutGraph(graph: HubGraph): Positions {
  const nodes: SimNode[] = [
    ...graph.requirements.map((r) => ({
      id: r.key,
      halfW: REQUIREMENT_WIDTH / 2 + 8,
      halfH: REQUIREMENT_HEIGHT / 2 + 10,
    })),
    ...graph.hubs.map((h) => ({ id: h.key, halfW: h.radius + 14, halfH: h.radius + 14 })),
  ];
  const links = graph.links.map((l) => ({ source: l.requirement, target: l.hub }));
  const separate = separateNodes(nodes, 1.15);
  forceSimulation(nodes)
    .force("link", forceLink<SimNode, (typeof links)[number]>(links).id((n) => n.id).distance(110))
    // Only near neighbours repel, so legislations sharing little don't drift far apart.
    .force("charge", forceManyBody().strength(-200).distanceMax(320))
    // Wide pills spread sideways on their own, so hold them in harder that way.
    .force("x", forceX(0).strength(0.1))
    .force("y", forceY(0).strength(0.04))
    .force("separate", separate)
    .stop()
    .tick(400);
  // The other forces are done: settle what they left touching.
  for (let i = 0; i < 20; i++) separate();
  return Object.fromEntries(nodes.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
}

/** The corners of a hexagon with flat top and bottom, as an SVG `points` list. */
export const hexagonPoints = (radius: number) =>
  [0, 1, 2, 3, 4, 5]
    .map((i) => `${radius * Math.cos((i * Math.PI) / 3)},${radius * Math.sin((i * Math.PI) / 3)}`)
    .join(" ");

/** How far from a hub's centre its outline lies in this direction. */
export function hubReach(hub: GraphHub, lens: Lens, dx: number, dy: number) {
  if (lens === "legislation") return hub.radius;
  const sector = Math.PI / 3;
  const angle = ((Math.atan2(dy, dx) % sector) + sector) % sector;
  return (hub.radius * Math.cos(sector / 2)) / Math.cos(angle - sector / 2);
}

// ---------- Labels and links ----------

/** Breaks a name into lines of up to `width` characters, ending in "…" if it doesn't fit in `lines`. */
export function wrapLabel(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) line = next;
    else {
      if (line) out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  const kept = out.slice(0, lines).map((l) => (l.length > width ? `${l.slice(0, width - 1)}…` : l));
  if (out.length > lines) kept[lines - 1] = `${kept[lines - 1].slice(0, width - 1).trimEnd()}…`;
  return kept;
}

/** A specification can be written by hand: only ever link to the web from one. */
export const webUrl = (url: string) => (/^https?:\/\//i.test(url.trim()) ? url.trim() : null);
