import { Counter } from "../models/Counter.ts";
import { InvoiceSeries } from "../models/InvoiceSeries.ts";
import { Location } from "../models/Location.ts";
import { withTransaction } from "./transaction.ts";
import { CommandError } from "../services/CommandReceiptService.ts";

export function indiaFinancialYear(at = new Date()) {
  if (!Number.isFinite(at.getTime())) throw new CommandError(409, "Invalid invoice issue date");
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "numeric" }).formatToParts(at);
  const year = Number(parts.find(part => part.type === "year")!.value);
  const month = Number(parts.find(part => part.type === "month")!.value);
  const start = month >= 4 ? year : year - 1;
  if (start < 2000 || start > 2098) throw new CommandError(409, "Invoice financial year needs a reviewed numbering version");
  return { start, label: `${start}-${String(start + 1).slice(-2)}`, code: `${String(start).slice(-2)}${String(start + 1).slice(-2)}` };
}

async function nextBounded(id: string, max: number) {
  await Counter.updateOne({ id }, { $setOnInsert: { seq: 0 } }, { upsert: true });
  const counter = await Counter.findOneAndUpdate({ id, seq: { $gte: 0, $lt: max } }, { $inc: { seq: 1 } }, { returnDocument: "after" });
  if (!counter || !Number.isSafeInteger(counter.seq)) throw new CommandError(409, "Invoice series exhausted or invalid; review numbering before issuing another document");
  return counter.seq;
}

async function reserveBranchSeries(locationId: string) {
    if (!await Location.exists({ _id: locationId })) throw new CommandError(404, "Invoice location not found");
    let reservation = await InvoiceSeries.findOne({ locationId });
    if (!reservation) {
      const sequence = await nextBounded("invoice-series-v2", 36 ** 4 - 1);
      reservation = await InvoiceSeries.create({ locationId, series: sequence.toString(36).toUpperCase().padStart(4, "0") });
    }
    return reservation;
}
export async function allocateInvoiceNumber(locationId: string, at = new Date()) {
  const fiscal = indiaFinancialYear(at);
  return withTransaction(async () => {
    const reservation = await reserveBranchSeries(locationId);
    const sequence = await nextBounded(`invoice-v2:${reservation.series}:${fiscal.start}`, 999999);
    return { invoiceNumber: `I${reservation.series}${fiscal.code}/${String(sequence).padStart(6, "0")}`,
      numberingVersion: 2, financialYear: fiscal.label, invoiceSeries: reservation.series };
  });
}

// Existing callers keep their string contract. Previously persisted numbers are never rewritten.
export async function generateLocationInvoiceNumber(locationId: string, year?: number): Promise<string> {
  return (await allocateInvoiceNumber(locationId, year === undefined ? new Date() : new Date(Date.UTC(year, 3, 1)))).invoiceNumber;
}

/** Separate bounded credit sequence; the source invoice already reserved the branch series. */
export async function allocateCreditNoteNumber(locationId: string, at = new Date()) {
  const fiscal = indiaFinancialYear(at), reservation = await InvoiceSeries.findOne({ locationId });
  if (!reservation) throw new CommandError(409, "Source branch numbering series needs review");
  const sequence = await nextBounded(`credit-note-v1:${reservation.series}:${fiscal.start}`, 999999);
  return `C${reservation.series}${fiscal.code}/${String(sequence).padStart(6, "0")}`;
}
export async function allocateOpeningBalanceNumber(locationId: string, at = new Date()) {
  const fiscal = indiaFinancialYear(at);
  return withTransaction(async () => {
    const reservation = await reserveBranchSeries(locationId), sequence = await nextBounded(`opening-balance-v1:${reservation.series}:${fiscal.start}`, 999999);
    return { statementNumber: `O${reservation.series}${fiscal.code}/${String(sequence).padStart(6, "0")}`, numberingVersion: 1, financialYear: fiscal.label, invoiceSeries: reservation.series };
  });
}
