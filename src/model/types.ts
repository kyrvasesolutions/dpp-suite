export type Side = "left" | "right";

export interface TreeNode {
  id: string;
  name: string;
  /** Short secondary label, e.g. part number or regulation reference. */
  meta?: string;
  children?: string[];
}

export interface TreeData {
  title: string;
  subtitle: string;
  rootId: string;
  nodes: Record<string, TreeNode>;
}

/** A mapping is always stored left → right, whichever side the drag started on. */
export interface Mapping {
  id: string;
  from: string;
  to: string;
}

export const otherSide = (side: Side): Side => (side === "left" ? "right" : "left");

/** dnd-kit ids are namespaced by side so both trees can share one DndContext. */
export const dndId = (side: Side, nodeId: string) => `${side}:${nodeId}`;

export const parseDndId = (id: string | number): { side: Side; nodeId: string } => {
  const [side, ...rest] = String(id).split(":");
  return { side: side as Side, nodeId: rest.join(":") };
};
