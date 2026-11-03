import { z } from "zod";
import type { Project } from "../model/project";
import { buildParentMap, pathNames } from "../model/tree";
import type { Suggestion, TreeData } from "../model/types";

export const MODEL = "claude-opus-5-5";

const SuggestionsSchema = z.object({
  suggestions: z.array(
    z.object({
      from: z.string().describe("Exact id of the product-structure item"),
      to: z.string().describe("Exact id of the passport requirement"),
      confidence: z.enum(["high", "medium", "low"]),
      reason: z.string().describe("Why this item is evidence for the requirement, at most 20 words"),
    }),
  ),
});

const SYSTEM = `You help map a product's structure to digital product passport (DPP) requirements.
A mapping means the product item (a part, material, firmware or document) is a data source or evidence for the requirement.
Propose only mappings a compliance engineer would accept. Prefer the most specific item on both sides.
Use the exact ids given. Do not repeat existing mappings. Return an empty list if nothing fits.`;

function listTree(tree: TreeData) {
  const parents = buildParentMap(tree);
  return Object.values(tree.nodes)
    .filter((n) => n.id !== tree.rootId)
    .map((n) => {
      const path = pathNames(n.id, tree, parents);
      return `${n.id} | ${[...path, n.name].join(" > ")}${n.meta ? ` | ${n.meta}` : ""}`;
    })
    .join("\n");
}

function buildPrompt(project: Project) {
  const existing = project.mappings.map((m) => `${m.from} -> ${m.to}`).join("\n") || "(none)";
  return `<product_structure title="${project.left.title}">
${listTree(project.left)}
</product_structure>

<passport_requirements title="${project.right.title}">
${listTree(project.right)}
</passport_requirements>

<existing_mappings>
${existing}
</existing_mappings>

Suggest new mappings from product_structure ids to passport_requirements ids.`;
}

export class LlmError extends Error {}

/** Asks Claude for new mappings. Runs in the browser with the user's own key. */
export async function suggestMappings(apiKey: string, project: Project, signal?: AbortSignal): Promise<Suggestion[]> {
  // Loaded on demand so people who never use Claude don't download the SDK.
  const [{ default: Anthropic }, { betaZodOutputFormat }] = await Promise.all([
    import("@anthropic-ai/sdk"),
    import("@anthropic-ai/sdk/helpers/beta/zod"),
  ]);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  try {
    const response = await client.beta.messages.parse(
      {
        model: MODEL,
        max_tokens: 16000,
        // Re-run on Anthropic's recommended model if a safety classifier declines.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: betaZodOutputFormat(SuggestionsSchema) },
        system: SYSTEM,
        messages: [{ role: "user", content: buildPrompt(project) }],
      },
      { signal },
    );

    if (response.stop_reason === "refusal") throw new LlmError("Claude declined this request.");
    if (response.stop_reason === "max_tokens") throw new LlmError("The answer was cut off. Try a smaller project.");
    const parsed = response.parsed_output;
    if (!parsed) throw new LlmError("Claude's answer could not be read. Try again.");

    // Never trust ids blindly: keep only real, new, de-duplicated pairs.
    const existing = new Set(project.mappings.map((m) => `${m.from}|${m.to}`));
    const seen = new Set<string>();
    return parsed.suggestions
      .filter((s) => {
        const key = `${s.from}|${s.to}`;
        const valid =
          project.left.nodes[s.from] &&
          project.right.nodes[s.to] &&
          s.from !== project.left.rootId &&
          s.to !== project.right.rootId &&
          !existing.has(key) &&
          !seen.has(key);
        seen.add(key);
        return valid;
      })
      .map((s, i) => ({ ...s, id: `s${Date.now().toString(36)}${i}` }));
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (error instanceof Anthropic.APIUserAbortError) throw new LlmError("Cancelled.");
    if (error instanceof Anthropic.AuthenticationError) throw new LlmError("The API key was rejected. Check it in Claude settings.");
    if (error instanceof Anthropic.PermissionDeniedError) throw new LlmError("This API key isn't allowed to use this model.");
    if (error instanceof Anthropic.RateLimitError) throw new LlmError("Rate limited by Anthropic. Wait a moment and retry.");
    if (error instanceof Anthropic.APIConnectionError) throw new LlmError("Couldn't reach Anthropic. Check your connection.");
    if (error instanceof Anthropic.APIError) throw new LlmError(`Anthropic API error ${error.status ?? ""}: ${error.message}`);
    throw error;
  }
}
