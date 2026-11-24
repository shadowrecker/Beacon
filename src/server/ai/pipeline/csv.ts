/**
 * RFC 4180 CSV parsing (quoted fields, escaped quotes, embedded delimiters and
 * newlines, CRLF/LF/CR line endings, optional UTF-8 BOM) with delimiter
 * detection for comma, semicolon and tab separated exports.
 */

export type CsvDelimiter = "," | ";" | "\t";

/** Pick the delimiter that splits the first line into the most fields (outside quotes). */
export function detectDelimiter(text: string): CsvDelimiter {
  const candidates: CsvDelimiter[] = [",", ";", "\t"];
  const counts = new Map<CsvDelimiter, number>(candidates.map((d) => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length && i < 10_000; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && counts.has(ch as CsvDelimiter)) counts.set(ch as CsvDelimiter, (counts.get(ch as CsvDelimiter) ?? 0) + 1);
  }
  let best: CsvDelimiter = ",";
  for (const d of candidates) if ((counts.get(d) ?? 0) > (counts.get(best) ?? 0)) best = d;
  return best;
}

export interface ParseCsvOptions {
  delimiter?: CsvDelimiter;
  /** Stop after this many records (the rest are reported as truncated). */
  maxRecords?: number;
}

export interface ParsedCsv {
  records: string[][];
  truncated: boolean;
}

/** Parse CSV text into records of fields. Fully blank lines are skipped. */
export function parseCsv(input: string, opts: ParseCsvOptions = {}): ParsedCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  const maxRecords = opts.maxRecords ?? Number.POSITIVE_INFINITY;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  let truncated = false;

  const endField = () => {
    record.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    const blank = record.length === 1 && record[0].trim() === "";
    if (!blank) records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      if (records.length >= maxRecords) {
        truncated = i + 1 < text.length && text.slice(i + 1).trim().length > 0;
        return { records, truncated };
      }
    } else {
      // A quote inside an unquoted field is kept literally (lenient, like most spreadsheet exports).
      field += ch;
      fieldStarted = true;
    }
  }
  if (field.length > 0 || record.length > 0 || fieldStarted) endRecord();
  return { records, truncated };
}

export interface CsvRow {
  /** 1-based data row number (the header is row 0). */
  row: number;
  text: string;
}

/**
 * Render a CSV as one line per data row, "Header: value; Header: value", so each
 * row stays self-describing after chunking. Empty cells are omitted.
 */
export function csvToRows(input: string, maxRows = 50_000): { header: string[]; rows: CsvRow[]; truncated: boolean } {
  const { records, truncated } = parseCsv(input, { maxRecords: maxRows + 1 });
  if (records.length === 0) return { header: [], rows: [], truncated: false };
  const header = records[0].map((h, i) => h.trim().replace(/\s+/g, " ") || `Column ${i + 1}`);
  const rows: CsvRow[] = [];
  for (let r = 1; r < records.length; r++) {
    const cells = records[r];
    const parts: string[] = [];
    for (let c = 0; c < cells.length; c++) {
      const value = cells[c].trim().replace(/\r\n?/g, "\n");
      if (!value) continue;
      parts.push(`${header[c] ?? `Column ${c + 1}`}: ${value}`);
    }
    if (parts.length > 0) rows.push({ row: r, text: parts.join("; ") });
  }
  return { header, rows, truncated };
}
