import { Appointment } from "../models/Appointment.ts";
import { AppointmentPayment } from "../models/AppointmentPayment.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Patient } from "../models/Patient.ts";
import { AppointmentDomainError } from "./AppointmentService.ts";
import { razorpayService } from "./billing/RazorpayService.ts";
import { withClinicalTransaction } from "../utilities/transaction.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";

/** One full online capture only. Mixed/cash/foreign receipts require billing review. */
export async function onlineRefundSource(appointment: any, invoice: any) {
  if (!invoice || invoice.status !== "paid" || invoice.currency !== "INR"
    || String(invoice.patientId) !== String(appointment.patientId?._id || appointment.patientId)
    || String(invoice.clinicId) !== String(appointment.clinicId?._id || appointment.clinicId)) return null;
  const receipt = invoice.payments?.length === 1 ? invoice.payments[0] : null;
  const captures = await AppointmentPayment.find({ status: "captured", paymentMethod: "razorpay",
    $or: [{ appointmentId: appointment._id }, { invoiceId: invoice._id }],
  }).limit(2);
  const capture = captures.length === 1 ? captures[0] : null;
  const paymentId = capture?.razorpayPaymentId || (captures.length === 0 ? receipt?.referenceNumber : "") || "";
  const amount = Number(capture?.amount ?? receipt?.amount ?? 0);
  const valid = capture
    ? capture.currency === "INR" && String(capture.patientId) === String(invoice.patientId)
      && (!invoice.payments?.length || (receipt?.paymentMethod === "online" && receipt.referenceNumber === paymentId))
    : captures.length === 0 && receipt?.paymentMethod === "online";
  return valid && /^pay_[A-Za-z0-9]+$/.test(paymentId) && Number.isFinite(amount) && amount > 0
    && Math.round(amount * 100) === Math.round(Number(invoice.amountPaid) * 100)
    ? { paymentId, amount, currency: "INR" } : null;
}

/** Reads gateway evidence; never initiates or retries an external refund. */
export async function reconcileAppointmentRefund(appointmentId: string, actorId: string) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw new AppointmentDomainError("Appointment not found", 404);
  if (appointment.paymentStatus === "refunded") return { status: "processed", replayed: true };
  if (appointment.status !== "cancelled" || appointment.paymentStatus !== "refund_pending") {
    throw new AppointmentDomainError("This visit is not awaiting a refund", 409);
  }
  const invoice = await Invoice.findOne({ appointmentId: appointment._id });
  const source = await onlineRefundSource(appointment, invoice);
  if (!source) return { status: "review", message: "Billing must review the original payment receipts; no refund was issued." };
  const evidence = await razorpayService.fetchPaymentRefunds(source.paymentId);
  const refunds = evidence.items;
  if (!Array.isArray(refunds) || refunds.length !== 1) {
    return { status: "review", message: "No single full refund can be confirmed. Check the provider ledger before any further action." };
  }
  const refund = refunds[0];
  if (!/^rfnd_[A-Za-z0-9]+$/.test(refund.id || "") || refund.payment_id !== source.paymentId
    || refund.currency !== source.currency || refund.amount !== Math.round(source.amount * 100)) {
    return { status: "review", message: "Provider refund does not match the original payment, amount or currency." };
  }
  if (refund.status !== "processed") {
    await AuditLog.create({ userId: actorId, organizationId: appointment.organizationId, action: "REFUND_STATUS_CHECKED",
      targetId: appointment._id, targetModel: "Appointment", category: "BILLING",
      details: { paymentId: source.paymentId, refundId: refund.id, providerStatus: refund.status, amount: source.amount } });
    return { status: refund.status === "pending" ? "pending" : "review", refundId: refund.id,
      message: refund.status === "pending" ? "The provider is still processing this refund." : "The refund needs billing review. No retry was issued." };
  }
  return withClinicalTransaction(async () => {
    const current = await Appointment.findById(appointmentId);
    if (current?.paymentStatus === "refunded") return { status: "processed", replayed: true, refundId: refund.id };
    const currentInvoice = await Invoice.findById(invoice._id);
    const currentSource = current && await onlineRefundSource(current, currentInvoice);
    if (!current || current.status !== "cancelled" || current.paymentStatus !== "refund_pending"
      || !currentSource || currentSource.paymentId !== source.paymentId || currentSource.amount !== source.amount) {
      throw new AppointmentDomainError("Payment records changed during reconciliation; refresh and review", 409);
    }
    current.paymentStatus = "refunded";
    current.triageAction = "refunded";
    currentInvoice.status = "refunded";
    await current.save();
    await currentInvoice.save();
    await AuditLog.create({ userId: actorId, organizationId: current.organizationId, action: "REFUND_RECONCILED",
      targetId: currentInvoice._id, targetModel: "Invoice", category: "BILLING",
      details: { appointmentId, paymentId: source.paymentId, refundId: refund.id, amount: source.amount, currency: source.currency } });
    const patient = await Patient.findById(current.patientId).select("userId");
    await eventBus.publishDurable({ eventId: `refund-confirmed:${refund.id}`, eventType: EVENT_TYPES.PATIENT_DISRUPTION_REFUNDED,
      category: "billing", organizationId: current.organizationId?.toString(), targetUserId: patient?.userId?.toString(),
      title: "Refund processed", message: `Your refund of INR ${source.amount} has been confirmed by the payment provider.`,
      severity: "info", actionUrl: "/dashboard/bills", metadata: { appointmentId, refundId: refund.id, refundAmount: source.amount } });
    return { status: "processed", replayed: false, refundId: refund.id, message: "The provider confirmed the refund." };
  });
}
