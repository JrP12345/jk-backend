import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import crypto from "node:crypto";
import { Appointment } from "../models/Appointment.ts";
import { Invoice } from "../models/Invoice.ts";
import { AppointmentPayment } from "../models/AppointmentPayment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { broadcastQueueUpdate } from "../notifications/websocket.ts";
import { sendPaymentReceiptNotification } from "../utilities/notifications.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export interface UpiWebhookPayload {
  transactionId: string;
  appointmentId?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  amount: number;
  status: "SUCCESS" | "PAID" | "captured" | "FAILED" | string;
  paymentMethod?: "upi" | "cash" | "card" | "online";
  payerVpa?: string;
  signature?: string;
}

/**
 * Verify cryptographic HMAC-SHA256 signature for incoming UPI webhook.
 */
export function verifyUpiWebhookSignature(req: FastifyRequest, secret: string): boolean {
  const headerSig = (req.headers["x-webhook-signature"] || req.headers["x-razorpay-signature"]) as string | undefined;
  const bodySig = (req.body as any)?.signature as string | undefined;
  const signature = headerSig || bodySig;

  if (!signature) return false;

  const payload = req.body as any;
  const rawBody = (req as any).rawBody;
  const payloadString = typeof rawBody === "string" ? rawBody : Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : JSON.stringify(payload);

  // 1. Direct JSON payload HMAC
  const expectedJsonSig = crypto.createHmac("sha256", secret).update(payloadString).digest("hex");

  // 2. Canonical string format: transactionId|amount|appointmentId
  const canonicalString = `${payload?.transactionId || ""}|${payload?.amount || ""}|${payload?.appointmentId || payload?.invoiceId || ""}`;
  const expectedCanonicalSig = crypto.createHmac("sha256", secret).update(canonicalString).digest("hex");

  const candidates = [expectedJsonSig, expectedCanonicalSig];

  for (const expected of candidates) {
    try {
      if (
        signature.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"))
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

/**
 * POST /api/webhooks/upi
 * Autonomous banking & UPI gateway callback listener for real-time zero-click settlement.
 */
export async function handleInboundUpiWebhook(req: FastifyRequest, reply: FastifyReply) {
  try {
    const secret = process.env.UPI_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET;
    const isProd = process.env.NODE_ENV === "production";

    if (isProd || secret) {
      if (!secret) {
        console.error("CRITICAL: UPI_WEBHOOK_SECRET or RAZORPAY_WEBHOOK_SECRET is missing in production!");
        return reply.code(401).send(errorResponse("Webhook verification configuration missing"));
      }

      const isValid = verifyUpiWebhookSignature(req, secret);
      if (!isValid) {
        await AuditLog.create({
          action: "WEBHOOK_REJECT",
          category: "BILLING",
          details: {
            reason: "Invalid or missing HMAC signature",
            resource: "UPI_WEBHOOK",
            ip: (req.headers["x-forwarded-for"] as string) || req.ip,
            transactionId: (req.body as any)?.transactionId,
          },
        }).catch(() => {});

        return reply.code(401).send(errorResponse("Unauthorized: Invalid webhook signature"));
      }
    }

    const payload = (req.body || {}) as UpiWebhookPayload;
    const {
      transactionId,
      appointmentId,
      invoiceId,
      invoiceNumber,
      amount,
      status,
      paymentMethod = "upi",
      payerVpa,
    } = payload;

    if (!transactionId) {
      return reply.code(400).send(errorResponse("Missing required transactionId in UPI webhook payload"));
    }

    const normalizedStatus = String(status || "").toUpperCase();
    if (normalizedStatus !== "SUCCESS" && normalizedStatus !== "PAID" && normalizedStatus !== "CAPTURED") {
      return reply.code(200).send(
        successResponse(
          { transactionId, status: normalizedStatus, processed: false },
          `Inbound UPI event with non-success status '${status}' acknowledged.`
        )
      );
    }

    let appointment: any = null;
    let invoice: any = null;

    // 1. Resolve Appointment and Invoice
    if (appointmentId && mongoose.Types.ObjectId.isValid(appointmentId)) {
      appointment = await Appointment.findById(appointmentId);
    }

    if (invoiceId && mongoose.Types.ObjectId.isValid(invoiceId)) {
      invoice = await Invoice.findById(invoiceId);
    } else if (invoiceNumber) {
      invoice = await Invoice.findOne({ invoiceNumber });
    }

    if (!appointment && invoice?.appointmentId) {
      appointment = await Appointment.findById(invoice.appointmentId);
    }

    if (!invoice && appointment) {
      invoice = await Invoice.findOne({ appointmentId: appointment._id });
    }

    if (!appointment && !invoice) {
      return reply.code(404).send(
        errorResponse("Unable to correlate inbound UPI payment to an active appointment or invoice")
      );
    }

    const feeAmount = Number(amount) > 0 ? Number(amount) : (appointment?.paymentAmount || invoice?.totalAmount || 500);

    // 2. Settle or Create Invoice
    if (!invoice && appointment) {
      invoice = await Invoice.create({
        organizationId: appointment.organizationId,
        clinicId: appointment.clinicId,
        patientId: appointment.patientId,
        doctorId: appointment.doctorId,
        appointmentId: appointment._id,
        invoiceNumber: `INV-UPI-${Date.now().toString().slice(-6)}`,
        dueDate: new Date(),
        subtotal: feeAmount,
        totalAmount: feeAmount,
        amountPaid: feeAmount,
        balanceDue: 0,
        status: "paid",
        paymentMethod,
        paymentDate: new Date(),
        items: [
          {
            description: "Consultation & Diagnostics Service (Direct UPI Settlement)",
            quantity: 1,
            amount: feeAmount,
            totalItemAmount: feeAmount,
          },
        ],
        payments: [
          {
            amount: feeAmount,
            paymentMethod,
            paidAt: new Date(),
            referenceNumber: transactionId,
            notes: `Bank UPI Autoclear Txn #${transactionId} (${payerVpa || "UPI Net"})`,
          },
        ],
      });
    } else if (invoice) {
      invoice.status = "paid";
      invoice.totalAmount = Math.max(invoice.totalAmount || 0, feeAmount);
      invoice.amountPaid = invoice.totalAmount;
      invoice.balanceDue = 0;
      invoice.paymentMethod = paymentMethod;
      invoice.paymentDate = new Date();

      if (!invoice.payments) invoice.payments = [];
      invoice.payments.push({
        amount: feeAmount,
        paymentMethod,
        paidAt: new Date(),
        referenceNumber: transactionId,
        notes: `Bank UPI Autoclear Txn #${transactionId} (${payerVpa || "UPI Net"})`,
      });
      await invoice.save();
    }

    // 3. Mark Appointment as Paid
    if (appointment) {
      appointment.paymentStatus = "paid";
      appointment.paymentAmount = feeAmount;
      if (invoice?._id) appointment.invoiceId = invoice._id;
      await appointment.save();

      // Create AppointmentPayment audit record
      await AppointmentPayment.create({
        appointmentId: appointment._id,
        invoiceId: invoice?._id,
        patientId: appointment.patientId,
        amount: feeAmount,
        paymentMethod,
        status: "captured",
        idempotencyKey: `upi_webhook_${transactionId}`,
      });

      // 4. Autonomous Broadcast to Clinic Countertop WebSocket (Sounds Voice Chime)
      const clinicIdStr = appointment.clinicId.toString();
      broadcastQueueUpdate(clinicIdStr, {
        type: "PAYMENT_RECEIVED",
        data: {
          clinicId: clinicIdStr,
          appointmentId: appointment._id.toString(),
          invoiceId: invoice?._id?.toString(),
          tokenNumber: appointment.tokenNumber,
          amount: feeAmount,
          paymentMethod,
          transactionId,
          source: "bank_webhook",
        },
        message: `Direct UPI Inward Payment of ₹${feeAmount} confirmed for Token #${appointment.tokenNumber}`,
        timestamp: new Date().toISOString(),
      });

      // 5. Send Digital Receipt to Patient
      sendPaymentReceiptNotification({
        appointmentId: appointment._id.toString(),
        invoiceId: invoice?._id?.toString(),
        amount: feeAmount,
        paymentMethod,
      }).catch((err) => console.error("UPI webhook receipt notification notice:", err));
    }

    return reply.code(200).send(
      successResponse(
        {
          transactionId,
          appointmentId: appointment?._id?.toString(),
          invoiceId: invoice?._id?.toString(),
          amount: feeAmount,
          status: "settled",
        },
        `Inbound UPI transaction #${transactionId} settled successfully!`
      )
    );
  } catch (err: any) {
    console.error("handleInboundUpiWebhook error:", err);
    return reply.code(500).send(errorResponse(err.message || "Failed to process inbound UPI webhook"));
  }
}
