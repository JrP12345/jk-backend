import { Encounter } from "../models/Encounter.ts";
import { Invoice } from "../models/Invoice.ts";
import { CommandError } from "./CommandReceiptService.ts";

/** Read the canonical posted bills in the caller's transaction, including separate pharmacy documents. */
export async function visitInvoicePaymentStatus(appointment: any): Promise<"paid" | "partially_paid" | "unpaid"> {
  const scope = { organizationId: appointment.organizationId, locationId: appointment.locationId, patientId: appointment.patientId };
  const encounters = await Encounter.find({ ...scope, appointmentId: appointment._id }).select("_id").lean();
  const invoices = await Invoice.find({ ...scope, deletedAt: null, status: { $nin: ["cancelled", "refunded"] },
    $or: [{ appointmentId: appointment._id }, { encounterId: { $in: encounters.map(encounter => encounter._id) } }],
  }).select("totalAmount amountPaid").lean();
  if (invoices.some(invoice => !Number.isFinite(invoice.totalAmount) || invoice.totalAmount < 0 || !Number.isFinite(invoice.amountPaid || 0))) {
    throw new CommandError(409, "Visit invoices require financial review");
  }
  const outstanding = invoices.reduce((sum, invoice) => sum + Math.max(0, invoice.totalAmount - (invoice.amountPaid || 0)), 0);
  const paid = invoices.reduce((sum, invoice) => sum + (invoice.amountPaid || 0), 0);
  return outstanding <= 0 ? "paid" : paid > 0 ? "partially_paid" : "unpaid";
}
