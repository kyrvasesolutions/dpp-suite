import { z } from "zod";
import type { Project } from "../model/project";
import { buildParentMap, pathNames } from "../model/tree";
import type { Suggestion, TreeData } from "../model/types";

export const MODEL = "claude-opus-5-5";

const SuggestionsSchema = z.object({
  suggestions: z.array(
    z.object({
      from: z.string().describe("Exact id of the product-structure item"),
      to: z.string().describe("Exact id of the data category"),
      confidence: z.enum(["high", "medium", "low"]),
      reason: z.string().describe("Why this item supplies data for the category, at most 20 words"),
    }),
  ),
});

const SYSTEM = `You help map a product's structure to digital product passport (DPP) data categories.
The data categories come from the EU Ecodesign for Sustainable Products Regulation (ESPR); their legal text is included.
A mapping means the product item (a part, material, firmware or document) is a data source or evidence for the data category.
Propose only mappings a compliance engineer would accept. Prefer the most specific item on both sides.
Use the exact ids given. Do not repeat existing mappings. Return an empty list if nothing fits.`;

function listTree(tree: TreeData) {
  const parents = buildParentMap(tree);
  return Object.values(tree.nodes)
    .filter((n) => n.id !== tree.rootId)
    .map((n) => {
      const path = pathNames(n.id, tree, parents);
      const fields = [n.id, [...path, n.name].join(" > "), n.meta, n.description && `text: ${n.description}`];
      return fields.filter(Boolean).join(" | ");
    })
    .join("\n");
}

function buildPrompt(project: Project) {
  const existing = project.mappings.map((m) => `${m.from} -> ${m.to}`).join("\n") || "(none)";
  return `<product_structure title="${project.left.title}">
${listTree(project.left)}
</product_structure>

<data_categories title="${project.right.title}">
${listTree(project.right)}
</data_categories>

<existing_mappings>
${existing}
</existing_mappings>

Suggest new mappings from product_structure ids to data_categories ids.`;
}

export class LlmError extends Error {}

/** Raised, with no network call to any LLM, when the app is connected to the durable server (D8-05, C8-05). */
export class LlmDisabledError extends LlmError {
  override name = "LlmDisabledError";
  constructor() {
    super("Claude suggestions are not available while the app is connected to the DPP server: customer data never leaves it.");
  }
}

/**
 * Claude suggestions send product structure to an external API. The narrow demonstrator allows no
 * network egress (LEAN-DEF-13, criterion C0-07), so they are off unless a build sets VITE_ENABLE_LLM=true.
 * Vite replaces the flag at build time; when it is off the SDK is not bundled at all.
 */
export const LLM_ENABLED = import.meta.env.VITE_ENABLE_LLM === "true";

// Loaded on demand so people who never use Claude don't download the SDK.
const loadSdk = LLM_ENABLED
  ? () => Promise.all([import("@anthropic-ai/sdk"), import("@anthropic-ai/sdk/helpers/beta/zod")])
  : null;

/**
 * True only when it is certain the app is not connected to the durable server. The only request made is to the same
 * origin, never to an LLM host. Any doubt is "a server may be there": an answer of any kind (a 200 JSON health, a 404, an
 * HTML app shell, a proxy error page), a thrown error or a timeout all return false. The only proof of absence is an
 * environment with no network API at all.
 */
export async function provablyNoServer(): Promise<boolean> {
  if (typeof fetch === "undefined") return true;
  try {
    const res = await fetch("/api/health", { headers: { Accept: "application/json" } });
    await res.text().catch(() => "");
  } catch {
    /* an error is not proof of absence */
  }
  return false;
}

/** Asks Claude for new mappings. Runs in the browser with the user's own key. */
export async function suggestMappings(apiKey: string, project: Project, signal?: AbortSignal): Promise<Suggestion[]> {
  // Runtime refusal, whatever VITE_ENABLE_LLM says. Fail closed (F5): the same-origin health probe must PROVE that there is
  // no server; a server answer, a network error, a non-200 status or a non-JSON body all count as server mode.
  if (!(await provablyNoServer())) throw new LlmDisabledError();
  if (!loadSdk) throw new LlmError("Claude suggestions are turned off in this build.");
  const [{ default: Anthropic }, { betaZodOutputFormat }] = await loadSdk();
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
