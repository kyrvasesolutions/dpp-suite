import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isSelfOrDescendant, type ParentMap } from "../model/tree";
import { dndId, type Mapping, type Side, type TreeData } from "../model/types";
import type { NodeRef } from "./TraceTree";

interface ConnectorLayerProps {
  boardRef: RefObject<HTMLDivElement | null>;
  mappings: Mapping[];
  trees: Record<Side, TreeData>;
  parents: Record<Side, ParentMap>;
  active: NodeRef | null;
  flashId: string | null;
  /** Anything that changes row layout (expansion, mappings, active item). */
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
  flash: boolean;
  label: string;
}

/**
 * SVG overlay drawing a curve between mapped rows of the two trees. When an
 * end is hidden inside a collapsed folder, the curve attaches to the nearest
 * visible ancestor and parallel curves are merged into one with a count.
 */
export function ConnectorLayer({ boardRef, mappings, trees, parents, active, flashId, layoutKey }: ConnectorLayerProps) {
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
      const cacheKey = `${side}:${nodeId}`;
      if (anchorCache.has(cacheKey)) return anchorCache.get(cacheKey)!;
      let cur: string | undefined = nodeId;
      let found: { id: string; el: HTMLElement } | null = null;
      while (cur && cur !== trees[side].rootId) {
        const el = board.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(dndId(side, cur))}"]`);
        if (el) {
          found = { id: cur, el };
          break;
        }
        cur = parents[side][cur];
      }
      anchorCache.set(cacheKey, found);
      return found;
    };

    const groups = new Map<string, { l: HTMLElement; r: HTMLElement; ms: Mapping[]; rolledUp: boolean }>();
    for (const m of mappings) {
      const l = visibleAnchor("left", m.from);
      const r = visibleAnchor("right", m.to);
      if (!l || !r) continue;
      const key = `${l.id}|${r.id}`;
      const g = groups.get(key) ?? { l: l.el, r: r.el, ms: [], rolledUp: false };
      g.ms.push(m);
      g.rolledUp ||= l.id !== m.from || r.id !== m.to;
      groups.set(key, g);
    }

    const clampY = (rect: DOMRect, list: DOMRect) => {
      const mid = rect.top + rect.height / 2;
      const y = Math.min(Math.max(mid, list.top + 4), list.bottom - 4);
      return { y: y - b.top, offscreen: y !== mid };
    };

    const out: Connector[] = [];
    for (const [key, g] of groups) {
      const lr = g.l.getBoundingClientRect();
      const rr = g.r.getBoundingClientRect();
      const x1 = lists.left.right - b.left;
      const x2 = lists.right.left - b.left;
      const a = clampY(lr, lists.left);
      const z = clampY(rr, lists.right);
      const dx = (x2 - x1) * 0.5;
      const highlighted =
        !!active &&
        g.ms.some((m) =>
          isSelfOrDescendant(active.side === "left" ? m.from : m.to, active.nodeId, parents[active.side]),
        );
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
        highlighted,
        flash: !!flashId && g.ms.some((m) => m.id === flashId),
        label: g.ms
          .map((m) => `${trees.left.nodes[m.from]?.name} → ${trees.right.nodes[m.to]?.name}`)
          .join("\n"),
      });
    }
    // Draw highlighted curves last so they sit on top.
    out.sort((p, q) => Number(p.highlighted) - Number(q.highlighted));
    setConnectors(out);
  }, [boardRef, mappings, trees, parents, active, flashId]);

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
    return () => {
      lists.forEach((l) => l.removeEventListener("scroll", schedule));
      ro.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [boardRef, schedule]);

  const dimOthers = !!active && connectors.some((c) => c.highlighted);

  return (
    <svg className="connectors" aria-hidden="true">
      {connectors.map((c) => {
        const cls = [
          "connector",
          c.rolledUp && "rolled",
          c.offscreen && "offscreen",
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
