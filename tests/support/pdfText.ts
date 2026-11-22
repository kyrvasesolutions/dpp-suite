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
