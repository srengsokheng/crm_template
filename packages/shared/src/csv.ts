/**
 * Small RFC 4180 CSV reader/writer (no dependency).
 * Handles quoted fields, escaped quotes, CR/LF/CRLF line breaks inside quotes, a UTF-8 BOM, Excel's `sep=;` first line,
 * and detects `,` `;` tab or `|` as the delimiter.
 */

export class CsvError extends Error {
  readonly line: number;
  constructor(message: string, line: number) { super(message); this.line = line; }
}

export interface ParsedCsv { headers: string[]; rows: string[][]; delimiter: string }

const CANDIDATES = [',', ';', '\t', '|'];

/** Pick the delimiter that occurs most often (outside quotes) on the first non-empty line. */
export function detectDelimiter(text: string): string {
  let line = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) { if (line.trim()) break; line = ''; continue; }
    if (!inQuotes) line += ch;
  }
  let best = ',';
  let bestCount = 0;
  for (const d of CANDIDATES) {
    const n = line.split(d).length - 1;
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

/** Parse CSV text into raw records (array of cells). Throws CsvError for an unterminated quote. */
export function parseCsvRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let quoteStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === '') { inQuotes = true; cell = ''; quoteStart = line; continue; }
    if (ch === delimiter) { row.push(cell); cell = ''; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); records.push(row); row = []; cell = ''; line++;
      continue;
    }
    cell += ch;
  }
  if (inQuotes) throw new CsvError(`A quoted value that starts on line ${quoteStart} is never closed`, quoteStart);
  if (cell !== '' || row.length) { row.push(cell); records.push(row); }
  return records;
}

/**
 * Parse a CSV file: the first non-empty record is the header row; blank rows are dropped; rows are padded to the header
 * width. `rowNumbers[i]` is the spreadsheet row number of `rows[i]`, so reports match what users see.
 */
export function parseCsv(input: string): ParsedCsv & { rowNumbers: number[] } {
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let delimiter: string | undefined;
  const sep = /^sep=(.)\r?\n/i.exec(text);
  if (sep) { delimiter = sep[1]; text = text.slice(sep[0].length); }
  delimiter ??= detectDelimiter(text);
  const records = parseCsvRecords(text, delimiter)
    .map((cells, i) => ({ cells, n: i + 1 }))
    .filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (!records.length) return { headers: [], rows: [], rowNumbers: [], delimiter };
  const [head, ...body] = records;
  const headers = head.cells.map((h, i) => h.trim() || `Column ${i + 1}`);
  const rows = body.map((r) => headers.map((_, i) => unescapeFormula((r.cells[i] ?? '').trim())));
  return { headers, rows, rowNumbers: body.map((r) => r.n), delimiter };
}

const FORMULA = /^[=+\-@\t\r]/;
/** Undo the `'` that toCsv adds in front of formula-like values, so an exported error file can be fixed and re-imported. */
const unescapeFormula = (s: string) => (/^'[=+\-@]/.test(s) ? s.slice(1) : s);

/** Serialise rows to CSV (comma, CRLF). Cells that a spreadsheet would run as a formula are prefixed with `'`. */
export function toCsv(rows: (string | number | boolean | null | undefined)[][]): string {
  const esc = (v: string | number | boolean | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    const safe = FORMULA.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}
