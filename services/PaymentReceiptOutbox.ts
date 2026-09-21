import { OutboundMessage } from "../models/OutboundMessage.ts";
import type mongoose from "mongoose";

export interface PaymentReceiptMessage {
  appointmentId: string;
  invoiceId: string;
  amount: number;
  paymentMethod: string;
  transactionId: string;
}

/** Persist a receipt request; delivery happens only in the outbound worker. */
export async function enqueuePaymentReceipt(
  message: PaymentReceiptMessage,
  session: mongoose.ClientSession | null = null,
) {
  const idempotencyKey = `payment-receipt:${message.transactionId}`;
  const query = OutboundMessage.findOneAndUpdate(
    { idempotencyKey },
    {
      $setOnInsert: {
        kind: "payment_receipt",
        idempotencyKey,
        payload: message,
        status: "pending",
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  if (session) query.session(session);
  const record = await query;
  return record!;
}
