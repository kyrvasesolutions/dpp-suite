import { z } from "zod";
import type { Mapping, SourceDoc, TreeData } from "./types";

const TreeNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  meta: z.string().optional(),
  description: z.string().optional(),
  sourceId: z.string().optional(),
  sourceRef: z.string().optional(),
  children: z.array(z.string()).optional(),
});

const TreeDataSchema = z
  .object({
    id: z.string().optional(),
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

const SourceSchema = z.object({ title: z.string(), url: z.string().optional() });

/** Every part is optional so a file can replace just the mappings, or just one tree. */
const ProjectFileSchema = z.object({
  version: z.literal(1).optional(),
  left: TreeDataSchema.optional(),
  right: TreeDataSchema.optional(),
  mappings: z.array(MappingSchema).optional(),
  sources: z.record(z.string(), SourceSchema).optional(),
});

export interface Project {
  left: TreeData;
  right: TreeData;
  mappings: Mapping[];
  sources: Record<string, SourceDoc>;
}

export function exportProject(project: Project) {
  const blob = new Blob([JSON.stringify({ version: 1, ...project }, null, 2)], { type: "application/json" });
  download(blob, "dpp-project.json");
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export type ImportResult = { ok: true; project: Project; summary: string } | { ok: false; error: string };

/** Merge an uploaded JSON file into the current project; mappings that point at missing items are dropped. */
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
  return {
    ok: true,
    project: { left, right, mappings: kept, sources: { ...current.sources, ...parsed.data.sources } },
    summary: importSummary(parsed.data.left, parsed.data.right, kept.length, source.length - kept.length),
  };
}

export function importSummary(left: TreeData | undefined, right: TreeData | undefined, kept: number, dropped: number) {
  const parts = [
    left && `${left.title} (${Object.keys(left.nodes).length - 1} items)`,
    right && `${right.title} (${Object.keys(right.nodes).length - 1} items)`,
    `${kept} mapping${kept === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return `Imported ${parts.join(", ")}${dropped ? `; skipped ${dropped} pointing at unknown items` : ""}.`;
}
