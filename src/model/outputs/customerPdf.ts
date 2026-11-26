/**
 * The customer PDF (Cycle 4: FUNC-043 slice, criteria C4-01 and C4-09; decision D4-01).
 *
 * One fixed A4 layout, drawn with pdf-lib and the standard Helvetica fonts, so no font file is embedded. It contains only
 * what the projection of the customer route holds, in the order of the pinned mapping: a header with the product name
 * and identifiers, the sections with English labels and German labels in a second column, derived statements with their
 * basis and rule ID, the footprint with its method and context, the source of each value in the public form (kind of file
 * and position, never a file name), and a footer with the record version and digest and the pack manifest digest.
 *
 * Deterministic: the document is made with `updateMetadata: false` and no dates, so there is no producer or date
 * metadata, and the same inputs give the same bytes. Text is limited to the WinAnsi character set: a few characters
 * outside it get fixed ASCII spellings, and any other character refuses the file with the rule RR-PDF-CHARACTER, naming the
 * value. A route on hold is refused too: no PDF is made.
 *
 * Nothing is ever cut off: every line of every text is drawn, the page is broken line by line (titles and sources
 * included), and no line is drawn below the footer's top margin.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { OperationContext } from "../context";
import { buildLineage } from "../lineage";
import { byRole, type ProductRecord } from "../ingress";
import type { ProfilePack, Route } from "../profile";
import type { HoldReason } from "../readiness";
import { fieldSource, prepare, RouteRefusedError, type OutputValue } from "./items";
import { safeName, type OutputFile } from "./types";

const ROUTE: Route = "customer";

export class PdfTextError extends Error {
  override name = "PdfTextError";
  constructor(
    message: string,
    /** The first character the font lacks, as U+XXXX. */
    readonly codePoint: string,
  ) {
    super(message);
  }
}

/** Characters outside WinAnsi that the layout spells in ASCII, fixed and in this order. */
const ASCII_SPELLING: Array<[string, string]> = [
  ["CO₂e", "CO2e"],
  ["≤", "<="],
  ["≥", ">="],
  ["₂", "2"],
  ["−", "-"],
];
// ASCII, Latin-1 above NBSP, and the cp1252 extras WinAnsi has at 0x80-0x9F
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const isWinAnsi = (c: string) => {
  const n = c.codePointAt(0)!;
  return (n >= 0x20 && n <= 0x7e) || (n >= 0xa0 && n <= 0xff) || WIN_ANSI_EXTRA.has(c);
};

/** Text as the PDF font can draw it: fixed ASCII spellings first, then a stop at any character WinAnsi lacks. */
export function winAnsi(text: string): string {
  let out = text.replace(/[\r\n\t]+/g, " ");
  for (const [from, to] of ASCII_SPELLING) out = out.split(from).join(to);
  for (const c of out) {
    if (!isWinAnsi(c)) {
      const codePoint = `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
      throw new PdfTextError(`The character ${codePoint} is not in the PDF font's character set, so no PDF is made.`, codePoint);
    }
  }
  return out;
}

/** Whether the PDF font can draw this text (after the fixed ASCII spellings). */
const drawable = (text: string) => {
  try {
    winAnsi(text);
    return true;
  } catch {
    return false;
  }
};

const A4 = { w: 595.28, h: 841.89 };
const M = { left: 48, right: 48, top: 56, bottom: 74 };
const COL = { en: 48, de: 190, value: 332 };
const COL_W = { en: 134, de: 134, value: A4.w - M.right - 332 };

const unitText = (u?: string) => (u ? ` ${u.replace("{CO2e}", " CO2e")}` : "");

/**
 * Glyph widths and kerning pairs of a font, in 1/1000 em (whole numbers), asked of the font once per character and per pair.
 * `widthOfTextAtSize` is the sum of the glyph widths plus the kerning of each neighbouring pair, so the width of any piece of a text
 * is a difference of two prefix sums: no piece is ever measured again (R2-01).
 */
class Metrics {
  readonly #glyph = new Map<string, number>();
  readonly #pair = new Map<string, number>();
  constructor(private readonly font: PDFFont) {}
  glyph(c: string): number {
    let w = this.#glyph.get(c);
    if (w === undefined) (w = this.font.widthOfTextAtSize(c, 1000)), this.#glyph.set(c, w);
    return w;
  }
  kern(a: string, b: string): number {
    const key = a + b;
    let k = this.#pair.get(key);
    if (k === undefined) (k = this.font.widthOfTextAtSize(key, 1000) - this.glyph(a) - this.glyph(b)), this.#pair.set(key, k);
    return k;
  }
}
const METRICS = new WeakMap<PDFFont, Metrics>();
const metricsOf = (font: PDFFont): Metrics => {
  let m = METRICS.get(font);
  if (!m) METRICS.set(font, (m = new Metrics(font)));
  return m;
};

/**
 * Breaks a text into lines of at most `width`, at spaces, and cuts a word that is wider than the column. The lines are those that measuring
 * every candidate line with the font would give, in time linear in the length of the text: the cubic version measured a growing line
 * for every word and a growing word for every cut, so a few kilobytes without a break took many seconds on the main thread.
 */
export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  if (width <= 0 || size <= 0) return text.split("\n");
  const m = metricsOf(font);
  const scale = size / 1000;
  const fits = (units: number) => units * scale <= width;
  const space = m.glyph(" ");
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    let lineUnits = 0;
    let lineLast = "";
    for (const word of para.split(" ")) {
      // prefix sums of the word: glyph widths, and the kerning between neighbours
      const len = word.length;
      const g = new Float64Array(len + 1);
      const k = new Float64Array(len + 1);
      for (let i = 0; i < len; i++) {
        g[i + 1] = g[i]! + m.glyph(word[i]!);
        k[i + 1] = k[i]! + (i + 1 < len ? m.kern(word[i]!, word[i + 1]!) : 0);
      }
      /** Width of word[a..b) in 1/1000 em. */
      const units = (a: number, b: number) => (b <= a ? 0 : g[b]! - g[a]! + (b - a >= 2 ? k[b - 1]! - k[a]! : 0));
      let o = 0; // the part of the word left to place starts here
      // a word longer than the column (a digest) is cut at the column width
      while (o < len && !fits(units(o, len))) {
        let n = 1;
        while (o + n < len && fits(units(o, o + n + 1))) n++;
        if (line) (lines.push(line), (line = ""), (lineUnits = 0), (lineLast = ""));
        lines.push(word.slice(o, o + n));
        o += n;
      }
      const w = o === 0 ? word : word.slice(o);
      const wUnits = units(o, len);
      const nextUnits = line ? lineUnits + m.kern(lineLast, " ") + space + (w ? m.kern(" ", w[0]!) : 0) + wUnits : wUnits;
      if (fits(nextUnits)) {
        line = line ? `${line} ${w}` : w;
        lineUnits = nextUnits;
        lineLast = w ? w[w.length - 1]! : " ";
      } else {
        lines.push(line);
        line = w;
        lineUnits = wUnits;
        lineLast = w ? w[w.length - 1]! : "";
      }
    }
    lines.push(line);
  }
  return lines;
}

export interface CustomerPdf extends OutputFile {
  /** The text lines drawn, in order, for tests that compare against the extracted PDF text. */
  drawn: string[];
}

export async function buildCustomerPdf(
  pack: ProfilePack,
  record: ProductRecord,
  context: { version: number; language?: "en" | "de"; operationContext?: OperationContext } = { version: 1 },
): Promise<CustomerPdf> {
  const language: "en" | "de" = context.language ?? (pack.contracts.profilePolicy.customer.language === "de" ? "de" : "en");
  const prepared = prepare(pack, record, ROUTE, {
    language,
    ...(context.operationContext ? { context: context.operationContext } : {}),
  });
  const { holds, projection } = prepared;
  // Every text that will be drawn goes through the guard first, so an unknown character refuses the file before any layout
  const offenders: HoldReason[] = [];
  let firstMessage = "";
  const guard = (it: OutputValue): OutputValue => {
    try {
      return {
        ...it,
        label: { en: winAnsi(it.label.en), de: winAnsi(it.label.de) },
        text: winAnsi(it.text),
        lines: it.lines.map((l) => ({ ...(l.key ? { key: winAnsi(l.key) } : {}), text: winAnsi(l.text) })),
        sources: it.sources.map((x) => ({ role: x.role, position: winAnsi(x.position) })),
      };
    } catch (e) {
      if (!(e instanceof PdfTextError)) throw e;
      firstMessage ||= `${it.label.en}: ${e.message}`;
      // Name the exact field: the one source text the font lacks a character for, with the key it comes from and its own place
      const bad = it.fields.find((f) => !drawable(f.text));
      const exact = bad && fieldSource(record, bad.ref);
      const sources = exact
        ? [exact]
        : it.refs.flatMap((r) => {
            const a = record.values.find((v) => v.property === r.property && v.member === r.member && v.qualifier === r.qualifier)?.assertions[r.index];
            return a ? [a.source] : [];
          });
      offenders.push({ ruleId: "RR-PDF-CHARACTER", property: it.property, ...(bad?.ref.detail ? { field: bad.ref.detail } : {}), detail: e.codePoint, sources });
      return it;
    }
  };
  const items = prepared.items.map(guard);
  if (offenders.length) throw new RouteRefusedError(ROUTE, offenders, firstMessage);
  const mapping = pack.routes[ROUTE].output;

  const doc = await PDFDocument.create({ updateMetadata: false });
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const drawn: string[] = [];
  const grey = rgb(0.4, 0.4, 0.4);
  const ink = rgb(0.08, 0.08, 0.08);

  const pages: PDFPage[] = [];
  let page: PDFPage;
  let y = 0;
  const newPage = () => {
    page = doc.addPage([A4.w, A4.h]);
    pages.push(page);
    y = A4.h - M.top;
  };
  type Part = { text: string; x: number; size: number; font: PDFFont; color?: ReturnType<typeof rgb> };
  /** One row of the layout, `h` high. The page is broken here, before the row, so no row crosses the bottom margin. */
  const row = (h: number, ...parts: Part[]) => {
    if (y - h < M.bottom) newPage();
    y -= h;
    for (const p of parts) {
      page.drawText(p.text, { x: p.x, y, size: p.size, font: p.font, color: p.color ?? ink });
      drawn.push(p.text);
    }
  };

  newPage();
  const valueOf = (role: "name" | "model" | "revision") => {
    const property = byRole(pack, role);
    const it = items.find((i) => i.property === property && i.role === "field");
    return it?.present ? (it.lines.find((l) => l.key === "value")?.text ?? it.text) : "";
  };
  const sheetTitle = language === "de" ? "Kundendatenblatt (synthetischer Demonstrator)" : "Customer product data sheet (synthetic demonstrator)";
  row(9, { text: sheetTitle, x: M.left, size: 9, font: regular, color: grey });
  y -= 8;
  const nameLine = projection.customerPayload?.designation ?? items.find((i) => i.property === byRole(pack, "name"))?.lines[0]?.text ?? "";
  for (const l of wrap(winAnsi(nameLine || valueOf("model")), bold, 16, A4.w - M.left - M.right)) row(18, { text: l, x: M.left, size: 16, font: bold });
  y -= 16;
  const revText = valueOf("revision") || record.revision || "";
  for (const l of wrap(winAnsi(`Model ${valueOf("model")}${revText ? `   Revision ${revText}` : ""}   Language ${language}`), regular, 9, A4.w - M.left - M.right)) {
    row(11, { text: l, x: M.left, size: 9, font: regular, color: grey });
  }
  y -= 8;
  page!.drawLine({ start: { x: M.left, y }, end: { x: A4.w - M.right, y }, thickness: 0.6, color: grey });
  y -= 6;

  // Sections in the mapping's order, each with its heading, which is never left alone at the foot of a page
  const titles = new Map(pack.routes[ROUTE].sections.map((s) => [s.id, { en: s.en, de: s.de }]));
  let current = "";
  items.forEach((it, i) => {
    const place = mapping[i].pdf!;
    if (place.section !== current) {
      current = place.section;
      if (y - 60 < M.bottom) newPage();
      y -= 12;
      const t = titles.get(current) ?? { en: current, de: current };
      for (const l of wrap(`${t.en} / ${t.de}`, bold, 11, A4.w - M.left - M.right)) row(13, { text: l, x: M.left, size: 11, font: bold });
      y -= 4;
    }
    drawItem(it);
  });

  function drawItem(it: OutputValue) {
    const label = { en: wrap(it.label.en, regular, 8.5, COL_W.en), de: wrap(it.label.de, regular, 8.5, COL_W.de) };
    const valueLines: string[] = [];
    if (!it.present) valueLines.push("not provided");
    else if (it.kind === "derived") {
      const derivedEntry = projection.derived.find((d) => d.property === it.property);
      valueLines.push(...wrap(`${it.text}`, bold, 8.5, COL_W.value), `Rule ${it.ruleId}`);
      if (derivedEntry?.basis) valueLines.push(...wrap(winAnsi(`Basis: ${derivedEntry.basis}`), bold, 8.5, COL_W.value));
      if (derivedEntry?.qualification) valueLines.push(...wrap(winAnsi(derivedEntry.qualification), bold, 8.5, COL_W.value));
    } else {
      it.lines.forEach((l) => valueLines.push(...wrap(`${l.key ? `${l.key}: ` : ""}${l.text}${it.lines.length === 1 ? unitText(it.unit) : ""}`, bold, 8.5, COL_W.value)));
      // Show compatible footprint context (method, declared unit, boundary) when rendering carbon footprint
      if (it.property === byRole(pack, "footprint") && projection.customerPayload?.carbon_footprint) {
        const fp = projection.customerPayload.carbon_footprint;
        valueLines.push(
          ...wrap(
            winAnsi(`Method: ${fp.method.id} v${fp.method.version}; Reference unit: ${fp.reference_quantity.id} (${fp.reference_quantity.quantity} ${fp.reference_quantity.unit}); Boundary: ${fp.boundary.id}`),
            bold,
            8.5,
            COL_W.value,
          ),
        );
        valueLines.push(...wrap(winAnsi(fp.qualification), bold, 8.5, COL_W.value));
      }
    }
    const basis = it.present && it.kind !== "derived" ? pack.properties.find((p) => p.id === it.property)?.basis : undefined;
    if (basis && it.role === "field") valueLines.push(...wrap(`Basis: ${basis}`, bold, 8.5, COL_W.value));
    const seen = new Set<string>();
    const sourceLines: string[] = [];
    for (const s of it.sources) {
      const k = `${s.role}|${s.position}`;
      if (!seen.has(k)) {
        seen.add(k);
        sourceLines.push(`${s.role}${s.position ? `, ${s.position}` : ""}`);
      }
    }
    const src = sourceLines.flatMap((l) => wrap(`Source: ${l}`, regular, 6.5, COL_W.value));
    const rows = Math.max(label.en.length, label.de.length, valueLines.length);
    y -= 2;
    if (rows * 11 + src.length * 8 + 5 <= A4.h - M.top - M.bottom - 40) {
      // An item stays on one page, and each column is drawn whole, one after the other, so a label that wraps keeps its
      // words together in the text of the file and stays inside its own column.
      if (y - (rows * 11 + src.length * 8 + 3) < M.bottom) newPage();
      const top = y;
      const column = (lines: string[], x: number, font: PDFFont, color?: ReturnType<typeof rgb>, size = 8.5) =>
        lines.forEach((text, n) => {
          page.drawText(text, { x, y: top - (n + 1) * 11, size, font, color: color ?? ink });
          drawn.push(text);
        });
      column(label.en, COL.en, regular);
      column(label.de, COL.de, regular, grey);
      column(valueLines, COL.value, bold);
      y = top - rows * 11;
    } else {
      // An item taller than a page (a very long text) runs on across pages, row by row
      for (let n = 0; n < rows; n++) {
        const parts: Part[] = [];
        if (label.en[n] !== undefined) parts.push({ text: label.en[n], x: COL.en, size: 8.5, font: regular });
        if (label.de[n] !== undefined) parts.push({ text: label.de[n], x: COL.de, size: 8.5, font: regular, color: grey });
        if (valueLines[n] !== undefined) parts.push({ text: valueLines[n], x: COL.value, size: 8.5, font: bold });
        row(11, ...parts);
      }
    }
    for (const l of src) row(8, { text: l, x: COL.value, size: 6.5, font: regular, color: grey });
    y -= 3;
  }

  // How to read the sheet: what the codes and qualifiers on it mean, and what its digests are for
  {
    const find = (pattern: RegExp) => items.flatMap((i) => (i.present ? i.lines.map((l) => l.key ?? "") : [])).find((k) => pattern.test(k));
    const resultId = items.find((i) => i.property === byRole(pack, "footprint") && i.role === "field")?.lines[0]?.key ?? "PCF-1";
    const qualifier = find(/^en\/[^/]+\/[^/]+$/) ?? find(/^[a-z]{2}\/[^/]+\/[^/]+$/) ?? "en/construction/EU";
    const rule = items.find((i) => i.kind === "derived" && i.ruleId)?.ruleId ?? "a rule ID";
    const notes = [
      `${resultId}: the footprint result ID, the identifier the laboratory file gives to one calculated footprint result.`,
      "scope: the customer-scoped alias. It names the customer whose own article number is shown next to it.",
      `${qualifier}: a qualifier of a text. It gives the language, the sector and the market the text is approved for.`,
      `Rule ${rule}: a rule ID. It names the rule in the pinned contract pack that made a derived statement, which says whether a value lies within limits; the value itself is not shown.`,
      "The record digest and the contract pack digest in the footer identify exactly which record and which contract this sheet was made from.",
    ].flatMap((t) => wrap(t, regular, 7.5, A4.w - M.left - M.right));
    if (y - (notes.length * 10 + 40) < M.bottom) newPage();
    y -= 14;
    row(13, { text: "Reading this sheet", x: M.left, size: 11, font: bold });
    y -= 2;
    for (const l of notes) row(10, { text: l, x: M.left, size: 7.5, font: regular, color: grey });
  }

  // Footer on every page
  const total = pages.length;
  const foot = (n: number, at: number, text: string) => {
    pages[n].drawText(text, { x: M.left, y: at, size: 6.5, font: regular, color: grey });
    drawn.push(text);
  };
  pages.forEach((_, n) => {
    foot(n, 44, `Record version ${context.version}   Record digest ${record.digest}`);
    foot(n, 35, `Contract pack manifest digest ${pack.manifestDigest}`);
    foot(n, 26, `Page ${n + 1} of ${total}. Illustrative values are marked as such; this sheet is not a conformity statement.`);
  });

  const bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false });
  return {
    route: ROUTE,
    fileName: `${safeName(`customer-sheet-${language}`, record.model, record.batch)}.pdf`,
    mediaType: "application/pdf",
    bytes,
    status: "RELEASED",
    holds,
    items,
    lineage: buildLineage(pack, record, ROUTE, items),
    drawn,
  };
}
