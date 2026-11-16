import { Counter } from "../models/Counter.ts";
import { InvoiceSeries } from "../models/InvoiceSeries.ts";
import { Location } from "../models/Location.ts";
import { withTransaction } from "./transaction.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { indiaFinancialYear } from "./indiaFinancialYear.ts";
import { allocateConfiguredPharmacyNumber } from "../services/PharmacyInvoiceNumberingService.ts";
import type { PharmacyNumberSnapshot } from "./pharmacyInvoiceNumberFormat.ts";
export { indiaFinancialYear } from "./indiaFinancialYear.ts";

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

/** Pharmacy documents can use the owner's series; general clinical invoices keep their own allocator. */
export async function allocatePharmacyInvoiceNumber(locationId: string, at = new Date()): Promise<{ invoiceNumber: string; numberingVersion: number; financialYear: string; invoiceSeries: string; numberingSnapshot?: PharmacyNumberSnapshot }> {
  return withTransaction(async () => {
    const configured = await allocateConfiguredPharmacyNumber(locationId, at);
    if (!configured) return allocateInvoiceNumber(locationId, at);
    // Credit notes and opening balances keep their separate reserved branch series.
    await reserveBranchSeries(locationId);
    return configured;
  });
}

/** Permanent server reservation; unused/expired numbers are never given back. */
export async function reserveOfflinePharmacyNumbers(locationId: string, count: number, at: Date) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new CommandError(400, "Reserve between 1 and 1000 invoice numbers");
  return withTransaction(async session => {
    if (!session?.inTransaction()) throw new CommandError(503, "Offline number reservation requires database transactions");
    const configured = await allocateConfiguredPharmacyNumber(locationId, at, count), reservation = await reserveBranchSeries(locationId), year = indiaFinancialYear(at);
    if (configured) return { prefix: configured.invoiceSeries, financialYear: year.label, first: configured.numberingSnapshot.sequence - count + 1,
      last: configured.numberingSnapshot.sequence, format: { prefixTemplate: configured.numberingSnapshot.prefixTemplate, digits: configured.numberingSnapshot.digits,
        resetPolicy: configured.numberingSnapshot.resetPolicy, configurationRevision: configured.numberingSnapshot.configurationRevision } };
    const key = `invoice-v2:${reservation.series}:${year.start}`;
    await Counter.updateOne({ id: key }, { $setOnInsert: { seq: 0 } }, { upsert: true });
    const counter = await Counter.findOneAndUpdate({ id: key, seq: { $gte: 0, $lte: 999999 - count } }, { $inc: { seq: count } }, { returnDocument: "after" });
    if (!counter || !Number.isSafeInteger(counter.seq)) throw new CommandError(409, "Invoice series cannot fit this reservation");
    return { prefix: `I${reservation.series}${year.code}/`, financialYear: year.label, first: counter.seq - count + 1, last: counter.seq };
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
