import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import crypto from "node:crypto";
import { Appointment } from "../models/Appointment.ts";
import { Invoice } from "../models/Invoice.ts";
import { AppointmentPayment } from "../models/AppointmentPayment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { broadcastQueueUpdate } from "../notifications/websocket.ts";
import { enqueuePaymentReceipt } from "../services/PaymentReceiptOutbox.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { withTransaction } from "../utilities/transaction.ts";

export interface UpiWebhookPayload {
  transactionId: string;
  appointmentId: string;
  invoiceId: string;
  /** Gateway order ID returned by the server-created payment order. */
  orderId?: string;
  razorpayOrderId?: string;
  amount: number;
  status: "SUCCESS" | "PAID" | "captured" | "FAILED" | string;
  paymentMethod?: "upi" | "online";
  payerVpa?: string;
  signature?: string;
}

function amountInMinorUnits(value: unknown): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100);
}

function isSameId(left: unknown, right: unknown): boolean {
  return String(left) === String(right);
}

/**
 * Verify cryptographic HMAC-SHA256 signature for incoming UPI webhook.
 *
 * The raw request body is the primary signed form. The canonical form is
 * retained for an integration that signs immutable settlement fields instead
 * of a JSON serialization.
 */
export function verifyUpiWebhookSignature(req: FastifyRequest, secret: string): boolean {
  const headerSig = (req.headers["x-webhook-signature"] || req.headers["x-razorpay-signature"]) as string | undefined;
  const bodySig = (req.body as any)?.signature as string | undefined;
  const signature = headerSig || bodySig;
  if (!signature) return false;

  const payload = req.body as UpiWebhookPayload;
  const rawBody = (req as any).rawBody;
  const payloadString = typeof rawBody === "string"
    ? rawBody
    : Buffer.isBuffer(rawBody)
      ? rawBody.toString("utf8")
      : JSON.stringify(payload);
  const orderId = payload?.orderId || payload?.razorpayOrderId || "";
  const canonicalPayload = [
    payload?.transactionId || "",
    orderId,
    payload?.invoiceId || "",
    payload?.appointmentId || "",
    payload?.amount ?? "",
  ].join("|");
  const candidates = [payloadString, canonicalPayload].map((value) =>
    crypto.createHmac("sha256", secret).update(value).digest("hex"),
  );

  return candidates.some((expected) => {
    try {
      return signature.length === expected.length && crypto.timingSafeEqual(
        Buffer.from(signature, "utf8"),
        Buffer.from(expected, "utf8"),
      );
    } catch {
      return false;
    }
  });
}

async function recordRejectedWebhook(req: FastifyRequest, reason: string, transactionId?: string) {
  await AuditLog.create({
    action: "WEBHOOK_REJECT",
    category: "BILLING",
    details: {
      reason,
      resource: "UPI_WEBHOOK",
      ip: (req.headers["x-forwarded-for"] as string) || req.ip,
      transactionId: transactionId || undefined,
    },
  }).catch(() => {});
}

function settledResponse(transactionId: string, appointment: any, invoice: any, amount: number, replayed = false) {
  return successResponse(
    {
      transactionId,
      appointmentId: appointment._id.toString(),
      invoiceId: invoice._id.toString(),
      amount,
      status: "settled",
      replayed,
    },
    replayed ? "Inbound UPI transaction was already settled." : "Inbound UPI transaction settled successfully.",
  );
}

class PaymentSettlementConflict extends Error {
  statusCode = 409;
}

type SettlementResult = {
  replayed: boolean;
  appointment: any;
  invoice: any;
  amount: number;
  settlementMethod: "upi" | "online";
  broadcastAt?: Date;
};

/**
 * POST /api/webhooks/upi
 *
 * A provider callback is never an authority to choose an appointment, order,
 * or amount. It can settle only the exact server-created payment order that is
 * still awaiting capture. The conditional payment update is the idempotency
 * gate; the unique provider transaction ID blocks cross-order replay. Invoice,
 * appointment, and receipt-outbox writes are committed together through the
 * transaction helper in production.
 */
export async function handleInboundUpiWebhook(req: FastifyRequest, reply: FastifyReply) {
  try {
    const secret = process.env.UPI_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      console.error("CRITICAL: UPI webhook is disabled because its HMAC secret is not configured.");
      return reply.code(503).send(errorResponse("Webhook verification configuration missing"));
    }
    if (!verifyUpiWebhookSignature(req, secret)) {
      await recordRejectedWebhook(req, "Invalid or missing HMAC signature", (req.body as any)?.transactionId);
      return reply.code(401).send(errorResponse("Unauthorized: Invalid webhook signature"));
    }

    const payload = (req.body || {}) as UpiWebhookPayload;
    const transactionId = String(payload.transactionId || "").trim();
    const orderId = String(payload.orderId || payload.razorpayOrderId || "").trim();
    const normalizedStatus = String(payload.status || "").toUpperCase();
    const receivedAmount = amountInMinorUnits(payload.amount);

    if (
      !transactionId || transactionId.length > 255 || !orderId || orderId.length > 255 ||
      !payload.invoiceId || !payload.appointmentId || !receivedAmount ||
      !mongoose.Types.ObjectId.isValid(payload.invoiceId) || !mongoose.Types.ObjectId.isValid(payload.appointmentId)
    ) {
      return reply.code(400).send(errorResponse("transactionId, orderId, invoiceId, appointmentId, and a positive amount are required"));
    }
    if (payload.paymentMethod && !["upi", "online"].includes(payload.paymentMethod)) {
      return reply.code(400).send(errorResponse("Unsupported inbound payment method"));
    }
    if (!["SUCCESS", "PAID", "CAPTURED"].includes(normalizedStatus)) {
      return reply.code(200).send(successResponse(
        { transactionId, status: normalizedStatus, processed: false },
        "Non-settlement UPI event acknowledged.",
      ));
    }

    const [invoice, appointment, paymentRecord, transactionRecord] = await Promise.all([
      Invoice.findOne({ _id: payload.invoiceId, appointmentId: payload.appointmentId }),
      Appointment.findById(payload.appointmentId),
      AppointmentPayment.findOne({ razorpayOrderId: orderId }),
      AppointmentPayment.findOne({ razorpayPaymentId: transactionId }),
    ]);

    if (!invoice || !appointment || !paymentRecord) {
      await recordRejectedWebhook(req, "No matching server-created invoice, appointment, and payment order", transactionId);
      return reply.code(404).send(errorResponse("No matching server-created payment order"));
    }
    if (
      !isSameId(paymentRecord.appointmentId, appointment._id) ||
      !isSameId(paymentRecord.invoiceId, invoice._id) ||
      !isSameId(invoice.appointmentId, appointment._id)
    ) {
      await recordRejectedWebhook(req, "Order, invoice, and appointment correlation mismatch", transactionId);
      return reply.code(409).send(errorResponse("Payment order correlation mismatch"));
    }

    const expectedAmount = amountInMinorUnits(paymentRecord.amount);
    if (!expectedAmount || receivedAmount !== expectedAmount) {
      await recordRejectedWebhook(req, "Webhook amount does not equal the server-side payment order", transactionId);
      return reply.code(409).send(errorResponse("Webhook amount does not match the payment order"));
    }

    if (transactionRecord && !isSameId(transactionRecord._id, paymentRecord._id)) {
      await recordRejectedWebhook(req, "Gateway transaction ID was already used by another order", transactionId);
      return reply.code(409).send(errorResponse("Gateway transaction has already been used"));
    }
    const settlementMethod = payload.paymentMethod === "upi" ? "upi" : "online";
    const settlement = await withTransaction<SettlementResult>(async (session) => {
      const paymentOptions = session ? { session } : {};
      const currentPayment = await AppointmentPayment.findById(paymentRecord._id).session(session);
      if (!currentPayment) throw new PaymentSettlementConflict("Payment order is no longer available");
      if (currentPayment.status === "captured") {
        if (currentPayment.razorpayPaymentId === transactionId) {
          await enqueuePaymentReceipt({
            appointmentId: appointment._id.toString(),
            invoiceId: invoice._id.toString(),
            amount: currentPayment.amount,
            paymentMethod: settlementMethod,
            transactionId,
          }, session);
          return {
            replayed: true,
            appointment,
            invoice,
            amount: currentPayment.amount,
            settlementMethod,
          };
        }
        throw new PaymentSettlementConflict("Payment order has already been captured");
      }
      if (currentPayment.status !== "created") {
        throw new PaymentSettlementConflict("Payment order is not eligible for capture");
      }

      const currentInvoice = await Invoice.findById(invoice._id).session(session);
      if (!currentInvoice || !isSameId(currentInvoice.appointmentId, appointment._id)) {
        throw new PaymentSettlementConflict("Invoice is no longer linked to this appointment");
      }
      const outstandingAmount = amountInMinorUnits(
        currentInvoice.balanceDue ?? Math.max(0, Number(currentInvoice.totalAmount || 0) - Number(currentInvoice.amountPaid || 0)),
      );
      if (!outstandingAmount || receivedAmount !== outstandingAmount) {
        await recordRejectedWebhook(req, "Webhook amount does not equal the outstanding invoice balance", transactionId);
        throw new PaymentSettlementConflict("Webhook amount does not match the outstanding invoice balance");
      }

      // Reserve this order before mutating invoice state. Concurrent callbacks
      // can yield one winner only; all others return a replay result or conflict.
      const capturedPayment = await AppointmentPayment.findOneAndUpdate(
        {
          _id: currentPayment._id,
          status: "created",
          $or: [{ razorpayPaymentId: { $exists: false } }, { razorpayPaymentId: null }, { razorpayPaymentId: "" }],
        },
        {
          $set: {
            status: "captured",
            razorpayPaymentId: transactionId,
          },
        },
        { returnDocument: "after", ...paymentOptions },
      );
      if (!capturedPayment) {
        const latestPayment = await AppointmentPayment.findById(currentPayment._id).session(session);
        if (latestPayment?.status === "captured" && latestPayment.razorpayPaymentId === transactionId) {
          await enqueuePaymentReceipt({
            appointmentId: appointment._id.toString(),
            invoiceId: invoice._id.toString(),
            amount: latestPayment.amount,
            paymentMethod: settlementMethod,
            transactionId,
          }, session);
          return {
            replayed: true,
            appointment,
            invoice,
            amount: latestPayment.amount,
            settlementMethod,
          };
        }
        throw new PaymentSettlementConflict("Payment callback is a replay or order is no longer eligible");
      }

      const now = new Date();
      const settledInvoice = await Invoice.findOneAndUpdate(
        {
          _id: currentInvoice._id,
          appointmentId: appointment._id,
          status: { $in: ["unpaid", "partially_paid"] },
          balanceDue: Number(currentInvoice.balanceDue ?? currentInvoice.totalAmount - (currentInvoice.amountPaid || 0)),
        },
        {
          $set: {
            status: "paid",
            amountPaid: Number(currentInvoice.amountPaid || 0) + capturedPayment.amount,
            balanceDue: 0,
            paymentMethod: settlementMethod,
            paymentDate: now,
          },
          $push: {
            payments: {
              amount: capturedPayment.amount,
              paymentMethod: settlementMethod,
              paidAt: now,
              referenceNumber: transactionId,
              notes: "Verified gateway callback",
            },
          },
        },
        { returnDocument: "after", ...paymentOptions },
      );
      if (!settledInvoice) {
        throw new PaymentSettlementConflict("Invoice was already settled or its balance changed");
      }

      await Appointment.updateOne(
        { _id: appointment._id },
        {
          $set: {
            paymentStatus: "paid",
            paymentAmount: capturedPayment.amount,
            invoiceId: settledInvoice._id,
          },
        },
        paymentOptions,
      );

      await enqueuePaymentReceipt({
        appointmentId: appointment._id.toString(),
        invoiceId: settledInvoice._id.toString(),
        amount: capturedPayment.amount,
        paymentMethod: settlementMethod,
        transactionId,
      }, session);

      return {
        replayed: false,
        appointment,
        invoice: settledInvoice,
        amount: capturedPayment.amount,
        settlementMethod,
        broadcastAt: now,
      };
    });

    const clinicIdStr = appointment.clinicId.toString();
    if (!settlement.replayed) {
      const broadcastAt = settlement.broadcastAt || new Date();
      broadcastQueueUpdate(clinicIdStr, {
        type: "PAYMENT_RECEIVED",
        data: {
          clinicId: clinicIdStr,
          appointmentId: appointment._id.toString(),
          invoiceId: settlement.invoice._id.toString(),
          tokenNumber: appointment.tokenNumber,
          amount: settlement.amount,
          paymentMethod: settlement.settlementMethod,
          transactionId,
          source: "verified_gateway_webhook",
        },
        message: `Verified payment received for Token #${appointment.tokenNumber}`,
        timestamp: broadcastAt.toISOString(),
      });
    }

    return reply.code(200).send(settledResponse(
      transactionId,
      settlement.appointment,
      settlement.invoice,
      settlement.amount,
      settlement.replayed,
    ));
  } catch (err: any) {
    if (err instanceof PaymentSettlementConflict) {
      return reply.code(err.statusCode).send(errorResponse(err.message));
    }
    if (err?.code === 11000) {
      return reply.code(409).send(errorResponse("Gateway transaction has already been used"));
    }
    console.error("handleInboundUpiWebhook error:", err);
    return reply.code(500).send(errorResponse("Failed to process inbound UPI webhook"));
  }
}
