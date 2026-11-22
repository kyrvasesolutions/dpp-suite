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
 * outside it get fixed ASCII spellings, and any other character stops the build of the file with a PdfTextError.
 * A route on hold is refused: no PDF is made.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { buildLineage } from "../lineage";
import { byRole, type ProductRecord } from "../ingress";
import type { ProfilePack, Route } from "../profile";
import { prepare, type OutputValue } from "./items";
import { safeName, type OutputFile } from "./types";

const ROUTE: Route = "customer-pdf";

export class PdfTextError extends Error {
  override name = "PdfTextError";
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
    if (!isWinAnsi(c)) throw new PdfTextError(`The character U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} is not in the PDF font's character set, so no PDF is made.`);
  }
  return out;
}

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
  // Every text that will be drawn goes through the guard first, so an unknown character stops the file before any layout
  const items: OutputValue[] = prepared.items.map((it) => ({
    ...it,
    label: { en: winAnsi(it.label.en), de: winAnsi(it.label.de) },
    text: winAnsi(it.text),
    lines: it.lines.map((l) => ({ ...(l.key ? { key: winAnsi(l.key) } : {}), text: winAnsi(l.text) })),
    sources: it.sources.map((x) => ({ role: x.role, position: winAnsi(x.position) })),
  }));
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
  const text = (t: string, x: number, size: number, font: PDFFont, color = ink) => {
    const safe = winAnsi(t);
    page.drawText(safe, { x, y, size, font, color });
    drawn.push(safe);
  };
  const need = (h: number) => {
    if (y - h < M.bottom) newPage();
  };

  newPage();
  const valueOf = (role: "name" | "model" | "batch") => {
    const property = byRole(pack, role);
    const it = items.find((i) => i.property === property && i.role === "field");
    return it?.present ? (it.lines.find((l) => l.key === "value")?.text ?? it.text) : "";
  };
  text("Product data sheet", M.left, 9, regular, grey);
  y -= 8;
  const nameLine = items.find((i) => i.property === byRole(pack, "name"))?.lines[0]?.text ?? "";
  for (const l of wrap(winAnsi(nameLine || valueOf("model")), bold, 16, A4.w - M.left - M.right)) {
    y -= 18;
    text(l, M.left, 16, bold);
  }
  y -= 16;
  text(`Model ${winAnsi(valueOf("model"))}   Batch ${winAnsi(valueOf("batch"))}`, M.left, 9, regular, grey);
  y -= 8;
  page!.drawLine({ start: { x: M.left, y }, end: { x: A4.w - M.right, y }, thickness: 0.6, color: grey });
  y -= 6;

  // Sections in the mapping's order, each with its heading
  const titles = pdfSectionTitles(pack);
  let current = "";
  items.forEach((it, i) => {
    const place = mapping[i].pdf!;
    if (place.section !== current) {
      current = place.section;
      need(60);
      y -= 24;
      const t = titles.get(current) ?? { en: current, de: current };
      text(`${t.en} / ${t.de}`, M.left, 11, bold);
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
    need(rows * 11 + src.length * 8 + 10);
    y -= 13;
    const top = y;
    label.en.forEach((l, n) => ((y = top - n * 11), text(l, COL.en, 8.5, regular)));
    label.de.forEach((l, n) => ((y = top - n * 11), text(l, COL.de, 8.5, regular, grey)));
    valueLines.forEach((l, n) => ((y = top - n * 11), text(l, COL.value, 8.5, bold)));
    y = top - (rows - 1) * 11;
    src.forEach((l) => {
      y -= 8;
      text(l, COL.value, 6.5, regular, grey);
    });
    y -= 3;
  }

  // Footer on every page
  const total = pages.length;
  pages.forEach((p, n) => {
    page = p;
    y = 44;
    text(`Record version ${context.version}   Record digest ${record.digest}`, M.left, 6.5, regular, grey);
    y = 35;
    text(`Contract pack manifest digest ${pack.manifestDigest}`, M.left, 6.5, regular, grey);
    y = 26;
    text(`Page ${n + 1} of ${total}. Illustrative values are marked as such; this sheet is not a conformity statement.`, M.left, 6.5, regular, grey);
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

/** The section titles of the layout, from the pinned mapping's section IDs. */
function pdfSectionTitles(pack: ProfilePack): Map<string, { en: string; de: string }> {
  return new Map(pack.routes[ROUTE].sections.map((s) => [s.id, { en: s.en, de: s.de }]));
}
