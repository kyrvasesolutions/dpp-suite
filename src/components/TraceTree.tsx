import type { CSSProperties } from "react";
import {
  Button,
  Collection,
  Tree,
  TreeItem,
  TreeItemContent,
  isTextDropItem,
  useDragAndDrop,
  type Key,
  type Selection,
} from "react-aria-components";
import type { TreeItemData } from "../model/tree";
import { anchorId, dragType, otherSide, type NodeRef, type Side, type TreeData } from "../model/types";

interface TraceTreeProps {
  side: Side;
  data: TreeData;
  items: TreeItemData[];
  expanded: Set<Key>;
  onExpandedChange: (keys: Set<Key>) => void;
  selected: Set<Key>;
  onSelectionChange: (keys: Set<Key>) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  counts: { direct: Record<string, number>; subtree: Record<string, number> };
  /** Nodes on this side linked to the current selection. */
  related: Set<string>;
  /** Ancestors of `related` nodes, so collapsed folders can show they contain a match. */
  relatedAncestors: Set<string>;
  /** Nodes on this side that have a pending LLM suggestion. */
  suggested: Set<string>;
  pending: NodeRef | null;
  isFiltered: boolean;
  onMapDrop: (sourceIds: string[], targetId: string) => void;
  onHoverStart: (ref: NodeRef, el: HTMLElement) => void;
  onHoverEnd: () => void;
  onDragActive: (active: boolean) => void;
}

export function TraceTree(props: TraceTreeProps) {
  const { side, data, items, counts, related, relatedAncestors, suggested, pending } = props;
  const ownType = dragType(side);
  const acceptType = dragType(otherSide(side));

  const { dragAndDropHooks } = useDragAndDrop<TreeItemData>({
    getItems: (keys) =>
      [...keys].map((key) => ({ [ownType]: String(key), "text/plain": data.nodes[String(key)]?.name ?? String(key) })),
    acceptedDragTypes: [acceptType],
    // Only "drop onto an item of the other tree" is a mapping; no reordering.
    getDropOperation: (target, types) =>
      target.type === "item" && target.dropPosition === "on" && types.has(acceptType) ? "copy" : "cancel",
    onItemDrop: async (e) => {
      const ids = await Promise.all(e.items.filter(isTextDropItem).map((item) => item.getText(acceptType)));
      props.onMapDrop(ids, String(e.target.key));
    },
    onDragStart: () => props.onDragActive(true),
    onDragEnd: () => props.onDragActive(false),
    renderDragPreview: (dragItems) => (
      <div className="drag-chip">{dragItems.length > 1 ? `${dragItems.length} items` : dragItems[0]["text/plain"]}</div>
    ),
  });

  // React Aria caches rendered items by identity; re-render them when these change.
  const deps = [counts, related, relatedAncestors, suggested, pending];

  const renderItem = (item: TreeItemData) => {
    const { id, node } = item;
    const direct = counts.direct[id] ?? 0;
    const inside = (counts.subtree[id] ?? 0) - direct;
    const isFolder = !!node.children?.length;
    // Requirements without any evidence are what a validator cares about.
    const isGap = side === "right" && !isFolder && direct === 0;

    return (
      <TreeItem
        id={id}
        textValue={node.name}
        onHoverStart={(e) => props.onHoverStart({ side, nodeId: id }, e.target)}
        onHoverEnd={props.onHoverEnd}
        className={({ isSelected, isFocusVisible, isExpanded, isDragging }) =>
          [
            "tree-item",
            isFolder && "folder",
            isSelected && "selected",
            isFocusVisible && "focus-visible",
            isDragging && "dragging",
            related.has(id) && "related",
            !isExpanded && relatedAncestors.has(id) && "contains-related",
            pending?.side === side && pending.nodeId === id && "pending",
          ]
            .filter(Boolean)
            .join(" ")
        }
      >
        <TreeItemContent>
          {({ isExpanded, hasChildItems, level, allowsDragging }) => (
            <div className="row" data-anchor={anchorId(side, id)} style={{ "--level": level - 1 } as CSSProperties}>
              {allowsDragging && (
                <Button slot="drag" className="drag-handle" aria-label={`Drag ${node.name}`}>
                  <svg viewBox="0 0 10 16" width="8" height="14" aria-hidden="true">
                    <circle cx="2.5" cy="3" r="1.3" />
                    <circle cx="7.5" cy="3" r="1.3" />
                    <circle cx="2.5" cy="8" r="1.3" />
                    <circle cx="7.5" cy="8" r="1.3" />
                    <circle cx="2.5" cy="13" r="1.3" />
                    <circle cx="7.5" cy="13" r="1.3" />
                  </svg>
                </Button>
              )}
              {hasChildItems ? (
                <Button slot="chevron" className="chevron" data-open={isExpanded}>
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <path
                      d="M6 4l4 4-4 4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </Button>
              ) : (
                <span className={isGap ? "leaf-dot gap" : "leaf-dot"} aria-hidden="true" />
              )}
              <span className="row-text">
                <span className="row-name">{node.name}</span>
                {node.meta && <span className="row-meta">{node.meta}</span>}
              </span>
              {suggested.has(id) && (
                <span className="badge suggest" title="Claude suggested a mapping">
                  ?
                </span>
              )}
              {direct > 0 && (
                <span className="badge" title={`${direct} direct mapping${direct > 1 ? "s" : ""}`}>
                  {direct}
                </span>
              )}
              {hasChildItems && !isExpanded && inside > 0 && (
                <span className="badge rollup" title={`${inside} mapping${inside > 1 ? "s" : ""} inside`}>
                  +{inside}
                </span>
              )}
              {isGap && <span className="gap-label">unmapped</span>}
            </div>
          )}
        </TreeItemContent>
        <Collection items={item.children} dependencies={deps}>
          {renderItem}
        </Collection>
      </TreeItem>
    );
  };

  const toKeySet = (keys: Selection) => (keys === "all" ? new Set<Key>(Object.keys(data.nodes)) : keys);

  return (
    <section className={`panel panel-${side}`} aria-labelledby={`${side}-title`}>
      <header className="panel-head">
        <div>
          <h2 id={`${side}-title`}>{data.title}</h2>
          <p>{props.isFiltered ? "Focused on selection" : data.subtitle}</p>
        </div>
        <div className="panel-tools">
          <Button className="ghost" onPress={props.onExpandAll}>
            Expand
          </Button>
          <Button className="ghost" onPress={props.onCollapseAll}>
            Collapse
          </Button>
        </div>
      </header>
      <div className="list" data-list={side}>
        <Tree
          aria-labelledby={`${side}-title`}
          className="tree"
          items={items}
          dependencies={deps}
          selectionMode="multiple"
          selectionBehavior="replace"
          selectedKeys={props.selected}
          onSelectionChange={(keys) => props.onSelectionChange(toKeySet(keys))}
          expandedKeys={props.expanded}
          onExpandedChange={props.onExpandedChange}
          dragAndDropHooks={dragAndDropHooks}
          renderEmptyState={() => <p className="empty">Nothing to show.</p>}
        >
          {renderItem}
        </Tree>
      </div>
    </section>
  );
}
