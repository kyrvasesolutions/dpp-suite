import type { Mapping, Side, TreeData, TreeNode } from "./types";

export type ParentMap = Record<string, string | undefined>;

export function buildParentMap(data: TreeData): ParentMap {
  const parents: ParentMap = {};
  for (const node of Object.values(data.nodes)) {
    for (const child of node.children ?? []) parents[child] = node.id;
  }
  return parents;
}

/** Ancestors from nearest parent up to (excluding) the hidden root. */
export function ancestorsOf(id: string, parents: ParentMap, rootId: string): string[] {
  const out: string[] = [];
  let cur = parents[id];
  while (cur && cur !== rootId) {
    out.push(cur);
    cur = parents[cur];
  }
  return out;
}

export function isSelfOrDescendant(id: string, ancestorId: string, parents: ParentMap): boolean {
  let cur: string | undefined = id;
  while (cur) {
    if (cur === ancestorId) return true;
    cur = parents[cur];
  }
  return false;
}

/** Node id a mapping touches on the given side. */
export const endOn = (m: Mapping, side: Side) => (side === "left" ? m.from : m.to);

/**
 * Per node: number of mappings attached directly, and number attached anywhere
 * in its subtree (used for the roll-up badge when a folder is collapsed).
 */
export function linkCounts(mappings: Mapping[], side: Side, parents: ParentMap) {
  const direct: Record<string, number> = {};
  const subtree: Record<string, number> = {};
  for (const m of mappings) {
    const id = endOn(m, side);
    direct[id] = (direct[id] ?? 0) + 1;
    let cur: string | undefined = id;
    while (cur) {
      subtree[cur] = (subtree[cur] ?? 0) + 1;
      cur = parents[cur];
    }
  }
  return { direct, subtree };
}

/** Nested shape React Aria's dynamic Tree collection renders. */
export interface TreeItemData {
  id: string;
  node: TreeNode;
  children: TreeItemData[];
}

/**
 * Builds the nested items under the root. With `visible` set, only those ids
 * are kept (callers include ancestors so the path to each item stays intact).
 */
export function nestedItems(data: TreeData, visible?: Set<string>): TreeItemData[] {
  const build = (id: string): TreeItemData | null => {
    const node = data.nodes[id];
    if (!node || (visible && !visible.has(id))) return null;
    const children = (node.children ?? []).map(build).filter((c): c is TreeItemData => c !== null);
    return { id, node, children };
  };
  return (data.nodes[data.rootId]?.children ?? []).map(build).filter((c): c is TreeItemData => c !== null);
}

export function leafIds(data: TreeData): string[] {
  return Object.values(data.nodes)
    .filter((n) => n.id !== data.rootId && !n.children?.length)
    .map((n) => n.id);
}

export function folderIds(data: TreeData): string[] {
  return Object.values(data.nodes)
    .filter((n) => n.id !== data.rootId && n.children?.length)
    .map((n) => n.id);
}

export function pathNames(id: string, data: TreeData, parents: ParentMap): string[] {
  return ancestorsOf(id, parents, data.rootId)
    .reverse()
    .map((a) => data.nodes[a]?.name ?? a);
}
