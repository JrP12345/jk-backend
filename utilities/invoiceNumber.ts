import { getNextAtomicSequence } from "../models/Counter.ts";

/**
 * Allocates a yearly invoice sequence for a location.
 * Format: INV-{year}-{locationSuffix}-{seq}.
 * The global invoiceNumber index enforces uniqueness.
 */
export async function generateLocationInvoiceNumber(
  locationId: string,
  year?: number
): Promise<string> {
  const invoiceYear = year ?? new Date().getFullYear();
  const locationSuffix = locationId.slice(-6).toUpperCase();
  const counterId = `invoice_${locationId}_${invoiceYear}`;
  const seq = await getNextAtomicSequence(counterId);
  return `INV-${invoiceYear}-${locationSuffix}-${seq.toString().padStart(6, "0")}`;
}
