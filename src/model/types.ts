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

export type Confidence = "high" | "medium" | "low";

/** A mapping proposed by the LLM, waiting for the user to accept or reject it. */
export interface Suggestion extends Mapping {
  confidence: Confidence;
  reason: string;
}

export interface NodeRef {
  side: Side;
  nodeId: string;
}

export const otherSide = (side: Side): Side => (side === "left" ? "right" : "left");

/** Anchor ids are namespaced by side so both trees can share one DOM lookup. */
export const anchorId = (side: Side, nodeId: string) => `${side}:${nodeId}`;

/** Drag payload MIME type; each tree only accepts drags from the other one. */
export const dragType = (side: Side) => `application/x-dpp-${side}`;
