import { useMemo } from "react";
import { Tooltip, TooltipTriggerStateContext } from "react-aria-components";
import { endOn, pathNames, type ParentMap } from "../model/tree";
import { otherSide, type Mapping, type NodeRef, type Side, type TreeData } from "../model/types";

interface HoverPreviewProps {
  target: { ref: NodeRef; el: HTMLElement } | null;
  trees: Record<Side, TreeData>;
  parents: Record<Side, ParentMap>;
  mappings: Mapping[];
}

const MAX_LINKS = 4;

// The app decides when the preview shows, so the tooltip gets a fixed "open"
// state instead of React Aria's own hover/focus trigger.
const OPEN_STATE = { isOpen: true, shouldSkipAnimation: false, open() {}, close() {} };

/** Temporary, read-only preview shown while a mouse rests on a row. Touch has no hover, so it never shows there. */
export function HoverPreview({ target, trees, parents, mappings }: HoverPreviewProps) {
  const triggerRef = useMemo(() => ({ current: target?.el ?? null }), [target]);
  if (!target) return null;

  const { side, nodeId } = target.ref;
  const node = trees[side].nodes[nodeId];
  if (!node) return null;
  const other = otherSide(side);
  const links = mappings.filter((m) => endOn(m, side) === nodeId).map((m) => trees[other].nodes[endOn(m, other)]?.name);
  const path = pathNames(nodeId, trees[side], parents[side]);

  return (
    <TooltipTriggerStateContext.Provider value={OPEN_STATE}>
      <Tooltip
        className="hover-preview"
        triggerRef={triggerRef}
        isOpen
        placement={side === "left" ? "end" : "start"}
        offset={10}
      >
        {path.length > 0 && <div className="crumbs">{path.join(" / ")}</div>}
        <strong>{node.name}</strong>
        {node.meta && <span className="muted"> · {node.meta}</span>}
        {links.length > 0 ? (
          <ul className="preview-links">
            {links.slice(0, MAX_LINKS).map((name, i) => (
              <li key={i}>{name}</li>
            ))}
            {links.length > MAX_LINKS && <li className="muted">+{links.length - MAX_LINKS} more</li>}
          </ul>
        ) : (
          <div className="muted small">{node.children?.length ? `${node.children.length} items inside` : "No mappings"}</div>
        )}
        <div className="preview-hint">Click to select and pin</div>
      </Tooltip>
    </TooltipTriggerStateContext.Provider>
  );
}
