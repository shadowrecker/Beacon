/**
 * Small RFC 4180 CSV parser (shared by roadmap and analytics imports).
 *
 * - Quoted fields may contain delimiters, newlines and escaped quotes ("").
 * - CRLF, LF and lone CR line endings; a leading UTF-8 BOM is ignored.
 * - The delimiter is detected from the header line (comma, tab or semicolon).
 * - Bounded: at most `maxRows` data rows (the rest is reported as truncated),
 *   `maxColumns` columns and `maxFieldLength` characters per field.
 */

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

export interface CsvOptions {
  /** Maximum number of data rows (excluding the header). */
  maxRows: number;
  maxColumns?: number;
  maxFieldLength?: number;
}

export interface ParsedCsv {
  header: string[];
  rows: string[][];
  /** True when the input had more than `maxRows` data rows. */
  truncated: boolean;
}

function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, Math.min(text.length, 4096)).split(/\r\n|\n|\r/, 1)[0] ?? "";
  if (firstLine.includes(",")) return ",";
  if (firstLine.includes("\t")) return "\t";
  if (firstLine.includes(";")) return ";";
  return ",";
}

export function parseCsv(input: string, opts: CsvOptions): ParsedCsv {
  const maxColumns = opts.maxColumns ?? 50;
  const maxFieldLength = opts.maxFieldLength ?? 20_000;
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);

  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  let truncated = false;
  let i = 0;

  const pushField = () => {
    if (field.length > maxFieldLength) {
      throw new CsvError(`A value on line ${records.length + 1} is longer than ${maxFieldLength} characters`);
    }
    record.push(field);
    if (record.length > maxColumns) throw new CsvError(`Too many columns (maximum ${maxColumns})`);
    field = "";
    fieldStarted = false;
  };
  const pushRecord = (): boolean => {
    pushField();
    // Skip blank lines entirely.
    if (!(record.length === 1 && record[0].trim() === "")) records.push(record);
    record = [];
    if (records.length > opts.maxRows + 1) {
      truncated = true;
      return false;
    }
    return true;
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && !fieldStarted && field.trim() === "") {
      inQuotes = true;
      fieldStarted = true;
      field = "";
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      i++;
      if (!pushRecord()) break;
      continue;
    }
    field += ch;
    fieldStarted = true;
    i++;
  }
  if (inQuotes) throw new CsvError("The file has an unterminated quoted value");
  if (!truncated && (field !== "" || record.length > 0)) pushRecord();

  if (records.length === 0) throw new CsvError("The file is empty");
  const [header, ...rest] = records;
  const rows = truncated ? rest.slice(0, opts.maxRows) : rest;
  return { header: header.map((h) => h.trim()), rows, truncated };
}

/** Normalize a header cell for alias matching: lowercase alphanumerics only. */
export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Index of the first header matching any alias (normalized), or -1. */
export function findColumn(header: string[], aliases: string[]): number {
  const normalized = header.map(normalizeHeader);
  for (const alias of aliases) {
    const idx = normalized.indexOf(normalizeHeader(alias));
    if (idx >= 0) return idx;
  }
  return -1;
}
