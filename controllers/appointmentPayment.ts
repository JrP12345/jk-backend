import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { AppointmentPayment } from "../models/AppointmentPayment.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Invoice } from "../models/Invoice.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { razorpayService } from "../services/billing/RazorpayService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkOperationalRecordAccess, checkPatientAccess } from "../utilities/tenant.ts";
import { requestHasAnyPermission, BILLING_STAFF_PAYMENT_PERMISSIONS } from "../utilities/permissions.ts";
import { broadcastQueueUpdate } from "../notifications/websocket.ts";
import { withClinicalTransaction } from "../utilities/transaction.ts";
import { AppointmentDomainError } from "../services/AppointmentService.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { resilientHttpClient } from "../utilities/resilientHttpClient.ts";
import { reconcileAppointmentRefund } from "../services/AppointmentRefundService.ts";

export async function reconcileRefund(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId } = req.body as { appointmentId?: string };
    if (!appointmentId || !mongoose.Types.ObjectId.isValid(appointmentId)) return reply.code(400).send(errorResponse("Invalid appointment ID"));
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) return reply.code(404).send(errorResponse("Appointment not found"));
    const access = await checkOperationalRecordAccess(req, appointment);
    if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
    return reply.send(successResponse(await reconcileAppointmentRefund(appointmentId, req.user!.id)));
  } catch (error) {
    if (error instanceof AppointmentDomainError) return reply.code(error.statusCode).send(errorResponse(error.message));
    req.log.error({ err: error }, "Refund reconciliation failed");
    return reply.code(502).send(errorResponse("Could not confirm the provider refund. Payment remains pending review."));
  }
}

async function authorizeAppointmentAccess(
  req: FastifyRequest,
  appointment: {
    bookedByUserId?: mongoose.Types.ObjectId | string | null;
    patientId: mongoose.Types.ObjectId | string;
    clinicId?: mongoose.Types.ObjectId | string;
    organizationId?: mongoose.Types.ObjectId | string | null;
  }
): Promise<boolean> {
  const userId = req.user!.id;
  const userRole = req.user!.role;

  if (userRole === "root") return true;

  if (["patient", "family_member", "guest"].includes(userRole)) {
    if (appointment.bookedByUserId?.toString() === userId) return true;
    return userRole !== "guest" && (await checkPatientAccess(req, String(appointment.patientId))).allowed;
  }
  const clinicCheck = await checkOperationalRecordAccess(req, appointment);
  if (!clinicCheck.allowed) return false;
  return requestHasAnyPermission(req, ...BILLING_STAFF_PAYMENT_PERMISSIONS);
}

/** One settlement owner for browser verification and staff reconciliation. */
async function settleAppointmentPayment(paymentId: string, transactionId: string, actorId: string, signature?: string,
  capture?: { amount: number; currency: string; order_id: string }) {
  return withClinicalTransaction(async () => {
    const payment = await AppointmentPayment.findById(paymentId);
    if (!payment) throw new AppointmentDomainError("Payment record not found", 404);
    const appointment = await Appointment.findById(payment.appointmentId);
    if (!appointment) throw new AppointmentDomainError("Appointment not found", 404);
    if (payment.status === "captured") {
      if (payment.razorpayPaymentId !== transactionId) throw new AppointmentDomainError("Payment order was captured by another transaction", 409);
      return { replayed: true, appointment };
    }
    if (!["created", "authorized"].includes(payment.status) || appointment.status === "cancelled"
      || ["refunded", "refund_pending", "paid"].includes(appointment.paymentStatus || "")) {
      throw new AppointmentDomainError("This visit is not eligible for payment settlement; contact billing", 409);
    }
    const invoice = payment.invoiceId ? await Invoice.findById(payment.invoiceId) : await Invoice.findOne({ appointmentId: appointment._id });
    if (!invoice || String(invoice.appointmentId) !== appointment.id || String(invoice.clinicId) !== String(appointment.clinicId)
      || String(payment.patientId) !== String(appointment.patientId) || String(invoice.patientId) !== String(appointment.patientId)
      || ["refunded", "cancelled"].includes(invoice.status)) {
      throw new AppointmentDomainError("Invoice is no longer eligible for this payment", 409);
    }
    const amount = Number(payment.amount);
    const outstanding = Number(invoice.balanceDue ?? Math.max(0, Number(invoice.totalAmount) - Number(invoice.amountPaid || 0)));
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== Math.round(outstanding * 100)
      || payment.currency !== (invoice.currency || "INR") || (capture && (capture.amount !== Math.round(amount * 100)
        || capture.currency !== payment.currency || capture.order_id !== payment.razorpayOrderId))) {
      throw new AppointmentDomainError("Payment amount, currency or order does not match the invoice", 409);
    }
    const claimed = await AppointmentPayment.updateOne({ _id: payment._id, status: payment.status },
      { $set: { status: "captured", razorpayPaymentId: transactionId, ...(signature ? { razorpaySignature: signature } : {}) } });
    if (!claimed.modifiedCount) throw new AppointmentDomainError("Payment changed while settling; refresh and retry", 409);
    appointment.paymentStatus = "paid";
    if (["pending_payment", "pending"].includes(appointment.status)) appointment.status = "confirmed";
    await appointment.save();
    invoice.status = "paid";
    invoice.amountPaid = Number(invoice.amountPaid || 0) + amount;
    invoice.balanceDue = 0;
    invoice.paymentMethod = "online";
    invoice.paymentDate = new Date();
    invoice.payments.push({ amount, paymentMethod: "online", referenceNumber: transactionId, paidAt: new Date() });
    await invoice.save();
    await AuditLog.create({ userId: actorId, organizationId: appointment.organizationId, action: "PAYMENT_RECONCILED",
      targetId: payment._id, targetModel: "AppointmentPayment", category: "ADMIN",
      details: { appointmentId: appointment._id, razorpayOrderId: payment.razorpayOrderId, razorpayPaymentId: transactionId, reconciliationOutcome: "captured_settled" } });
    return { replayed: false, appointment };
  });
}

// ─── POST /api/appointment-payments/create-order ─────────────────────
export async function createAppointmentPaymentOrder(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId } = req.body as { appointmentId: string };

    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (!(await authorizeAppointmentAccess(req, appointment))) {
      return reply.code(403).send(errorResponse("Unauthorized access to appointment"));
    }

    if (appointment.status === "cancelled" || ["refunded", "refund_pending"].includes(appointment.paymentStatus || "")) {
      return reply.code(409).send(errorResponse("This visit is not eligible for checkout"));
    }

    const clinic = await Clinic.findById(appointment.clinicId).select("organizationId").lean();
    const organizationId = clinic?.organizationId || appointment.organizationId;
    const organization = organizationId
      ? await Organization.findById(organizationId).select("countryCode currency").lean()
      : null;
    if (!organization || (organization.countryCode && organization.countryCode !== "IN") || (organization.currency && organization.currency !== "INR")) {
      return reply.code(409).send(errorResponse("Online checkout is not configured for this organization's country and currency"));
    }

    let invoice = await Invoice.findOne({ appointmentId: appointment._id });
    if (!invoice) {
      const assignment = await DoctorAssignment.findOne({ doctorId: appointment.doctorId, clinicId: appointment.clinicId });
      const fees = Number(assignment?.fees ?? appointment.paymentAmount ?? 0);
      if (!Number.isFinite(fees) || fees <= 0) {
        return reply.code(409).send(errorResponse("No payable consultation fee is configured for this appointment"));
      }
      const { generateClinicInvoiceNumber } = await import("../utilities/invoiceNumber.ts");
      const invoiceNumber = await generateClinicInvoiceNumber(appointment.clinicId.toString());
      invoice = await Invoice.create({
        invoiceNumber,
        patientId: appointment.patientId,
        appointmentId: appointment._id,
        clinicId: appointment.clinicId,
        doctorId: appointment.doctorId,
        organizationId: appointment.organizationId,
        items: [{ description: "Consultation Fee", amount: fees, quantity: 1 }],
        subtotal: fees,
        totalAmount: fees,
        status: "unpaid",
      });
    }

    if (invoice.status === "paid") {
      return reply.code(400).send(errorResponse("This appointment invoice has already been paid"));
    }

    if (!["unpaid", "partially_paid"].includes(invoice.status) || (invoice.currency || "INR") !== "INR"
      || String(invoice.patientId) !== String(appointment.patientId) || String(invoice.clinicId) !== String(appointment.clinicId)) {
      return reply.code(409).send(errorResponse("Invoice is not eligible for this checkout"));
    }
    const amountDue = Number(invoice.balanceDue ?? Math.max(0, invoice.totalAmount - Number(invoice.amountPaid || 0)));
    if (!Number.isFinite(amountDue) || amountDue <= 0) {
      return reply.code(409).send(errorResponse("Invoice has no payable balance"));
    }
    const idempotencyKey = `pay_order_${appointment._id.toString()}_${amountDue}`;

    const existingPayment = await AppointmentPayment.findOne({ idempotencyKey, status: "created" });
    if (existingPayment?.razorpayOrderId) {
      const publicParams = await razorpayService.getPublicParams();
      return reply.code(200).send(
        successResponse({
          razorpayOrderId: existingPayment.razorpayOrderId,
          keyId: publicParams.keyId,
          amount: existingPayment.amount,
          currency: existingPayment.currency,
          appointmentId: appointment.id,
        })
      );
    }

    const razorpayOrder = await razorpayService.createOrder({
      amount: amountDue,
      currency: "INR",
      receipt: invoice.invoiceNumber,
      notes: {
        appointmentId: appointment.id,
        patientId: appointment.patientId.toString(),
      },
    });

    const paymentRecord = await AppointmentPayment.create({
      appointmentId: appointment._id,
      invoiceId: invoice._id,
      patientId: appointment.patientId,
      amount: amountDue,
      currency: "INR",
      paymentMethod: "razorpay",
      razorpayOrderId: razorpayOrder.id,
      status: "created",
      idempotencyKey,
    });

    const publicParams = await razorpayService.getPublicParams();

    return reply.code(200).send(
      successResponse({
        razorpayOrderId: razorpayOrder.id,
        keyId: publicParams.keyId,
        amount: amountDue,
        currency: "INR",
        appointmentId: appointment.id,
        paymentRecordId: paymentRecord.id,
      })
    );
  } catch (err: any) {
    console.error("createAppointmentPaymentOrder error:", err);
    return reply.code(500).send(errorResponse(err.message || "Failed to create payment order"));
  }
}

// ─── POST /api/appointment-payments/verify ────────────────────────────
export async function verifyAppointmentPayment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, appointmentId } = req.body as {
      razorpayOrderId: string;
      razorpayPaymentId: string;
      razorpaySignature: string;
      appointmentId?: string;
    };

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return reply.code(400).send(errorResponse("Missing required payment verification parameters"));
    }

    const isValid = await razorpayService.verifyPaymentSignature(
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature
    );

    if (!isValid) {
      return reply.code(400).send(errorResponse("Invalid payment signature verification failed"));
    }

    const paymentRecord = await AppointmentPayment.findOne({ razorpayOrderId });
    if (!paymentRecord) {
      return reply.code(404).send(errorResponse("Payment record not found"));
    }

    const appointment = await Appointment.findById(paymentRecord.appointmentId);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (appointmentId && appointmentId !== paymentRecord.appointmentId.toString()) {
      return reply.code(400).send(errorResponse("Appointment ID does not match payment record"));
    }

    if (!(await authorizeAppointmentAccess(req, appointment))) {
      return reply.code(403).send(errorResponse("Unauthorized access to appointment"));
    }

    const settlement = await settleAppointmentPayment(paymentRecord.id, razorpayPaymentId, req.user!.id, razorpaySignature);
    if (settlement.replayed) return reply.code(200).send(successResponse(null, "Payment already verified"));
    const clinicIdStr = appointment.clinicId?.toString();
    if (clinicIdStr) {
      broadcastQueueUpdate(clinicIdStr, {
        type: "PAYMENT_RECEIVED",
        data: {
          clinicId: clinicIdStr,
          appointmentId: appointment._id.toString(),
          tokenNumber: appointment.tokenNumber,
          amount: paymentRecord.amount || 0,
          paymentMethod: "online",
        },
        message: `Online payment of ₹${paymentRecord.amount || 0} received for Token #${appointment.tokenNumber}`,
        timestamp: new Date().toISOString(),
      });
    }

    const { sendPaymentReceiptNotification } = await import("../utilities/notifications.ts");
    sendPaymentReceiptNotification({
      appointmentId: appointment._id.toString(),
      amount: paymentRecord.amount || 0,
      paymentMethod: "online",
    }).catch((err) => console.error("verify payment receipt notification notice:", err));

    return reply.code(200).send(successResponse(null, "Appointment payment verified and confirmed successfully!"));
  } catch (err: any) {
    console.error("verifyAppointmentPayment error:", err);
    return reply.code(err instanceof AppointmentDomainError ? err.statusCode : 500).send(errorResponse(err instanceof AppointmentDomainError ? err.message : "Payment verification failed"));
  }
}

// ─── POST /api/appointment-payments/pay-at-clinic ─────────────────────
export async function selectPayAtClinic(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId } = req.body as { appointmentId: string };

    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (!(await authorizeAppointmentAccess(req, appointment))) {
      return reply.code(403).send(errorResponse("Unauthorized access to appointment"));
    }

    const assignment = await DoctorAssignment.findOne({ doctorId: appointment.doctorId, clinicId: appointment.clinicId });
    if (assignment && assignment.allowPayAtClinic === false) {
      return reply.code(400).send(errorResponse("Pay at clinic is disabled for this doctor. Online payment is required."));
    }

    if (appointment.status === "cancelled" || ["paid", "refunded", "refund_pending"].includes(appointment.paymentStatus || "")) return reply.code(409).send(errorResponse("This visit's payment cannot be changed"));
    const selected = await Appointment.findOneAndUpdate({ _id: appointment._id, status: appointment.status, paymentStatus: appointment.paymentStatus },
      { $set: { paymentStatus: "pay_at_clinic", ...(["pending_payment", "pending"].includes(appointment.status) ? { status: "confirmed" } : {}) } }, { returnDocument: "after" });
    if (!selected) return reply.code(409).send(errorResponse("The visit changed; refresh and try again"));

    await AppointmentPayment.create({
      appointmentId: appointment._id,
      patientId: appointment.patientId,
      amount: 0,
      paymentMethod: "pay_at_clinic",
      status: "pay_at_clinic",
    });

    return reply.code(200).send(successResponse(selected, "Pay at clinic option selected. Appointment confirmed!"));
  } catch (err: any) {
    console.error("selectPayAtClinic error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── POST /api/appointment-payments/collect-counter ──────────────────
export async function collectCounterPayment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId, paymentMethod = "upi" } = req.body as {
      appointmentId: string;
      paymentMethod?: "upi" | "cash" | "card";
    };

    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (!(await requestHasAnyPermission(req, ...BILLING_STAFF_PAYMENT_PERMISSIONS))) {
      return reply.code(403).send(errorResponse("Counter payment requires billing staff access"));
    }
    const clinicAccess = await checkOperationalRecordAccess(req, appointment);
    if (!clinicAccess.allowed) {
      return reply.code(403).send(errorResponse("Unauthorized clinic access"));
    }
    if (!["upi", "cash", "card"].includes(paymentMethod)) {
      return reply.code(400).send(errorResponse("Unsupported counter payment method"));
    }
    if (paymentMethod === "upi") {
      const clinic = await Clinic.findById(appointment.clinicId).select("organizationId").lean();
      const organizationId = clinic?.organizationId || appointment.organizationId;
      const organization = organizationId
        ? await Organization.findById(organizationId).select("countryCode currency").lean()
        : null;
      if (!organization || (organization.countryCode && organization.countryCode !== "IN") || (organization.currency && organization.currency !== "INR")) {
        return reply.code(409).send(errorResponse("UPI collection is only configured for INR clinics"));
      }
    }

    let invoice: any = await Invoice.findOne({ appointmentId: appointment._id });
    if (!invoice) {
      const { Encounter } = await import("../models/Encounter.ts");
      const encounter = await Encounter.findOne({ appointmentId: appointment._id, organizationId: appointment.organizationId });
      if (encounter) invoice = await Invoice.findOne({ encounterId: encounter._id, organizationId: appointment.organizationId });
    }
    if (!invoice) {
      const assignment = await DoctorAssignment.findOne({ doctorId: appointment.doctorId, clinicId: appointment.clinicId });
      const feeAmount = Number(assignment?.fees ?? appointment.paymentAmount ?? 500);
      const { generateClinicInvoiceNumber } = await import("../utilities/invoiceNumber.ts");
      const invoiceNumber = await generateClinicInvoiceNumber(appointment.clinicId.toString());
      invoice = await Invoice.create({
        invoiceNumber,
        patientId: appointment.patientId,
        appointmentId: appointment._id,
        clinicId: appointment.clinicId,
        doctorId: appointment.doctorId,
        organizationId: appointment.organizationId,
        items: [{ description: "OPD Consultation Fee", amount: feeAmount, quantity: 1 }],
        subtotal: feeAmount,
        totalAmount: feeAmount,
        amountPaid: 0,
        balanceDue: feeAmount,
        status: "unpaid",
      });
    }

    const feeAmount = Number(
      invoice.balanceDue ?? Math.max(0, Number(invoice.totalAmount || 0) - Number(invoice.amountPaid || 0))
    );
    if (!Number.isFinite(feeAmount) || feeAmount <= 0 || invoice.status === "paid") {
      return reply.code(409).send(errorResponse("This appointment invoice has already been paid"));
    }

    // The conditional update is the single settlement gate: a concurrent or
    // replayed request observes the already-paid status and cannot append an
    // additional payment record.
    const collection = await withClinicalTransaction(async () => {
      const claimedVisit = await Appointment.findOneAndUpdate({ _id: appointment._id, status: { $ne: "cancelled" }, paymentStatus: { $nin: ["paid", "refunded", "refund_pending"] } },
        { $set: { paymentStatus: "paid", paymentAmount: feeAmount, invoiceId: invoice._id } }, { returnDocument: "after" });
      if (!claimedVisit) throw new AppointmentDomainError("This visit's payment cannot be collected", 409);
      const settledInvoice = await Invoice.findOneAndUpdate(
        { _id: invoice._id, status: { $in: ["unpaid", "partially_paid"] }, amountPaid: invoice.amountPaid },
        { $set: { status: "paid", amountPaid: Number(invoice.amountPaid || 0) + feeAmount, balanceDue: 0, paymentMethod, paymentDate: new Date() },
          $push: { payments: { amount: feeAmount, paymentMethod, paidAt: new Date(), notes: "Settled via authenticated front-desk payment flow" } } },
        { returnDocument: "after" },
      );
      if (!settledInvoice) throw new AppointmentDomainError("This invoice has already been settled or changed", 409);
      await AppointmentPayment.create({ appointmentId: appointment._id, invoiceId: settledInvoice._id, patientId: appointment.patientId,
        amount: feeAmount, currency: settledInvoice.currency, paymentMethod, status: "captured", idempotencyKey: `counter_payment_${settledInvoice._id}` });
      return { invoice: settledInvoice, appointment: claimedVisit };
    });
    invoice = collection.invoice;
    invoice.$session(null);
    collection.appointment.$session(null);
    const clinicIdStr = appointment.clinicId.toString();
    broadcastQueueUpdate(clinicIdStr, {
      type: "PAYMENT_RECEIVED",
      data: {
        clinicId: clinicIdStr,
        appointmentId: appointment._id.toString(),
        invoiceId: invoice._id?.toString(),
        tokenNumber: appointment.tokenNumber,
        amount: feeAmount,
        paymentMethod,
      },
      message: `Payment of ₹${feeAmount} received via ${paymentMethod.toUpperCase()} for Token #${appointment.tokenNumber}`,
      timestamp: new Date().toISOString(),
    });

    const { sendPaymentReceiptNotification } = await import("../utilities/notifications.ts");
    sendPaymentReceiptNotification({
      appointmentId: appointment._id.toString(),
      invoiceId: invoice._id?.toString(),
      amount: feeAmount,
      paymentMethod,
    }).catch((err) => console.error("counter payment receipt notification notice:", err));

    return reply.code(200).send(
      successResponse(
        { invoice, appointment: collection.appointment },
        `Payment of ₹${feeAmount} collected successfully via ${paymentMethod.toUpperCase()}!`
      )
    );
  } catch (err: any) {
    console.error("collectCounterPayment error:", err);
    return reply.code(err instanceof AppointmentDomainError ? err.statusCode : 500).send(errorResponse(err instanceof AppointmentDomainError ? err.message : "Failed to collect counter payment"));
  }
}

// ─── POST /api/appointment-payments/reconcile ──────────────────────────
export async function reconcileAppointmentPayment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId, razorpayOrderId } = req.body as {
      appointmentId?: string;
      razorpayOrderId?: string;
    };

    if (!appointmentId && !razorpayOrderId) {
      return reply.code(400).send(errorResponse("Must provide appointmentId or razorpayOrderId"));
    }

    if (!(await requestHasAnyPermission(req, ...BILLING_STAFF_PAYMENT_PERMISSIONS))) {
      return reply.code(403).send(errorResponse("Reconciliation requires billing staff permissions"));
    }

    const query: Record<string, any> = {};
    if (appointmentId) query.appointmentId = appointmentId;
    if (razorpayOrderId) query.razorpayOrderId = razorpayOrderId;

    const paymentRecord = await AppointmentPayment.findOne(query);
    if (!paymentRecord) {
      return reply.code(404).send(errorResponse("Payment record not found"));
    }

    const appointment = await Appointment.findById(paymentRecord.appointmentId);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const clinicCheck = await checkOperationalRecordAccess(req, appointment);
    if (!clinicCheck.allowed) {
      return reply.code(403).send(errorResponse("Unauthorized clinic access"));
    }

    if (paymentRecord.status === "captured") return reply.code(200).send(successResponse({ status: "captured", paymentStatus: appointment.paymentStatus }, "Payment already reconciled"));

    // Query gateway using resilientHttpClient with explicit timeout & credentials
    const { keyId, keySecret } = await razorpayService.getCredentials();
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

    const response = await resilientHttpClient.request(
      `https://api.razorpay.com/v1/orders/${paymentRecord.razorpayOrderId}/payments`,
      {
        provider: "razorpay",
        method: "GET",
        headers: { Authorization: `Basic ${auth}` },
        timeoutMs: 10_000,
        enableCircuitBreaker: true,
      },
    );

    const paymentsList = response.data?.items || [];
    const capturedItem = paymentsList.find((p: any) => p.status === "captured");

    if (capturedItem) {
      // Reconcile and settle atomically in transaction
      const settlement = await settleAppointmentPayment(paymentRecord.id, capturedItem.id, req.user!.id, undefined, capturedItem);
      if (settlement.replayed) return reply.code(200).send(successResponse({ status: paymentRecord.status, paymentStatus: settlement.appointment.paymentStatus }, "Payment already reconciled"));
      // Post-commit side effects
      const { sendPaymentReceiptNotification } = await import("../utilities/notifications.ts");
      sendPaymentReceiptNotification({
        appointmentId: appointment._id.toString(),
        amount: paymentRecord.amount || 0,
        paymentMethod: capturedItem.method || "online",
      }).catch((err) => console.error("reconcile payment receipt notification notice:", err));

      return reply.code(200).send(
        successResponse(
          { status: "captured", paymentId: capturedItem.id },
          "Payment successfully reconciled and settled via gateway verification",
        ),
      );
    }

    return reply.code(200).send(
      successResponse(
        { status: paymentRecord.status, gatewayRecordsFound: paymentsList.length },
        "Reconciliation check complete. No captured gateway payments found for this order.",
      ),
    );
  } catch (err: any) {
    console.error("reconcileAppointmentPayment error:", err);
    return reply.code(err instanceof AppointmentDomainError ? err.statusCode : 500).send(errorResponse(err instanceof AppointmentDomainError ? err.message : "Reconciliation failed"));
  }
}
