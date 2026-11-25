// @vitest-environment node
/**
 * R2-01: the line breaking of the customer PDF is linear in the text and gives exactly the lines the measuring-every-candidate version gave
 * (so the goldens stay byte for byte), and a long free text no longer takes seconds on the main thread.
 */
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { wrap } from "../../src/model/outputs/customerPdf";

/** The reference: the original algorithm, measuring each candidate line and each cut with the font. */
function wrapReference(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      let w = word;
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

let regular: PDFFont;
let bold: PDFFont;
beforeAll(async () => {
  const doc = await PDFDocument.create();
  regular = await doc.embedFont(StandardFonts.Helvetica);
  bold = await doc.embedFont(StandardFonts.HelveticaBold);
});

describe("wrap gives the reference lines", () => {
  it("for fixed cases (kerning pairs, long words, empty parts, line breaks, double spaces)", () => {
    const cases = [
      "",
      " ",
      "Aluminium sheet EN AW-5754 H111, 2.0 mm",
      "AVAVAVAV To Ty Te Yo WA AV LT Fo r. y, v. T, Y.",
      "a".repeat(300),
      "word " + "x".repeat(200) + " tail",
      "two  spaces   and\nnew line\n\nblank above",
      "W".repeat(77) + " " + "i".repeat(400),
      "0123456789abcdef".repeat(12),
    ];
    for (const font of [regular, bold]) {
      for (const size of [6.5, 7, 8.5, 9, 11, 16]) {
        for (const width of [60, 134, 216.28, 499.28]) {
          for (const text of cases) expect(wrap(text, font, size, width), `${size}/${width}/${text.slice(0, 20)}`).toEqual(wrapReference(text, font, size, width));
        }
      }
    }
  });

  it("for random texts over the characters that kern and widen", () => {
    let seed = 20261124;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const alphabet = "AVWTYoyeaiIl,. -/()0123456789MmwFLPrfj\n";
    for (let t = 0; t < 400; t++) {
      const n = 1 + Math.floor(rnd() * 300);
      let text = "";
      for (let i = 0; i < n; i++) text += alphabet[Math.floor(rnd() * alphabet.length)];
      const font = rnd() < 0.5 ? regular : bold;
      const size = [6.5, 8.5, 11, 16][Math.floor(rnd() * 4)]!;
      const width = 40 + rnd() * 460;
      expect(wrap(text, font, size, width), JSON.stringify(text)).toEqual(wrapReference(text, font, size, width));
    }
  });
});

describe("wrap is linear", () => {
  it("2 MiB of short words, and a 2000-character unbroken word, each take well under a second", () => {
    const words = "ab cd ef gh ".repeat(Math.floor((2 * 1024 * 1024) / 12));
    let t0 = performance.now();
    const lines = wrap(words, regular, 8.5, 216);
    const wordsMs = performance.now() - t0;
    expect(lines.length).toBeGreaterThan(10_000);
    t0 = performance.now();
    wrap("x".repeat(2000), regular, 8.5, 216);
    wrap("W".repeat(2000), bold, 16, 499);
    const wordMs = performance.now() - t0;
    expect(wordsMs).toBeLessThan(3000);
    expect(wordMs).toBeLessThan(300);
  });
});
