import { MEDICINE_BASE_UNITS } from "../utilities/medicineCatalogue.ts";
import { CommandError } from "./CommandReceiptService.ts";
export const MAX_PRESCRIPTION_QUANTITY = 1_000_000;
export interface PrescriptionQuantityState {
  mode: "quantity" | "single"; authorizedQuantity: number | null; suppliedQuantity: number; remainingQuantity: number | null;
  baseUnit: string | null; revision: number; medicineId: string | null; authorizationBasis: "sealed_prescriber" | "single_supply";
}
export interface PrescriptionQuantitySnapshot extends PrescriptionQuantityState {
  prescriptionId: string; suppliedNow: number; suppliedAfter: number; remainingAfter: number; revisionAfter: number; completed: boolean;
}
const review = () => new CommandError(409, "Prescription quantity evidence changed or needs review; reload the finalized source before supplying");
/** Explicit prescriber entry only; never derive an allowance from instructions. */
export function prescriptionQuantityInput(input: { authorizedQuantity?: unknown; authorizedBaseUnit?: unknown }) {
  if (input.authorizedQuantity == null && input.authorizedBaseUnit == null) return { authorizedQuantity: undefined, authorizedBaseUnit: undefined };
  if (typeof input.authorizedQuantity !== "number" || !Number.isSafeInteger(input.authorizedQuantity) || input.authorizedQuantity < 1 || input.authorizedQuantity > MAX_PRESCRIPTION_QUANTITY ||
      typeof input.authorizedBaseUnit !== "string" || !MEDICINE_BASE_UNITS.includes(input.authorizedBaseUnit as any)) throw new CommandError(400, "Enter an explicit whole authorized quantity and its base unit");
  return { authorizedQuantity: input.authorizedQuantity, authorizedBaseUnit: input.authorizedBaseUnit };
}
export function prescriptionQuantityState(rx: any): PrescriptionQuantityState {
  const suppliedQuantity = rx.suppliedQuantity ?? 0, revision = rx.fulfillmentRevision ?? 0;
  if (![suppliedQuantity, revision].every(value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER)) throw review();
  const total = rx.authorizedQuantity, baseUnit = rx.authorizedBaseUnit;
  if (total == null && baseUnit == null) return { mode: "single", authorizedQuantity: null, suppliedQuantity, remainingQuantity: null, baseUnit: null, revision,
    medicineId: rx.fulfillmentMedicineId ? String(rx.fulfillmentMedicineId) : null, authorizationBasis: "single_supply" };
  if (!Number.isSafeInteger(total) || total < 1 || total > MAX_PRESCRIPTION_QUANTITY || !MEDICINE_BASE_UNITS.includes(baseUnit) || suppliedQuantity > total) throw review();
  return { mode: "quantity", authorizedQuantity: total, suppliedQuantity, remainingQuantity: total - suppliedQuantity, baseUnit, revision,
    medicineId: rx.fulfillmentMedicineId ? String(rx.fulfillmentMedicineId) : rx.medicineId ? String(rx.medicineId) : null, authorizationBasis: "sealed_prescriber" };
}
export function prescriptionSupplySnapshot(rx: any, allocation: { medicineId: string; quantity: number; expectedFulfillmentRevision?: number; expectedRemainingQuantity?: number }): PrescriptionQuantitySnapshot {
  const state = prescriptionQuantityState(rx);
  if (!Number.isSafeInteger(allocation.quantity) || allocation.quantity < 1 || state.revision >= Number.MAX_SAFE_INTEGER - 1 ||
      allocation.expectedFulfillmentRevision !== undefined && allocation.expectedFulfillmentRevision !== state.revision) throw review();
  if (state.mode === "quantity") {
    if (allocation.expectedFulfillmentRevision !== state.revision || allocation.expectedRemainingQuantity !== state.remainingQuantity || allocation.quantity > state.remainingQuantity! ||
        state.medicineId && state.medicineId !== allocation.medicineId) throw review();
  } else if (state.suppliedQuantity > 0 || rx.pharmacyDispenseId) throw review();
  const suppliedAfter = state.suppliedQuantity + allocation.quantity;
  if (!Number.isSafeInteger(suppliedAfter)) throw review();
  return { ...state, prescriptionId: String(rx._id), suppliedNow: allocation.quantity, suppliedAfter,
    remainingAfter: state.mode === "quantity" ? state.authorizedQuantity! - suppliedAfter : 0, revisionAfter: state.revision + 1,
    completed: state.mode === "single" || state.authorizedQuantity === suppliedAfter };
}
