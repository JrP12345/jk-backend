import { CommandError } from "../services/CommandReceiptService.ts";

export const PHARMACY_CSV_LIMITS = { bytes: 512_000, rows: 200, columns: 40, cellCharacters: 2000 } as const;
export interface PharmacyCsvRecord { sourceLine: number; cells: Record<string, string> }

/** Bounded RFC-style CSV: literal strings preserve barcodes, dates and decimal intent.
 * No expression evaluation, delimiter guessing, spreadsheet formula execution or coercion. */
export function parsePharmacyCsv(input: unknown): { headers: string[]; records: PharmacyCsvRecord[] } {
  if (typeof input !== "string" || !input.length || Buffer.byteLength(input, "utf8") > PHARMACY_CSV_LIMITS.bytes) throw new CommandError(400, "Provide a UTF-8 CSV of at most 512,000 bytes");
  const source = input.replace(/^\uFEFF/, "");
  if (/[\uD800-\uDFFF]/u.test(source)) throw new CommandError(400, "CSV must contain valid Unicode text");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(source)) throw new CommandError(400, "CSV contains unsupported control characters");
  const rows: Array<{ sourceLine: number; cells: string[] }> = [];
  let cells: string[] = [], cell = "", quoted = false, closed = false, line = 1, rowLine = 1, recordStarted = false;
  const invalid = (reason: string): never => { throw new CommandError(400, `CSV line ${line}: ${reason}`); };
  const append = (value: string) => {
    cell += value;
    if (cell.length > PHARMACY_CSV_LIMITS.cellCharacters) invalid("a field exceeds 2,000 characters");
  };
  const finishCell = () => {
    cells.push(cell); cell = ""; closed = false;
    if (cells.length > PHARMACY_CSV_LIMITS.columns) invalid("more than 40 columns");
  };
  const finishRow = () => {
    finishCell();
    // Empty physical lines may surround records; explicit empty cells are data.
    if (recordStarted || cells.length > 1 || cells[0] !== "") rows.push({ sourceLine: rowLine, cells });
    if (rows.length > PHARMACY_CSV_LIMITS.rows + 1) invalid("more than 200 data records");
    cells = []; recordStarted = false;
  };
  for (let index = 0; index < source.length; index++) {
    const character = source[index], newline = character === "\r" || character === "\n";
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { append('"'); index++; }
        else { quoted = false; closed = true; }
      } else if (newline) {
        if (character === "\r" && source[index + 1] === "\n") index++;
        append("\n"); line++;
      } else append(character);
      continue;
    }
    if (character === ",") { recordStarted = true; finishCell(); continue; }
    if (newline) {
      finishRow();
      if (character === "\r" && source[index + 1] === "\n") index++;
      line++; rowLine = line; continue;
    }
    if (closed) invalid("unexpected text after a closing quote");
    if (character === '"') {
      if (cell.length) invalid("a quote must begin a field");
      quoted = true; recordStarted = true;
    } else { append(character); recordStarted = true; }
  }
  if (quoted) invalid("unterminated quoted field");
  if (recordStarted || cells.length || cell.length || closed) finishRow();
  if (rows.length < 2) throw new CommandError(400, "CSV needs a header and at least one data record");
  const headers = rows[0].cells.map(header => header.normalize("NFKC").trim());
  if (headers.some(header => !header || header.length > 100 || /[\r\n\t]/u.test(header)) || new Set(headers).size !== headers.length) throw new CommandError(400, "CSV headers must be distinct, nonempty names of at most 100 characters");
  return { headers, records: rows.slice(1).map(row => {
    if (row.cells.length !== headers.length) throw new CommandError(400, `CSV line ${row.sourceLine}: expected ${headers.length} fields, received ${row.cells.length}`);
    // Object.fromEntries safely retains literal __proto__/constructor headers.
    return { sourceLine: row.sourceLine, cells: Object.fromEntries(headers.map((header, index) => [header, row.cells[index]])) };
  }) };
}

export function csvWhole(value: string, name: string, maximum = Number.MAX_SAFE_INTEGER) {
  const trimmed = value.trim();
  if (!/^\d{1,16}$/.test(trimmed)) throw new CommandError(400, `${name} must be an explicit whole number`);
  const quantity = Number(trimmed);
  if (!Number.isSafeInteger(quantity) || quantity > maximum) throw new CommandError(400, `${name} exceeds its safe bound`);
  return quantity;
}
export function csvPaise(value: string, name: string, maximum = 100_000_000_000) {
  const trimmed = value.trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(trimmed)) throw new CommandError(400, `${name} must be an explicit non-negative INR amount with at most two decimal places`);
  const [whole, fraction = ""] = trimmed.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount > BigInt(maximum)) throw new CommandError(400, `${name} exceeds its safe bound`);
  return Number(amount);
}
