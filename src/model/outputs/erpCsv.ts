/**
 * The internal ERP staging CSV (Cycle 4: FUNC-041 slice, criterion C4-02).
 *
 * One header row and one data row, from the projection of the ERP route and the pinned output mapping, in the
 * mapping's order. UTF-8 without a byte-order mark, `;` between cells, `\n` at line ends, RFC 4180 quoting, numbers as
 * the source wrote them. The route must not be on hold: otherwise `RouteRefusedError` says why and no file is made.
 *
 * Formula-safe cells: a text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading
 * apostrophe, so a spreadsheet shows it as text. A cell flagged numeric that matches a strict number pattern is never changed; any other cell is treated as text, also full-width variants of the four signs.
 * The count of changed cells goes to the release manifest.
 */
import { utf8 } from "../canonical";
import { buildLineage } from "../lineage";
import type { ProductRecord } from "../ingress";
import type { ProfilePack, Route } from "../profile";
import { prepare } from "./items";
import { safeName, type OutputFile } from "./types";

const ROUTE: Route = "erp-staging-csv";
const DELIMITER = ";";
const DANGEROUS = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;
/** A cell flagged numeric is left alone only when it is strictly a number; anything else is treated as text (T04). */
const STRICT_NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** The cell as it goes into the file: formula-safe first, then quoted if it holds a delimiter, a quote or a line break. */
export function csvCell(text: string, numeric: boolean): { cell: string; prefixed: boolean } {
  const prefixed = DANGEROUS.test(text) && !(numeric && STRICT_NUMBER.test(text));
  const safe = prefixed ? `'${text}` : text;
  return { cell: /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe, prefixed };
}

export interface ErpCsv extends OutputFile {
  text: string;
  formulaPrefixedCells: number;
}

export function buildErpCsv(pack: ProfilePack, record: ProductRecord): ErpCsv {
  const { items, holds } = prepare(pack, record, ROUTE);
  const mapping = pack.routes[ROUTE].output;
  const header = mapping.map((m) => csvCell(m.csv!.header, true).cell);
  let formulaPrefixedCells = 0;
  const row = items.map((it) => {
    const { cell, prefixed } = csvCell(it.present ? it.text : "", it.numeric);
    if (prefixed) formulaPrefixedCells++;
    return cell;
  });
  const text = `${header.join(DELIMITER)}\n${row.join(DELIMITER)}\n`;
  return {
    route: ROUTE,
    fileName: `${safeName("erp-staging", record.model, record.batch)}.csv`,
    mediaType: "text/csv",
    bytes: utf8(text),
    text,
    status: "ready",
    holds,
    items,
    lineage: buildLineage(pack, record, ROUTE, items),
    formulaPrefixedCells,
  };
}
