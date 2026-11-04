/**
 * A saved data requirements specification: the product group and legislations
 * chosen in the Requirements tab, the data requirements they set, and the sources
 * (provisions, standards) behind each. Exporting writes it to a YAML file and
 * keeps a copy in this browser, which is what the Mapping tab offers to map to.
 */
import { parse } from "yaml";
import { z } from "zod";
import { linksBehind, type Chain } from "./chain";
import { THEMES, eurLex, SOURCE_ACTS, type ProductGroup, type Provision } from "./legislation";

export interface SpecSource {
  legislation: string;
  /** The act the provision sits in, e.g. "Regulation (EU) 2024/1781". */
  act: string;
  provision: string;
  url: string;
  summary: string;
  quotes?: string[];
}

export interface SpecRequirement {
  id: string;
  name: string;
  theme: string;
  sources: SpecSource[];
  standards: string[];
}

export interface Spec {
  version: 1;
  id: string;
  name: string;
  savedAt: string;
  productGroup: ProductGroup;
  productGroupName: string;
  legislations: Array<{ id: string; short: string; title: string; ref: string; url: string }>;
  dataRequirements: SpecRequirement[];
}

export function buildSpec(
  chain: Chain,
  group: ProductGroup,
  selected: Set<string>,
  required: Map<string, Provision[]>,
): Spec {
  const laws = chain.legislations.filter((l) => selected.has(l.id));
  const groupName = chain.productGroups.find((g) => g.id === group)?.name ?? group;
  const themeOrder: string[] = THEMES.map((t) => t.id);
  const requirements = chain.dataRequirements
    .filter((d) => required.has(d.id))
    .sort((a, b) => themeOrder.indexOf(a.theme) - themeOrder.indexOf(b.theme))
    .map((d): SpecRequirement => {
      const provisions = required.get(d.id) ?? [];
      const standards = new Set<string>();
      for (const law of new Set(provisions.map((p) => p.legislation))) {
        for (const link of linksBehind(chain, law, d.id)) {
          const standard = chain.standards[link.standard];
          if (standard) standards.add(standard.ref);
        }
      }
      return {
        id: d.id,
        name: d.name,
        theme: THEMES.find((t) => t.id === d.theme)?.name ?? d.theme,
        sources: provisions.map((p) => {
          const law = chain.legislationById[p.legislation];
          return {
            legislation: law.short,
            act: (p.source && SOURCE_ACTS[p.source]?.ref) || law.ref,
            provision: p.ref,
            url: eurLex(p.source ?? law.celex),
            summary: p.text,
            ...(p.quotes?.length ? { quotes: p.quotes } : {}),
          };
        }),
        standards: [...standards],
      };
    });
  return {
    version: 1,
    id: `${group}-${laws.map((l) => l.id).sort().join("+")}`,
    name: `${groupName} · ${laws.map((l) => l.short).join(" + ")}`,
    savedAt: new Date().toISOString(),
    productGroup: group,
    productGroupName: groupName,
    legislations: laws.map((l) => ({ id: l.id, short: l.short, title: l.title, ref: l.ref, url: eurLex(l.celex) })),
    dataRequirements: requirements,
  };
}

// ---------- YAML ----------

const PLAIN = /^[A-Za-z][A-Za-z0-9 ._/()+,&-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|y|n)$/i;

function scalar(value: unknown): string {
  if (typeof value !== "string") return String(value);
  const plain = PLAIN.test(value) && !RESERVED.test(value) && !/\s$/.test(value);
  return plain ? value : JSON.stringify(value);
}

function emit(value: unknown, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const [first, ...rest] = emit(item, indent + 2);
        return [`${pad}- ${first.slice(indent + 2)}`, ...rest];
      }
      return [`${pad}- ${scalar(item)}`];
    });
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) => {
    if (Array.isArray(v) && v.length === 0) return [`${pad}${key}: []`];
    if (v !== null && typeof v === "object") return [`${pad}${key}:`, ...emit(v, indent + 2)];
    return [`${pad}${key}: ${scalar(v)}`];
  });
}

/** Block-style YAML; strings that are not plainly safe are written double-quoted (JSON strings are valid YAML). */
export function toYaml(value: unknown): string {
  return emit(value, 0).join("\n") + "\n";
}

export const specFilename = (spec: Spec) => `data-requirements-${spec.id.replace(/[^a-z0-9+-]/gi, "-")}.yaml`;

// ---------- Reading a specification back ----------

const SourceSchema = z.object({
  legislation: z.string().default(""),
  act: z.string().default(""),
  provision: z.string().default(""),
  url: z.string().default(""),
  summary: z.string().default(""),
  quotes: z.array(z.string()).optional(),
});

const SpecSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "needs a name"),
  savedAt: z.string().optional(),
  productGroup: z.string().default("aluminium"),
  productGroupName: z.string().optional(),
  legislations: z
    .array(
      z.object({
        id: z.string(),
        short: z.string().default(""),
        title: z.string().default(""),
        ref: z.string().default(""),
        url: z.string().default(""),
      }),
    )
    .default([]),
  dataRequirements: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        theme: z.string().default("Other"),
        sources: z.array(SourceSchema).default([]),
        standards: z.array(z.string()).default([]),
      }),
    )
    .min(1, "needs at least one data requirement"),
});

export type ParsedSpec = { ok: true; spec: Spec } | { ok: false; error: string };

/** Reads a specification from YAML text (as exported, or written by hand). */
export function parseSpec(text: string): ParsedSpec {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return { ok: false, error: `Not valid YAML: ${e instanceof Error ? e.message.split("\n")[0] : "can't be read"}` };
  }
  if (doc === null || typeof doc !== "object") return { ok: false, error: "The YAML is empty or not a specification." };
  const result = SpecSchema.safeParse(doc);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { ok: false, error: `${issue.path.join(".") || "specification"}: ${issue.message}` };
  }
  const d = result.data;
  const slug = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    ok: true,
    spec: {
      version: 1,
      id: d.id ?? `imported-${slug}`,
      name: d.name,
      savedAt: d.savedAt ?? new Date().toISOString(),
      productGroup: d.productGroup as ProductGroup,
      productGroupName: d.productGroupName ?? d.productGroup,
      legislations: d.legislations,
      dataRequirements: d.dataRequirements,
    },
  };
}

// ---------- Storage in this browser ----------

const SPECS_KEY = "dpp-trace.specs";
const MAPPINGS_KEY = "dpp-trace.spec-mappings";

function read<T>(key: string, fallback: T): T {
  try {
    const text = localStorage.getItem(key);
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked or full: the change lasts until the page closes.
  }
}

export const loadSpecs = (): Spec[] => read<Spec[]>(SPECS_KEY, []);

/** Saves a spec, replacing one with the same id (same group and legislations). Returns the new list, newest first. */
export function saveSpec(spec: Spec): Spec[] {
  const next = [spec, ...loadSpecs().filter((s) => s.id !== spec.id)];
  write(SPECS_KEY, next);
  return next;
}

export function deleteSpec(id: string): Spec[] {
  const next = loadSpecs().filter((s) => s.id !== id);
  write(SPECS_KEY, next);
  const all = read<Record<string, unknown>>(MAPPINGS_KEY, {});
  delete all[id];
  write(MAPPINGS_KEY, all);
  return next;
}

/** Source field path → data requirement id, per spec. */
export type FieldMapping = Record<string, string>;

export const loadMapping = (specId: string): FieldMapping =>
  read<Record<string, FieldMapping>>(MAPPINGS_KEY, {})[specId] ?? {};

export function saveMapping(specId: string, mapping: FieldMapping) {
  write(MAPPINGS_KEY, { ...read<Record<string, FieldMapping>>(MAPPINGS_KEY, {}), [specId]: mapping });
}
