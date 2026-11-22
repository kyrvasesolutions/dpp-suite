/** Extracts the text of a PDF with pdfjs-dist (a dev-only dependency; check-bundle proves it is not in the app). */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** One string per page: the text items joined with a newline where the line changes. */
export async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false, verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    pages.push(content.items.map((i) => ("str" in i ? i.str : "")).filter(Boolean).join("\n"));
  }
  await pdf.cleanup?.();
  return pages;
}

export const pdfText = async (bytes: Uint8Array) => (await pdfPages(bytes)).join("\n");

/** Every drawn text item with its page and baseline, to check where text sits on the page. */
export async function pdfItems(bytes: Uint8Array): Promise<Array<{ str: string; page: number; y: number }>> {
  const pdf = await getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false, verbosity: 0 }).promise;
  const out: Array<{ str: string; page: number; y: number }> = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    for (const i of content.items) if ("str" in i && i.str.trim()) out.push({ str: i.str, page: n, y: i.transform[5] });
  }
  return out;
}
