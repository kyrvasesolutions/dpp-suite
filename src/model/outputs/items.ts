/**
 * Output items (Cycle 4: FUNC-125 export side, criteria C4-01 to C4-03).
 *
 * Turns a projection and the route's pinned output mapping into the values every output carries, in the mapping's
 * order. Items are built from `project()` and nothing else: no function here reads the record, so a value that is
 * not in the projection cannot reach a file. Where a value came from (for lineage) is kept as pointers into the
 * record, never as text, and the public source form is the one the Cycle 3 projection already holds.
 */
import type { PublicSource } from "../derived";
import type { Projection, ProjectedValue } from "../disclosure";
import { decide } from "../policy";
import type { OutputItem, ProfilePack, Route } from "../profile";
import { assess, type HoldReason } from "../readiness";
import type { Assertion, ProductRecord } from "../ingress";
import { project } from "../disclosure";

/** Thrown when an output is asked for a route that is on hold, or for a projection of another route. */
export class RouteRefusedError extends Error {
  override name = "RouteRefusedError";
  constructor(
    readonly route: Route,
    readonly holds: HoldReason[],
    message: string,
  ) {
    super(message);
  }
}

/** Points at one assertion of a record value, by the keys the record itself uses. */
export interface AssertionRef {
  property: string;
  member?: string;
  qualifier?: string;
  /** Position among the assertions of that record value. */
  index: number;
  /** The part of the source object the output reads (for example `method` of a footprint result), when not its value. */
  detail?: string;
}

/**
 * Moves a position in a JSON source from an object's value to one of its other keys: /footprints/0/value becomes
 * /footprints/0/method. A position that is not a JSON pointer (an ERP row and column) is left as it is.
 */
export const detailPosition = (position: string, key: string) => (/(^|, )\//.test(position) ? position.replace(/\/[^/]+$/, `/${key}`) : position);

/**
 * The source of the text one `fields` entry of an output value stands for: the assertion's own place, or, when the text is another
 * key of the source object, that key's place (/footprints/0/calculated_by rather than /footprints/0/value).
 */
export function fieldSource(record: ProductRecord, ref: AssertionRef): Assertion["source"] | undefined {
  const a = record.values.find((v) => v.property === ref.property && v.member === ref.member && v.qualifier === ref.qualifier)?.assertions[ref.index];
  if (!a) return undefined;
  if (!ref.detail) return a.source;
  return { ...a.source, location: `${a.source.file}, ${detailPosition(a.source.location.slice(a.source.file.length + 2), ref.detail)}` };
}

export interface OutputValue {
  step: string;
  role: OutputItem["role"];
  property: string;
  kind: OutputItem["reads"]["kind"];
  label: { en: string; de: string };
  unit?: string;
  format: "number" | "text";
  /** False when the record has no value for it, or only a challenged one (which no output states). */
  present: boolean;
  challenged: boolean;
  /** The text as the sources state it (or the derived statement), the same in the CSV, the JSON and the PDF. */
  text: string;
  /** The same text as lines, one per qualifier, member or statement, for the PDF layout. */
  lines: Array<{ key?: string; text: string }>;
  /** True when `text` is the source's literal number, so a spreadsheet may keep it as a number. */
  numeric: boolean;
  /** The derived rule, for a derived statement. */
  ruleId?: string;
  /** Where the values are, in the public form a recipient may see. */
  sources: PublicSource[];
  /** Where the values are in the record, for lineage. A derived statement has none: lineage asks the derived rule. */
  refs: AssertionRef[];
  /**
   * Every piece of source text the output states, each with the assertion and, when it is not the value, the key of the source
   * object it comes from. A guard that must refuse one piece names exactly that field. A derived statement has none.
   */
  fields: Array<{ ref: AssertionRef; text: string }>;
}

/**
 * Compound cells join parts with `|` and name them with `key=`. So that no value can pass for a separator or another part,
 * `\\` and `|` are written `\\\\` and `\\|` inside every part, and in keys and in the details of a reference also `=`, `(`, `)` and `,`
 * (the characters the layout uses there). A single value in a plain cell is never changed.
 */
export const escapePart = (s: string) => s.replace(/[\\|]/g, "\\$&");
export const escapeKey = (s: string) => s.replace(/[\\|=(),]/g, "\\$&");

const tail = (member: string) => member.replace(/^FLD-[A-Za-z]+-/, "");
const NUMBER = /^-?\d+(\.\d+)?$/;

const source = (v: ProjectedValue, i: number) => v.assertions[i].source;
/** A code that a pinned code list maps (a company code) is shown as what it maps to; every other text is the source's own. */
const shown = (a: ProjectedValue["assertions"][number]) => (typeof a.value === "string" ? a.value : a.raw);

/** The values of the output of `route`, one per mapping item, from the projection only. */
export function buildItems(pack: ProfilePack, projection: Projection): OutputValue[] {
  const info = pack.routes[projection.route];
  const label = new Map(pack.properties.map((p) => [p.id, p.labels]));
  const byProp = new Map<string, ProjectedValue[]>();
  for (const v of projection.values) {
    let bucket = byProp.get(v.property);
    if (!bucket) {
      bucket = [];
      byProp.set(v.property, bucket);
    }
    bucket.push(v);
  }
  return info.output.map((item): OutputValue => {
    // The matrix has the last word, again: an item for a denied property is never read.
    const access = decide(pack, projection.route, item.property);
    const format = item.csv?.format ?? (item.unit ? "number" : "text");
    const base = {
      step: item.step,
      role: item.role,
      property: item.property,
      kind: item.reads.kind,
      label: item.pdf?.label ?? label.get(item.property)!,
      ...(item.unit ? { unit: item.unit } : {}),
      format,
    };
    const absent = (challenged = false): OutputValue => ({ ...base, present: false, challenged, text: "", lines: [], numeric: false, sources: [], refs: [], fields: [] });
    if (access === "deny") return absent();

    if (item.reads.kind === "derived") {
      const d = projection.derived.find((x) => x.property === item.property);
      if (!d) return absent();
      const text = d.text;
      return { ...base, present: true, challenged: false, text, lines: [{ text }], numeric: false, ruleId: d.rule, sources: d.sources, refs: [], fields: [] };
    }

    const own = byProp.get(item.property) ?? [];
    const usable = (v: ProjectedValue) => v.status !== "challenged";
    const refOf = (v: ProjectedValue, index: number): AssertionRef => ({ property: v.property, ...(v.member ? { member: v.member } : {}), ...(v.qualifier ? { qualifier: v.qualifier } : {}), index });

    if (item.reads.kind === "members") {
      const lines: OutputValue["lines"] = [];
      const sources: PublicSource[] = [];
      const refs: AssertionRef[] = [];
      const fields: OutputValue["fields"] = [];
      let challenged = false;
      for (const m of item.reads.members) {
        const v = own.find((x) => x.member === m);
        if (!v) continue;
        if (!usable(v)) {
          challenged = true;
          continue;
        }
        lines.push({ key: tail(m), text: shown(v.assertions[0]) });
        fields.push({ ref: refOf(v, 0), text: shown(v.assertions[0]) });
        sources.push(...v.assertions.map((_, i) => source(v, i)));
        refs.push(...v.assertions.map((_, i) => refOf(v, i)));
      }
      if (!lines.length) return absent(challenged);
      return { ...base, present: true, challenged, text: lines.map((l) => `${escapeKey(l.key!)}=${escapePart(l.text)}`).join("|"), lines, numeric: false, sources, refs, fields };
    }

    if (item.reads.kind === "member") {
      const key = tail(item.reads.member);
      const lines: OutputValue["lines"] = [];
      const sources: PublicSource[] = [];
      const refs: AssertionRef[] = [];
      const fields: OutputValue["fields"] = [];
      let challenged = false;
      for (const v of own.filter((x) => !x.member)) {
        if (!usable(v)) {
          challenged = true;
          continue;
        }
        const text = v.assertions[0].details?.[key];
        if (text === undefined) continue;
        lines.push({ ...(v.qualifier ? { key: v.qualifier } : {}), text });
        const at = source(v, 0);
        sources.push({ ...at, position: detailPosition(at.position, key) });
        refs.push({ ...refOf(v, 0), detail: key });
        fields.push({ ref: { ...refOf(v, 0), detail: key }, text });
      }
      if (!lines.length) return absent(challenged);
      const text = lines.length === 1 ? lines[0].text : lines.map((l) => (l.key ? `${escapeKey(l.key)}=${escapePart(l.text)}` : escapePart(l.text))).join("|");
      return { ...base, present: true, challenged, text, lines, numeric: format === "number" && lines.length === 1 && NUMBER.test(text), sources, refs, fields };
    }

    // value: one value gives its literal text; several (languages, elements, evidence records) give qualifier=text
    // If all assertions live on structured members (e.g. FLD-Identifier-value, FLD-DesignationRef-designation),
    // select the primary value/designation member so single-value mappings read the canonical value cleanly.
    const topLevel = own.filter((x) => !x.member);
    const primaryMembers = own.filter((x) => x.member && /(?:^|-)(?:value|designation|party_id|site_id)$/.test(x.member));
    const candidates = topLevel.length > 0 ? topLevel : primaryMembers.length > 0 ? primaryMembers : own.slice(0, 1);
    const lines: OutputValue["lines"] = [];
    const sources: PublicSource[] = [];
    const refs: AssertionRef[] = [];
    const cells: string[] = [];
    const fields: OutputValue["fields"] = [];
    let challenged = false;
    let numberLike = false;
    for (const v of candidates) {
      if (!usable(v)) {
        challenged = true;
        continue;
      }
      let text = shown(v.assertions[0]);
      const details = item.reads.details ?? [];
      let cell = text;
      if (details.length) {
        const parts = details.map((m) => [tail(m), v.assertions[0].details?.[tail(m)] ?? ""] as const);
        text = `${text} (${parts.map(([k, d]) => `${k}=${d}`).join(", ")})`;
        cell = `${escapeKey(shown(v.assertions[0]))} (${parts.map(([k, d]) => `${k}=${escapeKey(d)}`).join(", ")})`;
      }
      const key = v.qualifier && !details.length ? v.qualifier : undefined;
      lines.push({ ...(key ? { key } : {}), text });
      fields.push({ ref: refOf(v, 0), text: shown(v.assertions[0]) });
      for (const m of details) fields.push({ ref: { ...refOf(v, 0), detail: tail(m) }, text: v.assertions[0].details?.[tail(m)] ?? "" });
      cells.push(key ? `${escapeKey(key)}=${escapePart(cell)}` : details.length ? cell : escapePart(cell));
      sources.push(...v.assertions.map((_, i) => source(v, i)));
      refs.push(...v.assertions.map((_, i) => refOf(v, i)));
      numberLike = typeof v.assertions[0].value === "number";
    }
    if (!lines.length) return absent(challenged);
    const single = lines.length === 1;
    // a single plain value is the source's own text; anything compound has its separators escaped
    // a text property whose values carry qualifiers (language, element) always names them, even for one value
    const keyed = format === "text" && lines.some((l) => l.key);
    const text = single && !(item.reads.details ?? []).length && !keyed ? lines[0].text : cells.join("|");
    // A cell is numeric only when the source's own text is a number: never because a text looks like one by accident
    return { ...base, present: true, challenged, text, lines, numeric: format === "number" && single && numberLike && NUMBER.test(lines[0].text), sources, refs, fields };
  });
}

/** What every output starts from: the projection of the route, refused when the route is on hold. */
export function prepare(
  pack: ProfilePack,
  record: ProductRecord,
  route: Route,
  options: { allowHold?: boolean; language?: "en" | "de"; context?: import("../context").OperationContext } = {},
): { projection: Projection; items: OutputValue[]; holds: HoldReason[] } {
  const readiness = assess(pack, record, {
    routes: [route],
    ...(options.language ? { language: options.language } : {}),
    ...(options.context ? { context: { [route]: options.context } } : {}),
  })[0]!;
  const projection = project(pack, record, route, readiness, {
    ...(options.language ? { language: options.language } : {}),
    ...(options.context ? { context: options.context } : {}),
  });
  const holds = readiness.holds;
  if (projection.route !== route) throw new RouteRefusedError(route, [], `The projection is for ${projection.route}, not ${route}`);
  if (projection.onHold && !options.allowHold) {
    throw new RouteRefusedError(route, holds, `${pack.routes[route].recipient} is on hold, so no file is made: ${holds.map((h) => h.ruleId).join(", ")}`);
  }
  return { projection, items: buildItems(pack, projection), holds };
}
