import { z } from "zod";
import { passportTree, productTree, sampleMappings } from "../data/sample";
import type { Mapping, TreeData } from "./types";

const TreeNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  meta: z.string().optional(),
  children: z.array(z.string()).optional(),
});

const TreeDataSchema = z
  .object({
    title: z.string(),
    subtitle: z.string().default(""),
    rootId: z.string(),
    nodes: z.record(z.string(), TreeNodeSchema),
  })
  .superRefine((tree, ctx) => {
    if (!tree.nodes[tree.rootId]) ctx.addIssue({ code: "custom", message: `rootId "${tree.rootId}" is not in nodes` });
    for (const node of Object.values(tree.nodes)) {
      for (const child of node.children ?? []) {
        if (!tree.nodes[child]) ctx.addIssue({ code: "custom", message: `"${node.id}" lists unknown child "${child}"` });
      }
    }
  });

const MappingSchema = z.object({ id: z.string(), from: z.string(), to: z.string() });

/** Every part is optional so a file can replace just the mappings, or just one tree. */
const ProjectFileSchema = z.object({
  version: z.literal(1).optional(),
  left: TreeDataSchema.optional(),
  right: TreeDataSchema.optional(),
  mappings: z.array(MappingSchema).optional(),
});

export interface Project {
  left: TreeData;
  right: TreeData;
  mappings: Mapping[];
}

export const sampleProject = (): Project => ({ left: productTree, right: passportTree, mappings: sampleMappings });

const STORAGE_KEY = "dpp-trace.project.v2";

export function loadProject(): Project {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = ProjectFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.left && parsed.data.right) {
        return { left: parsed.data.left, right: parsed.data.right, mappings: parsed.data.mappings ?? [] };
      }
    }
  } catch {
    // Storage unavailable or corrupt: fall back to the sample.
  }
  return sampleProject();
}

export function saveProject(project: Project) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...project }));
  } catch {
    // Not persisted; the session still works.
  }
}

export function exportProject(project: Project) {
  const blob = new Blob([JSON.stringify({ version: 1, ...project }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "dpp-project.json";
  a.click();
  URL.revokeObjectURL(url);
}

export type ImportResult = { ok: true; project: Project; summary: string } | { ok: false; error: string };

/** Merge an uploaded file into the current project; mappings that point at missing items are dropped. */
export function importProject(text: string, current: Project): ImportResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "The file is not valid JSON." };
  }
  const parsed = ProjectFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue.path.join(".") || "file"}: ${issue.message}` };
  }
  const { left = current.left, right = current.right, mappings } = parsed.data;
  if (!parsed.data.left && !parsed.data.right && !mappings) {
    return { ok: false, error: "The file has no left, right or mappings field." };
  }
  const source = mappings ?? (parsed.data.left || parsed.data.right ? [] : current.mappings);
  const kept = source.filter((m) => left.nodes[m.from] && right.nodes[m.to]);
  const parts = [
    parsed.data.left && `product tree (${Object.keys(left.nodes).length - 1} items)`,
    parsed.data.right && `requirements (${Object.keys(right.nodes).length - 1} items)`,
    `${kept.length} mapping${kept.length === 1 ? "" : "s"}`,
  ].filter(Boolean);
  const dropped = source.length - kept.length;
  return {
    ok: true,
    project: { left, right, mappings: kept },
    summary: `Imported ${parts.join(", ")}${dropped ? `; skipped ${dropped} pointing at unknown items` : ""}.`,
  };
}
