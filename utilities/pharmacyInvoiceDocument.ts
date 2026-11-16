import { CommandError } from "../services/CommandReceiptService.ts";

/** Join the invoice to its captured supply evidence, never to today's product catalogue. */
export function counterInvoiceDocument(invoice: any, source: { lines: any[] }) {
  if (source.lines.length !== invoice.items.length) throw new CommandError(409, "Counter invoice source evidence needs review");
  const byId = new Map(source.lines.map(line => [String(line._id), line]));
  const items = invoice.items.map((item: any) => {
    const line = byId.get(String(item.pharmacyDispenseLineId));
    if (!line) throw new CommandError(409, "Counter invoice source line needs review");
    return { ...item, unitSnapshot: line.unitSnapshot, batches: line.pricingAllocations.map((lot: any) => ({ batchId: lot.batchId, batchNumber: lot.batchNumber, expiryValue: lot.expiryValue, expiryPrecision: lot.expiryPrecision, quantity: lot.quantity, sellingPricePaise: Math.round(lot.unitPrice * 100), mrpPaise: lot.mrpPaise })) };
  });
  const { _id, __v: _version, ...fields } = invoice;
  return { ...fields, id: String(_id), items };
}
