import { getNextAtomicSequence } from "../models/Counter.ts";

/**
 * Generates a globally unique invoice number scoped to a clinic's yearly sequence.
 * Format: INV-{year}-{clinicSuffix}-{seq} — clinicSuffix avoids cross-clinic collisions
 * on the global invoiceNumber unique index while keeping per-clinic counters.
 */
export async function generateClinicInvoiceNumber(
  clinicId: string,
  year?: number
): Promise<string> {
  const invoiceYear = year ?? new Date().getFullYear();
  const clinicSuffix = clinicId.slice(-6).toUpperCase();
  const counterId = `invoice_${clinicId}_${invoiceYear}`;
  const seq = await getNextAtomicSequence(counterId);
  return `INV-${invoiceYear}-${clinicSuffix}-${seq.toString().padStart(6, "0")}`;
}
