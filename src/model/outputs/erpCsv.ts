/**
 * Internal ERP staging file (CSV) — TARGET-INTERNAL-CSV-01 (Cycle 4: FUNC-041; aligned Cycle 9, C9-03).
 *
 * Comma-delimited UTF-8 without BOM, `\n` line endings, RFC 4180 quoting, formula-safe cells.
 * Matches `expected/baseline/internal.csv` in substance: 12 columns (the 10 internal staging fields,
 * `lead_qualifier`, and `synthetic` = `True`). Refused with RouteRefusedError if route is HOLD.
 */
import { utf8 } from "../canonical";
import { buildLineage } from "../lineage";
import type { OperationContext } from "../context";
import type { ProductRecord } from "../ingress";
import type { ProfilePack, Route } from "../profile";
import { prepare } from "./items";
import { safeName, type OutputFile } from "./types";

const ROUTE: Route = "internal";
const DELIMITER = ",";
const DANGEROUS = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;
const STRICT_NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function csvCell(text: string, numeric: boolean): { cell: string; prefixed: boolean } {
  const prefixed = DANGEROUS.test(text) && !(numeric && STRICT_NUMBER.test(text));
  const safe = prefixed ? `'${text}` : text;
  return { cell: /[,"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe, prefixed };
}

export interface ErpCsv extends OutputFile {
  text: string;
  formulaPrefixedCells: number;
}

export function buildErpCsv(pack: ProfilePack, record: ProductRecord, context?: OperationContext): ErpCsv {
  const { items, holds } = prepare(pack, record, ROUTE, { ...(context ? { context } : {}) });
  const mapping = pack.routes[ROUTE].output;
  const header = [...mapping.map((m) => csvCell(m.csv!.header, true).cell), "synthetic"];
  let formulaPrefixedCells = 0;
  const row = [
    ...items.map((it) => {
      const rawText = it.present ? it.text : "";
      const { cell, prefixed } = csvCell(rawText, it.numeric);
      if (prefixed) formulaPrefixedCells++;
      return cell;
    }),
    "True",
  ];
  const text = `${header.join(DELIMITER)}\n${row.join(DELIMITER)}\n`;
  return {
    route: ROUTE,
    fileName: `${safeName("internal-staging", record.model, record.batch)}.csv`,
    mediaType: "text/csv",
    bytes: utf8(text),
    text,
    status: "RELEASED",
    holds,
    items,
    lineage: buildLineage(pack, record, ROUTE, items),
    formulaPrefixedCells,
  };
}
