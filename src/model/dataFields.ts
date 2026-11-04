/** Reads the fields (column headers, element or property paths) out of a user's data file, with a sample value for each. */

export interface DataField {
  /** Unique path, e.g. `product.composition[].element`. */
  path: string;
  sample?: string;
}

const MAX_FIELDS = 500;

const short = (value: unknown) => {
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

function flatten(value: unknown, path: string, out: Map<string, string | undefined>) {
  if (out.size >= MAX_FIELDS) return;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      if (path && !out.has(path)) out.set(path, undefined);
      return;
    }
    for (const item of value) flatten(item, `${path}[]`, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, path ? `${path}.${key}` : key, out);
    }
  } else if (path && (!out.has(path) || out.get(path) === undefined)) {
    out.set(path, value === null || value === undefined ? undefined : short(value));
  }
}

function fromJson(text: string): DataField[] {
  const out = new Map<string, string | undefined>();
  flatten(JSON.parse(text), "", out);
  return [...out].map(([path, sample]) => ({ path, sample }));
}

/** The first rows of CSV text, honouring quotes; `;` is the delimiter when the header has more of them than commas. */
function csvRows(text: string, limit: number): string[][] {
  const firstLine = text.split("\n", 1)[0];
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < limit; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows.filter((r) => r.some((c) => c.trim()));
}

function fromCsv(text: string): DataField[] {
  const [header = [], first = []] = csvRows(text.replace(/^﻿/, ""), 2);
  return header
    .map((name, i) => ({ path: name.trim(), sample: first[i]?.trim() ? short(first[i].trim()) : undefined }))
    .filter((f) => f.path);
}

function walkXml(el: Element, path: string, out: Map<string, string | undefined>) {
  if (out.size >= MAX_FIELDS) return;
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith("xmlns")) continue;
    const key = `${path}@${attr.name}`;
    if (!out.has(key)) out.set(key, short(attr.value));
  }
  const children = Array.from(el.children);
  if (children.length === 0) {
    const text = el.textContent?.trim();
    if (!out.has(path) || out.get(path) === undefined) out.set(path, text ? short(text) : undefined);
    return;
  }
  for (const child of children) walkXml(child, `${path}.${child.tagName}`, out);
}

function fromXml(text: string): DataField[] {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("not well-formed XML.");
  const out = new Map<string, string | undefined>();
  // The root element only wraps the data, so paths start below it.
  for (const child of Array.from(doc.documentElement.children)) walkXml(child, child.tagName, out);
  return [...out].map(([path, sample]) => ({ path, sample }));
}

/** Turtle / N-Triples: the predicates in use are the fields. */
function fromTriples(text: string): DataField[] {
  const out = new Map<string, string | undefined>();
  const triple = /(?:^|[;\s])((?:[A-Za-z][\w-]*)?:[\w-]+|<[^>\s]+>)\s+("(?:[^"\\]|\\.)*"|<[^>\s]+>|[\w.:+-]+)\s*[;.,]/gm;
  for (const m of text.matchAll(triple)) {
    if (m[1] === "rdf:type") continue;
    if (!out.has(m[1])) out.set(m[1], short(m[2].replace(/^"|"$/g, "")));
  }
  return [...out].map(([path, sample]) => ({ path, sample }));
}

// ---------- Excel (first row of the first sheet) ----------

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Finds one entry of a zip file by name. */
async function zipEntry(buf: Uint8Array, name: string): Promise<string | null> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = buf.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a valid Excel file.");
  let at = view.getUint32(eocd + 16, true);
  const count = view.getUint16(eocd + 10, true);
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const entryName = decoder.decode(buf.subarray(at + 46, at + 46 + nameLen));
    if (entryName === name) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = buf.subarray(start, start + size);
      return decoder.decode(method === 0 ? data : await inflate(data));
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

async function fromXlsx(file: File): Promise<DataField[]> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const sheet = await zipEntry(buf, "xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("couldn't find a worksheet.");
  const sharedXml = await zipEntry(buf, "xl/sharedStrings.xml");
  const shared = sharedXml
    ? Array.from(new DOMParser().parseFromString(sharedXml, "application/xml").getElementsByTagName("si")).map((si) =>
        Array.from(si.getElementsByTagName("t"))
          .map((t) => t.textContent ?? "")
          .join(""),
      )
    : [];
  const rows = Array.from(new DOMParser().parseFromString(sheet, "application/xml").getElementsByTagName("row"));
  const read = (row: Element | undefined) => {
    const cells = new Map<number, string>();
    for (const c of Array.from(row?.getElementsByTagName("c") ?? [])) {
      const letters = (c.getAttribute("r") ?? "").replace(/\d+/g, "");
      const col = [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const raw = c.getElementsByTagName("v")[0]?.textContent ?? c.getElementsByTagName("t")[0]?.textContent ?? "";
      cells.set(col, c.getAttribute("t") === "s" ? (shared[Number(raw)] ?? "") : raw);
    }
    return cells;
  };
  const header = read(rows[0]);
  const first = read(rows[1]);
  return [...header]
    .sort(([a], [b]) => a - b)
    .filter(([, name]) => name.trim())
    .map(([col, name]) => {
      const sample = first.get(col)?.trim();
      return { path: name.trim(), sample: sample ? short(sample) : undefined };
    });
}

/** The fields found in a file, in order, without duplicates. Throws a readable Error when the file can't be read. */
export async function extractFields(file: File): Promise<DataField[]> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  let fields: DataField[];
  try {
    if (ext === "xlsx") fields = await fromXlsx(file);
    else {
      const text = await file.text();
      if (ext === "csv") fields = fromCsv(text);
      else if (ext === "json" || ext === "jsonld" || ext === "json-ld") fields = fromJson(text);
      else if (ext === "xml") fields = fromXml(text);
      else if (ext === "rdf") fields = text.trimStart().startsWith("<") ? fromXml(text) : fromTriples(text);
      else throw new Error(`unsupported file type .${ext}`);
    }
  } catch (error) {
    const reason = error instanceof SyntaxError ? "not valid JSON." : error instanceof Error ? error.message : "can't be read.";
    throw new Error(`${file.name}: ${reason}`);
  }
  const seen = new Set<string>();
  return fields.filter((f) => {
    if (seen.has(f.path)) return false;
    seen.add(f.path);
    return true;
  });
}
