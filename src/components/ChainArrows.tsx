import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** A relation between two elements of different columns, named by their `data-chain` attributes. */
export interface ChainRelation {
  from: string;
  to: string;
  /** A relation that exists but is off the path the user chose. */
  faint?: boolean;
}

interface Arrow {
  key: string;
  d: string;
  faint: boolean;
}

interface Layout {
  width: number;
  height: number;
  arrows: Arrow[];
}

/** Keeps an end inside its column, four pixels from the edge, when its row is scrolled away. */
const COLUMN_INSET = 4;

/**
 * SVG overlay inside the scrolling board, so arrows travel with the columns when it
 * scrolls sideways; a column scrolling up or down redraws them. An arrow whose row
 * is scrolled away ends at that column's edge and turns faint. A row inside a closed
 * panel has no arrow.
 */
export function ChainArrows({
  boardRef,
  relations,
}: {
  boardRef: RefObject<HTMLElement | null>;
  relations: ChainRelation[];
}) {
  const [layout, setLayout] = useState<Layout>({ width: 0, height: 0, arrows: [] });
  const frame = useRef(0);

  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;

    const measure = () => {
      const box = board.getBoundingClientRect();
      const anchors = new Map<string, HTMLElement>();
      board.querySelectorAll<HTMLElement>("[data-chain]").forEach((el) => anchors.set(el.dataset.chain!, el));

      const end = (id: string, edge: "left" | "right") => {
        const el = anchors.get(id);
        // A closed panel keeps its rows' sizes, since it is hidden "until found", so ask it directly.
        if (!el || el.closest("[hidden]")) return null;
        const rect = el.getBoundingClientRect();
        const list = el.closest(".list")?.getBoundingClientRect();
        const top = (list?.top ?? box.top) + COLUMN_INSET;
        const bottom = (list?.bottom ?? box.bottom) - COLUMN_INSET;
        const y = Math.min(Math.max(rect.top + rect.height / 2, top), bottom);
        return {
          x: rect[edge] - box.left + board.scrollLeft,
          y: y - box.top,
          away: rect.bottom <= top || rect.top >= bottom,
        };
      };

      const arrows: Arrow[] = [];
      for (const { from, to, faint } of relations) {
        const a = end(from, "right");
        const z = end(to, "left");
        if (!a || !z) continue;
        const bend = Math.max(16, (z.x - a.x) * 0.5);
        arrows.push({
          key: `${from}>${to}`,
          d: `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${z.x - bend} ${z.y}, ${z.x} ${z.y}`,
          faint: !!faint || a.away || z.away,
        });
      }

      const panels = board.querySelectorAll<HTMLElement>(":scope > .panel");
      const last = panels[panels.length - 1]?.getBoundingClientRect();
      setLayout({
        width: last ? last.right - box.left + board.scrollLeft : 0,
        height: board.clientHeight,
        arrows,
      });
    };

    const schedule = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(measure);
    };

    measure();
    // Scroll events don't bubble, so capture them from every column on the board.
    board.addEventListener("scroll", schedule, { capture: true, passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(board);
    // Rows open, close and appear without the board itself changing size.
    const mutations = new MutationObserver(schedule);
    mutations.observe(board, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden", "data-expanded"],
    });
    return () => {
      board.removeEventListener("scroll", schedule, { capture: true });
      resize.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [boardRef, relations]);

  return (
    <svg className="chain-arrows" width={layout.width} height={layout.height} aria-hidden="true">
      <defs>
        <marker
          id="chain-arrowhead"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="8"
          markerHeight="8"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path className="chain-arrowhead" d="M2 1 L7 4 L2 7" />
        </marker>
      </defs>
      {layout.arrows.map((arrow) => (
        <path
          key={arrow.key}
          className={arrow.faint ? "chain-arrow faint" : "chain-arrow"}
          d={arrow.d}
          markerEnd="url(#chain-arrowhead)"
        />
      ))}
    </svg>
  );
}
