import { OperationReceipt } from "../models/OperationReceipt.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import type { PrescriptionQuantitySnapshot } from "./PrescriptionQuantityService.ts";

export interface PrescriptionAllocation {
  prescriptionId: string; medicineId: string; quantity: number;
  expectedFulfillmentRevision?: number; expectedRemainingQuantity?: number;
}

export interface PharmacyDispenseInput {
  patientId: string;
  locationId: string;
  doctorId?: string;
  items: Array<{ medicineId: string; quantity: number }>;
  prescriptionIds?: string[];
  prescriptionAllocations?: PrescriptionAllocation[];
  encounterId?: string;
  appointmentId?: string;
}
export interface PharmacyDispenseAuthority { organizationId: string; locationId: string; actorId: string }
export interface PharmacyDispenseAllocation {
  medicineId: string;
  quantity: number;
  lineAmount: number;
  batches: Array<{ batchId: string; batchNumber: string; quantity: number }>;
}
interface DispenseWriteResult {
  invoice: any;
  addedAmount: number;
  appendedToExisting: boolean;
  allocations: PharmacyDispenseAllocation[];
  prescriptionProgress?: PrescriptionQuantitySnapshot[];
}

export function validateDispenseKey(key: string) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(400, "Use a stable dispense reference containing 8–100 letters, digits, underscores or hyphens");
}
function dispenseScope(authority: PharmacyDispenseAuthority) {
  return `pharmacy-dispense:${authority.organizationId}:${authority.locationId}`;
}
export function normalizeDispenseInput(input: PharmacyDispenseInput): PharmacyDispenseInput {
  return {
    patientId: input.patientId.toLowerCase(), locationId: input.locationId.toLowerCase(),
    ...(input.doctorId ? { doctorId: input.doctorId.toLowerCase() } : {}),
    ...(input.encounterId ? { encounterId: input.encounterId.toLowerCase() } : {}),
    ...(input.appointmentId ? { appointmentId: input.appointmentId.toLowerCase() } : {}),
    items: input.items.map(item => ({ medicineId: item.medicineId.toLowerCase(), quantity: item.quantity }))
      .sort((left, right) => left.medicineId.localeCompare(right.medicineId)),
    prescriptionIds: (input.prescriptionIds || []).map(id => id.toLowerCase()).sort(),
    ...(input.prescriptionAllocations ? { prescriptionAllocations: input.prescriptionAllocations.map(item => ({
      prescriptionId: item.prescriptionId.toLowerCase(), medicineId: item.medicineId.toLowerCase(), quantity: item.quantity,
      ...(item.expectedFulfillmentRevision !== undefined ? { expectedFulfillmentRevision: item.expectedFulfillmentRevision } : {}),
      ...(item.expectedRemainingQuantity !== undefined ? { expectedRemainingQuantity: item.expectedRemainingQuantity } : {}),
    })).sort((left, right) => left.prescriptionId.localeCompare(right.prescriptionId)) } : {}),
  };
}

/** Read the committed encrypted snapshot, never today's mutable invoice or stock. */
export async function getDispenseOperation(authority: PharmacyDispenseAuthority, key: string) {
  validateDispenseKey(key);
  const receipt = await OperationReceipt.findOne({ scope: dispenseScope(authority), key }).select("+responseCiphertext").lean();
  if (!receipt?.resultId) throw new CommandError(404, "No committed dispense is visible. Keep this reference and check again; do not start another bill.");
  if (!receipt.responseCiphertext) throw new CommandError(409, "Dispense is recorded but its result requires review. Keep the same reference.");
  let snapshot: any;
  try { snapshot = JSON.parse(decryptField(receipt.responseCiphertext)); }
  catch { throw new CommandError(409, "Dispense result requires review. Keep the same reference."); }
  if (snapshot?.actorId !== authority.actorId) throw new CommandError(404, "No committed dispense is visible for this operator. Keep the same reference and request review.");
  if (snapshot?.version !== 1 || snapshot.organizationId !== authority.organizationId || snapshot.locationId !== authority.locationId ||
      snapshot.actorId !== authority.actorId || snapshot.key !== key || String(snapshot.data?.dispenseOperation?.invoiceId) !== String(receipt.resultId)) {
    throw new CommandError(409, "Dispense result requires review. Keep the same reference.");
  }
  return snapshot.data;
}

/** Claim, business writes and replay snapshot all share the existing receipt transaction. */
export async function executePharmacyDispense(
  authority: PharmacyDispenseAuthority,
  key: string,
  input: PharmacyDispenseInput,
  write: (normalized: PharmacyDispenseInput) => Promise<DispenseWriteResult>,
) {
  validateDispenseKey(key);
  const normalized = normalizeDispenseInput(input);
  if (normalized.locationId !== authority.locationId) throw new CommandError(404, "Location not found");
  const scope = dispenseScope(authority);
  const command = await executeRecordedCommand(scope, key, { version: 1, actorId: authority.actorId, ...normalized }, async () => {
    const result = await write(normalized);
    const invoiceId = String(result.invoice._id || result.invoice.id);
    const invoice = typeof result.invoice.toJSON === "function" ? result.invoice.toJSON() : result.invoice;
    if (![result.addedAmount, invoice.totalAmount].every(value => Number.isFinite(value) && value >= 0) ||
        (invoice.balanceDue !== undefined && (!Number.isFinite(invoice.balanceDue) || invoice.balanceDue < 0))) {
      throw new CommandError(409, "Dispense amounts require pricing review; no result can be recorded");
    }
    const data = { ...invoice, dispenseOperation: {
      version: 1, key, invoiceId, invoiceNumber: invoice.invoiceNumber, locationId: authority.locationId,
      addedAmount: result.addedAmount, appendedToExisting: result.appendedToExisting, allocations: result.allocations,
      ...(result.prescriptionProgress ? { prescriptionProgress: result.prescriptionProgress } : {}),
    } };
    const saved = await OperationReceipt.updateOne({ scope, key }, { $set: {
      responseCiphertext: JSON.stringify({ version: 1, ...authority, key, data }),
    } });
    if (saved.matchedCount !== 1) throw new CommandError(409, "Dispense receipt changed; retry with the same reference");
    return invoiceId;
  }, { writeConcern: { w: "majority" } });
  return { data: await getDispenseOperation(authority, key), replayed: command.replayed };
}
