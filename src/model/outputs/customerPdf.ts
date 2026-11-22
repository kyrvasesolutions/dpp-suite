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
import { buildLineage } from "../lineage";
import { byRole, type ProductRecord } from "../ingress";
import type { ProfilePack, Route } from "../profile";
import type { HoldReason } from "../readiness";
import { fieldSource, prepare, RouteRefusedError, type OutputValue } from "./items";
import { safeName, type OutputFile } from "./types";

const ROUTE: Route = "customer-pdf";

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

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      let w = word;
      // a word longer than the column (a digest) is cut at the column width
      while (font.widthOfTextAtSize(w, size) > width) {
        let n = w.length;
        while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
        if (line) (lines.push(line), (line = ""));
        lines.push(w.slice(0, n));
        w = w.slice(n);
      }
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else (lines.push(line), (line = w));
    }
    lines.push(line);
  }
  return lines;
}

export interface CustomerPdf extends OutputFile {
  /** The text lines drawn, in order, for tests that compare against the extracted PDF text. */
  drawn: string[];
}

export async function buildCustomerPdf(pack: ProfilePack, record: ProductRecord, context: { version: number } = { version: 1 }): Promise<CustomerPdf> {
  const prepared = prepare(pack, record, ROUTE);
  const { holds } = prepared;
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
  const valueOf = (role: "name" | "model" | "batch") => {
    const property = byRole(pack, role);
    const it = items.find((i) => i.property === property && i.role === "field");
    return it?.present ? (it.lines.find((l) => l.key === "value")?.text ?? it.text) : "";
  };
  row(9, { text: "Product data sheet", x: M.left, size: 9, font: regular, color: grey });
  y -= 8;
  const nameLine = items.find((i) => i.property === byRole(pack, "name"))?.lines[0]?.text ?? "";
  for (const l of wrap(nameLine || valueOf("model"), bold, 16, A4.w - M.left - M.right)) row(18, { text: l, x: M.left, size: 16, font: bold });
  y -= 16;
  for (const l of wrap(`Model ${valueOf("model")}   Batch ${valueOf("batch")}`, regular, 9, A4.w - M.left - M.right)) row(11, { text: l, x: M.left, size: 9, font: regular, color: grey });
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
    else if (it.kind === "derived") valueLines.push(...wrap(`${it.text}`, regular, 8.5, COL_W.value), `Rule ${it.ruleId}`);
    else it.lines.forEach((l) => valueLines.push(...wrap(`${l.key ? `${l.key}: ` : ""}${l.text}${it.lines.length === 1 ? unitText(it.unit) : ""}`, regular, 8.5, COL_W.value)));
    // The basis a value is stated on, from the profile definition (the post-consumer share is a mass share of the product)
    const basis = it.present && it.kind !== "derived" ? pack.properties.find((p) => p.id === it.property)?.basis : undefined;
    if (basis && it.role === "field") valueLines.push(...wrap(`Basis: ${basis}`, regular, 7, COL_W.value));
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
    fileName: `${safeName("customer-sheet", record.model, record.batch)}.pdf`,
    mediaType: "application/pdf",
    bytes,
    status: "ready",
    holds,
    items,
    lineage: buildLineage(pack, record, ROUTE, items),
    drawn,
  };
}
