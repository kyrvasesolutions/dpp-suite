import { useCallback, type Dispatch, type SetStateAction } from "react";
import { hotkeysCoreFeature, syncDataLoaderFeature, type ItemInstance } from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { useDndContext, useDraggable, useDroppable } from "@dnd-kit/core";
import { dndId, parseDndId, type Side, type TreeData, type TreeNode } from "../model/types";

export interface NodeRef {
  side: Side;
  nodeId: string;
}

interface TraceTreeProps {
  side: Side;
  data: TreeData;
  expanded: string[];
  setExpanded: Dispatch<SetStateAction<string[]>>;
  counts: { direct: Record<string, number>; subtree: Record<string, number> };
  active: NodeRef | null;
  pending: NodeRef | null;
  /** Nodes on this side linked to the active item. */
  related: Set<string>;
  /** Ancestors of `related` nodes, so collapsed folders can show they contain a match. */
  relatedAncestors: Set<string>;
  /** "from|to" keys of existing mappings, to flag duplicate drops while dragging. */
  existing: Set<string>;
  onActivate: (ref: NodeRef) => void;
}

export function TraceTree(props: TraceTreeProps) {
  const { side, data, expanded, setExpanded, onActivate } = props;

  const tree = useTree<TreeNode>({
    rootItemId: data.rootId,
    state: { expandedItems: expanded },
    setExpandedItems: setExpanded,
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => !!item.getItemData().children?.length,
    dataLoader: {
      getItem: (id) => data.nodes[id],
      getChildren: (id) => data.nodes[id]?.children ?? [],
    },
    indent: 18,
    features: [syncDataLoaderFeature, hotkeysCoreFeature],
  });

  const allFolders = Object.values(data.nodes)
    .filter((node) => node.id !== data.rootId && node.children?.length)
    .map((node) => node.id);

  return (
    <section className={`panel panel-${side}`} aria-labelledby={`${side}-title`}>
      <header className="panel-head">
        <div>
          <h2 id={`${side}-title`}>{data.title}</h2>
          <p>{data.subtitle}</p>
        </div>
        <div className="panel-tools">
          <button type="button" className="ghost" onClick={() => setExpanded(allFolders)}>
            Expand
          </button>
          <button type="button" className="ghost" onClick={() => setExpanded([])}>
            Collapse
          </button>
        </div>
      </header>
      <div className="list" data-list={side} {...tree.getContainerProps(data.title)}>
        {tree.getItems().map((item) => (
          <Row key={item.getId()} item={item} {...props} onActivate={onActivate} />
        ))}
      </div>
    </section>
  );
}

function Row({
  item,
  side,
  counts,
  active,
  pending,
  related,
  relatedAncestors,
  existing,
  onActivate,
}: TraceTreeProps & { item: ItemInstance<TreeNode> }) {
  const node = item.getItemData();
  const id = dndId(side, node.id);
  const isFolder = item.isFolder();
  const isExpanded = item.isExpanded();
  const level = item.getItemMeta().level;

  const drag = useDraggable({ id, data: { side, nodeId: node.id, name: node.name } });
  const drop = useDroppable({ id, data: { side, nodeId: node.id } });
  const { active: dragActive } = useDndContext();

  const { ref: treeRef, onClick: _ignored, ...treeProps } = item.getProps();
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      treeRef?.(el);
      drag.setNodeRef(el);
      drop.setNodeRef(el);
    },
    // setNodeRef identities are stable per id
    [treeRef, drag.setNodeRef, drop.setNodeRef],
  );

  // Drop feedback: only the opposite tree is a valid target.
  let dropState: "" | "ok" | "dup" = "";
  if (drop.isOver && dragActive) {
    const src = parseDndId(dragActive.id);
    if (src.side !== side) {
      const key = side === "right" ? `${src.nodeId}|${node.id}` : `${node.id}|${src.nodeId}`;
      dropState = existing.has(key) ? "dup" : "ok";
    }
  }

  const direct = counts.direct[node.id] ?? 0;
  const inside = (counts.subtree[node.id] ?? 0) - direct;
  const isActive = active?.side === side && active.nodeId === node.id;
  const isPending = pending?.side === side && pending.nodeId === node.id;
  const isRelated = related.has(node.id);
  const containsRelated = !isExpanded && relatedAncestors.has(node.id);
  // Requirements without any evidence are what a validator cares about.
  const isGap = side === "right" && !isFolder && direct === 0;

  const activate = () => {
    item.setFocused();
    onActivate({ side, nodeId: node.id });
  };

  const toggle = () => (isExpanded ? item.collapse() : item.expand());

  const className = [
    "row",
    isFolder && "folder",
    isActive && "active",
    isPending && "pending",
    isRelated && "related",
    containsRelated && "contains-related",
    drag.isDragging && "dragging",
    dropState && `drop-${dropState}`,
    item.isFocused() && "focused",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      {...treeProps}
      {...drag.listeners}
      ref={setRef}
      className={className}
      data-anchor={id}
      style={{ paddingInlineStart: `calc(var(--row-pad) + ${level} * var(--indent))` }}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
    >
      {isFolder ? (
        <button
          type="button"
          className="chevron"
          tabIndex={-1}
          aria-hidden="true"
          data-open={isExpanded}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : (
        <span className={isGap ? "leaf-dot gap" : "leaf-dot"} aria-hidden="true" />
      )}
      <span className="row-text">
        <span className="row-name">{node.name}</span>
        {node.meta && <span className="row-meta">{node.meta}</span>}
      </span>
      {direct > 0 && (
        <span className="badge" title={`${direct} direct mapping${direct > 1 ? "s" : ""}`}>
          {direct}
        </span>
      )}
      {isFolder && !isExpanded && inside > 0 && (
        <span className="badge rollup" title={`${inside} mapping${inside > 1 ? "s" : ""} inside`}>
          +{inside}
        </span>
      )}
      {isGap && <span className="gap-label">unmapped</span>}
    </div>
  );
}
