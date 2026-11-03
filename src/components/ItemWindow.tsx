import { useRef, type CSSProperties, type PointerEvent } from "react";
import { Button, Dialog, Heading } from "react-aria-components";
import { ancestorsOf, endOn, isSelfOrDescendant, pathNames, type ParentMap } from "../model/tree";
import {
  otherSide,
  type Mapping,
  type NodeRef,
  type Side,
  type SourceDoc,
  type Suggestion,
  type TreeData,
} from "../model/types";

export interface WindowState {
  key: string;
  ref: NodeRef;
  x: number;
  y: number;
  z: number;
  closing: boolean;
}

interface ItemWindowProps {
  win: WindowState;
  docked: boolean;
  trees: Record<Side, TreeData>;
  parents: Record<Side, ParentMap>;
  mappings: Mapping[];
  suggestions: Suggestion[];
  sources: Record<string, SourceDoc>;
  isPending: boolean;
  onClose: () => void;
  onRaise: () => void;
  onMove: (x: number, y: number) => void;
  onTogglePending: () => void;
  onReveal: (ref: NodeRef) => void;
  onRemoveMapping: (id: string) => void;
  onAccept: (s: Suggestion) => void;
  onReject: (id: string) => void;
}

export const WINDOW_WIDTH = 320;

/**
 * Pinned details for one item. Floating and draggable by its header on wide
 * screens; docked as a bottom sheet on phones.
 */
export function ItemWindow(props: ItemWindowProps) {
  const { win, docked, trees, parents } = props;
  const { side, nodeId } = win.ref;
  const other = otherSide(side);
  const tree = trees[side];
  const node = tree.nodes[nodeId];
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  if (!node) return null;

  // Folders list everything mapped inside them.
  const inScope = (m: Mapping) => isSelfOrDescendant(endOn(m, side), nodeId, parents[side]);
  const links = props.mappings.filter(inScope);
  const suggestions = props.suggestions.filter(inScope);
  const path = pathNames(nodeId, tree, parents[side]);
  const name = (s: Side, id: string) => trees[s].nodes[id]?.name ?? id;
  // Indicators carry no text of their own; show the provision they are listed under.
  const textNode = [nodeId, ...ancestorsOf(nodeId, parents[side], tree.rootId)]
    .map((id) => tree.nodes[id])
    .find((n) => n?.description);
  const source = node.sourceId ? props.sources[node.sourceId] : undefined;

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (docked || (e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { dx: e.clientX - win.x, dy: e.clientY - win.y };
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    const x = Math.min(Math.max(e.clientX - drag.current.dx, 8), window.innerWidth - WINDOW_WIDTH - 8);
    const y = Math.min(Math.max(e.clientY - drag.current.dy, 8), window.innerHeight - 60);
    props.onMove(x, y);
  };
  const endDrag = () => (drag.current = null);

  const style: CSSProperties | undefined = docked ? undefined : { left: win.x, top: win.y, zIndex: win.z };

  return (
    <div
      className={`item-window${docked ? " docked" : ""}${win.closing ? " closing" : ""}`}
      style={style}
      onPointerDownCapture={props.onRaise}
    >
      <Dialog className="item-dialog" aria-labelledby={`win-title-${win.key}`}>
        <header
          className="window-head"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="window-title">
            {path.length > 0 && <span className="crumbs">{path.join(" / ")}</span>}
            <Heading slot="title" id={`win-title-${win.key}`}>
              {node.name}
            </Heading>
          </div>
          <Button className="ghost icon" aria-label="Close" onPress={props.onClose}>
            ×
          </Button>
        </header>

        <div className="window-body">
          <div className="window-meta">
            <span className={`side-tag ${side}`}>{tree.title}</span>
            {node.meta && <span className="muted">{node.meta}</span>}
          </div>

          {textNode?.description && textNode.id !== tree.rootId && (
            <figure className="legal">
              <blockquote>{textNode.description}</blockquote>
              <figcaption>
                {source?.url ? (
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {node.sourceRef ?? source.title}
                  </a>
                ) : (
                  (node.sourceRef ?? source?.title)
                )}
                {source && <span className="muted"> · {source.title}</span>}
              </figcaption>
            </figure>
          )}

          <h3>Mappings ({links.length})</h3>
          {links.length === 0 ? (
            <p className="empty">None yet. Drag onto the other list, or use Map to….</p>
          ) : (
            <ul className="links">
              {links.map((m) => {
                const ownId = endOn(m, side);
                const otherId = endOn(m, other);
                return (
                  <li key={m.id}>
                    <Button className="link-target" onPress={() => props.onReveal({ side: other, nodeId: otherId })}>
                      {ownId !== nodeId && <span className="via">{name(side, ownId)} →</span>}
                      <span>{name(other, otherId)}</span>
                    </Button>
                    <Button
                      className="ghost icon"
                      aria-label={`Remove mapping to ${name(other, otherId)}`}
                      onPress={() => props.onRemoveMapping(m.id)}
                    >
                      ×
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          {suggestions.length > 0 && (
            <>
              <h3>Suggested by Claude</h3>
              <ul className="suggestion-list">
                {suggestions.map((s) => (
                  <li key={s.id}>
                    <div>
                      <span className={`conf ${s.confidence}`}>{s.confidence}</span> {name(other, endOn(s, other))}
                      <p className="muted small">{s.reason}</p>
                    </div>
                    <div className="suggestion-actions">
                      <Button className="ghost icon ok" aria-label="Accept" onPress={() => props.onAccept(s)}>
                        ✓
                      </Button>
                      <Button className="ghost icon" aria-label="Reject" onPress={() => props.onReject(s.id)}>
                        ×
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <footer className="window-foot">
          <Button className={props.isPending ? "primary on" : "primary"} onPress={props.onTogglePending}>
            {props.isPending ? "Cancel mapping" : "Map to…"}
          </Button>
        </footer>
      </Dialog>
    </div>
  );
}
