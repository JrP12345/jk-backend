import { CommandError } from "./CommandReceiptService.ts";
import * as calculation from "../utilities/pharmacyCalculation.ts";

// One pure calculation source serves Node and the generated browser artifact.
// Keep the established HTTP/service error contract at this server boundary.
export { PHARMACY_CALCULATION_POLICY } from "../utilities/pharmacyCalculation.ts";
export { PHARMACY_CALCULATION_ENGINE_SHA256 } from "../utilities/pharmacyCalculationVersion.ts";
export type { RationalPaise, CalculationLine, PharmacyCalculationInput, PharmacyCalculation, PharmacyTaxMode } from "../utilities/pharmacyCalculation.ts";
function checked<T>(work: () => T): T {
  try { return work(); }
  catch (failure) {
    if (failure instanceof calculation.PharmacyCalculationError) throw new CommandError(409, failure.message);
    throw failure;
  }
}
export const calculatePharmacyDocument = (...args: Parameters<typeof calculation.calculatePharmacyDocument>) => checked(() => calculation.calculatePharmacyDocument(...args));
export const splitPharmacyTax = (...args: Parameters<typeof calculation.splitPharmacyTax>) => checked(() => calculation.splitPharmacyTax(...args));
export const allocateSourceCredit = (...args: Parameters<typeof calculation.allocateSourceCredit>) => checked(() => calculation.allocateSourceCredit(...args));
export const cumulativeSourceCredit = (...args: Parameters<typeof calculation.cumulativeSourceCredit>) => checked(() => calculation.cumulativeSourceCredit(...args));
