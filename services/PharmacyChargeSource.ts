import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { Invoice } from "../models/Invoice.ts";
import { Prescription } from "../models/Prescription.ts";
import { finalizedPrescriptionSelection } from "./FinalizedPrescriptionSelection.ts";
import { CommandError } from "./CommandReceiptService.ts";
import type { CapturedChargeItem } from "./ChargeCaptureService.ts";
import { prescriptionQuantityState } from "./PrescriptionQuantityService.ts";

/** Unknown legacy charges need review, never name/description-based reconciliation. */
export function requireKnownClinicalCharges(invoice: any) {
  if (invoice && invoice.clinicalChargeVersion !== 1) {
    throw new CommandError(409, "The existing visit invoice has no verified charge provenance. Review it before adding or recompiling pharmacy charges.");
  }
}

export async function compilePharmacySupplyCharges(encounter: any, targetInvoiceId?: string) {
  const scope = { organizationId: encounter.organizationId, locationId: encounter.locationId,
    patientId: encounter.patientId, encounterId: encounter._id };
  const supplies = await PharmacyDispense.find(scope).sort({ createdAt: 1 }).lean();
  const invoices = supplies.length ? await Invoice.find({ _id: { $in: supplies.map(supply => supply.invoiceId) },
    organizationId: scope.organizationId, locationId: scope.locationId, patientId: scope.patientId }).lean() : [];
  const byId = new Map(invoices.map(invoice => [String(invoice._id), invoice]));
  const items: CapturedChargeItem[] = [];
  const pharmacyInvoices: Array<{ invoiceId: string; dispenseId: string; totalAmount: number }> = [];
  for (const supply of supplies) {
    const invoice = byId.get(String(supply.invoiceId));
    if (!invoice || invoice.deletedAt || ["cancelled", "refunded"].includes(invoice.status)) {
      throw new CommandError(409, "A supplied medicine has an unavailable or adjusted invoice. Review its original supply; do not recreate its charge.");
    }
    for (const line of supply.lines) {
      const linked = invoice.items.filter((item: any) => String(item.pharmacyDispenseLineId) === String(line._id) && String(item.pharmacyDispenseId) === String(supply._id));
      if (linked.length !== 1 || linked[0].quantity !== line.quantity || linked[0].amount !== line.amount || linked[0].gstRate !== line.gstRate) {
        throw new CommandError(409, "A supplied medicine charge differs from its committed source. Review the linked invoice before checkout.");
      }
      if (line.baseAmountPaise != null && (invoice.documentVersion !== 1 || !invoice.issuedAt || invoice.taxDocument?.version !== 1 ||
          ["baseAmountPaise", "cgstPaise", "sgstPaise", "grossAmountPaise", "hsnSacCode", "unitCode"].some(key => (linked[0] as any)[key] !== (line as any)[key]))) {
        throw new CommandError(409, "Issued pharmacy tax fields differ from the committed supply; review the original document");
      }
      // Recompiling that invoice preserves the exact source line. Another bill never copies it.
      if (String(supply.invoiceId) === targetInvoiceId) items.push({
        pharmacyDispenseId: String(supply._id), pharmacyDispenseLineId: String(line._id),
        description: line.description, amount: line.amount, quantity: line.quantity,
        hsnSacCode: line.hsnSacCode, gstRate: line.gstRate, category: "pharmacy",
      });
    }
    pharmacyInvoices.push({ invoiceId: String(supply.invoiceId), dispenseId: String(supply._id),
      totalAmount: supply.lines.reduce((sum, line) => sum + line.lineAmount, 0) });
  }
  const unfilledPrescriptions = await Prescription.find({ ...await finalizedPrescriptionSelection({ organizationId: scope.organizationId,
    locationId: scope.locationId, patientId: scope.patientId }, encounter._id), status: "active" }).select("medicineName medicineId authorizedQuantity authorizedBaseUnit suppliedQuantity fulfillmentRevision fulfillmentMedicineId").lean();
  return { items, pharmacyInvoices, unfilledPrescriptions: unfilledPrescriptions.map(rx => ({ prescriptionId: String(rx._id), medicineName: rx.medicineName,
    ...(rx.authorizedQuantity != null ? { fulfillment: prescriptionQuantityState(rx) } : {}) })) };
}
