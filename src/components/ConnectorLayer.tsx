import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ParentMap } from "../model/tree";
import { anchorId, type Mapping, type Side, type Suggestion, type TreeData } from "../model/types";

interface ConnectorLayerProps {
  boardRef: RefObject<HTMLDivElement | null>;
  mappings: Mapping[];
  suggestions: Suggestion[];
  /** Mapping ids touching the current selection. */
  highlighted: Set<string>;
  trees: Record<Side, TreeData>;
  parents: Record<Side, ParentMap>;
  flashId: string | null;
  /** Anything that changes row layout (expansion, filtering, selection). */
  layoutKey: unknown;
}

interface Connector {
  key: string;
  d: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  count: number;
  rolledUp: boolean;
  offscreen: boolean;
  highlighted: boolean;
  suggested: boolean;
  flash: boolean;
  label: string;
}

/**
 * SVG overlay drawing a curve between mapped rows of the two trees. When an
 * end is hidden inside a collapsed folder, the curve attaches to the nearest
 * visible ancestor and parallel curves are merged into one with a count.
 */
export function ConnectorLayer(props: ConnectorLayerProps) {
  const { boardRef, mappings, suggestions, highlighted, trees, parents, flashId, layoutKey } = props;
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const frame = useRef(0);

  const measure = useCallback(() => {
    const board = boardRef.current;
    if (!board) return;
    const b = board.getBoundingClientRect();
    const lists = {
      left: board.querySelector<HTMLElement>('[data-list="left"]')?.getBoundingClientRect(),
      right: board.querySelector<HTMLElement>('[data-list="right"]')?.getBoundingClientRect(),
    };
    if (!lists.left || !lists.right) return;

    const anchorCache = new Map<string, { id: string; el: HTMLElement } | null>();
    const visibleAnchor = (side: Side, nodeId: string) => {
      const cacheKey = anchorId(side, nodeId);
      if (anchorCache.has(cacheKey)) return anchorCache.get(cacheKey)!;
      let cur: string | undefined = nodeId;
      let found: { id: string; el: HTMLElement } | null = null;
      while (cur && cur !== trees[side].rootId) {
        const el = board.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(anchorId(side, cur))}"]`);
        if (el) {
          found = { id: cur, el };
          break;
        }
        cur = parents[side][cur];
      }
      anchorCache.set(cacheKey, found);
      return found;
    };

    type Group = { l: HTMLElement; r: HTMLElement; ms: Mapping[]; rolledUp: boolean; suggested: boolean };
    const groups = new Map<string, Group>();
    const add = (m: Mapping, suggested: boolean) => {
      const l = visibleAnchor("left", m.from);
      const r = visibleAnchor("right", m.to);
      if (!l || !r) return;
      const key = `${suggested ? "s" : "m"}|${l.id}|${r.id}`;
      const g = groups.get(key) ?? { l: l.el, r: r.el, ms: [], rolledUp: false, suggested };
      g.ms.push(m);
      g.rolledUp ||= l.id !== m.from || r.id !== m.to;
      groups.set(key, g);
    };
    mappings.forEach((m) => add(m, false));
    suggestions.forEach((s) => add(s, true));

    const clampY = (rect: DOMRect, list: DOMRect) => {
      const mid = rect.top + rect.height / 2;
      const y = Math.min(Math.max(mid, list.top + 4), list.bottom - 4);
      return { y: y - b.top, offscreen: y !== mid };
    };

    const out: Connector[] = [];
    for (const [key, g] of groups) {
      const x1 = lists.left.right - b.left;
      const x2 = lists.right.left - b.left;
      const a = clampY(g.l.getBoundingClientRect(), lists.left);
      const z = clampY(g.r.getBoundingClientRect(), lists.right);
      const dx = (x2 - x1) * 0.5;
      out.push({
        key,
        d: `M ${x1} ${a.y} C ${x1 + dx} ${a.y}, ${x2 - dx} ${z.y}, ${x2} ${z.y}`,
        x1,
        y1: a.y,
        x2,
        y2: z.y,
        count: g.ms.length,
        rolledUp: g.rolledUp,
        offscreen: a.offscreen || z.offscreen,
        highlighted: g.ms.some((m) => highlighted.has(m.id)),
        suggested: g.suggested,
        flash: !!flashId && g.ms.some((m) => m.id === flashId),
        label: g.ms
          .map((m) => `${g.suggested ? "Suggested: " : ""}${trees.left.nodes[m.from]?.name} → ${trees.right.nodes[m.to]?.name}`)
          .join("\n"),
      });
    }
    // Draw highlighted curves last so they sit on top.
    out.sort((p, q) => Number(p.highlighted) - Number(q.highlighted));
    setConnectors(out);
  }, [boardRef, mappings, suggestions, highlighted, trees, parents, flashId]);

  const schedule = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(measure);
  }, [measure]);

  useLayoutEffect(measure, [measure, layoutKey]);

  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const lists = board.querySelectorAll<HTMLElement>("[data-list]");
    lists.forEach((l) => l.addEventListener("scroll", schedule, { passive: true }));
    const ro = new ResizeObserver(schedule);
    ro.observe(board);
    lists.forEach((l) => ro.observe(l));
    // Rows animate in and React Aria renders the collection after mount, so
    // also re-measure when the trees' DOM changes.
    const mo = new MutationObserver(schedule);
    lists.forEach((l) => mo.observe(l, { childList: true, subtree: true }));
    return () => {
      lists.forEach((l) => l.removeEventListener("scroll", schedule));
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [boardRef, schedule]);

  const dimOthers = connectors.some((c) => c.highlighted);

  return (
    <svg className="connectors" aria-hidden="true">
      {connectors.map((c) => {
        const cls = [
          "connector",
          c.rolledUp && "rolled",
          c.offscreen && "offscreen",
          c.suggested && "suggested",
          c.highlighted && "hl",
          dimOthers && !c.highlighted && "dim",
          c.flash && "flash",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <g key={c.key} className={cls}>
            <title>{c.label}</title>
            <path d={c.d} className="connector-hit" />
            <path d={c.d} className="connector-line" style={{ strokeWidth: Math.min(1.5 + c.count * 0.75, 5) }} />
            <circle cx={c.x1} cy={c.y1} r={3} className="connector-end" />
            <circle cx={c.x2} cy={c.y2} r={3} className="connector-end" />
            {c.count > 1 && (
              <g transform={`translate(${(c.x1 + c.x2) / 2} ${(c.y1 + c.y2) / 2})`} className="connector-count">
                <rect x={-10} y={-9} width={20} height={18} rx={9} />
                <text dy="0.35em">{c.count}</text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
