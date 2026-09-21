import crypto from "node:crypto";
import { OutboundMessage } from "../models/OutboundMessage.ts";
import { sendPaymentReceiptNotification } from "../utilities/notifications.ts";
import {
  readCommunicationTemplate,
  readEncryptedOutboundPayload,
  type TransactionalEmailMessage,
  type WhatsAppDocumentMessage,
  type WhatsAppFreeformMessage,
} from "./CommunicationOutbox.ts";
import { dispatchSmsWhatsAppNotification } from "./SmsWhatsAppService.ts";
import { whatsAppCloudApiService } from "./WhatsAppCloudApiService.ts";
import { NotificationLog } from "../models/NotificationLog.ts";
import { emailProvider } from "../notifications/providers/emailProvider.ts";

const LOCK_DURATION_MS = 60_000;
const PERMANENT_COMMUNICATION_FAILURES = new Set([
  "PATIENT_OPTED_OUT_WHATSAPP",
  "WHATSAPP_DISABLED_FOR_ORGANIZATION",
  "INSUFFICIENT_CREDITS",
  "RECIPIENT_NOT_ON_WHATSAPP",
  "SMS provider is not configured",
]);

class PermanentDeliveryError extends Error {}

/** Durable dispatcher for receipts and encrypted clinical communication templates. */
export class OutboundMessageDeliveryWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  public start(intervalMs = 500) {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.processBatch().catch((error) => console.error("[OutboundMessageWorker] Batch failed:", error));
    }, intervalMs);
    this.timer.unref?.();
  }

  public async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public async processBatch(batchSize = 10) {
    if (this.stopped) return { processed: 0 };
    const results = await Promise.allSettled(Array.from({ length: batchSize }, () => this.processOne()));
    return { processed: results.filter((result) => result.status === "fulfilled" && result.value).length };
  }

  private async processOne(): Promise<boolean> {
    const now = new Date();
    const lockedBy = crypto.randomUUID();
    const message = await OutboundMessage.findOneAndUpdate(
      {
        status: { $in: ["pending", "retrying", "processing"] },
        nextAttemptAt: { $lte: now },
        $or: [
          { lockedUntil: { $exists: false } },
          { lockedUntil: null },
          { lockedUntil: { $lte: now } },
        ],
      },
      {
        $set: { status: "processing", lockedAt: now, lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS), lockedBy },
        $inc: { attempts: 1 },
      },
      { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: "after" },
    ).select("+sensitivePayloadCiphertext");
    if (!message) return false;

    try {
      if (message.kind === "payment_receipt") {
        await sendPaymentReceiptNotification(message.payload as any);
      } else if (message.kind === "communication_template") {
        const delivery = await dispatchSmsWhatsAppNotification(readCommunicationTemplate(message));
        // A disabled channel is an intentional suppression, not a retryable
        // provider failure. Failed provider/consent outcomes carry a log reason.
        if (delivery?.status === "failed") {
          const failure = new Error(delivery.errorReason || "Communication provider rejected delivery");
          if (PERMANENT_COMMUNICATION_FAILURES.has(delivery.errorReason || "")) {
            throw new PermanentDeliveryError(failure.message);
          }
          throw failure;
        }
      } else if (message.kind === "whatsapp_document") {
        const document = readEncryptedOutboundPayload<WhatsAppDocumentMessage>(message);
        const result = await whatsAppCloudApiService.sendDocumentMessage(document);
        if (!result.success) {
          const failure = new Error(result.errorReason || "WhatsApp document delivery failed");
          if (PERMANENT_COMMUNICATION_FAILURES.has(result.errorReason || "") || result.errorCode === 131026) {
            throw new PermanentDeliveryError(failure.message);
          }
          throw failure;
        }
      } else if (message.kind === "whatsapp_freeform") {
        const reply = readEncryptedOutboundPayload<WhatsAppFreeformMessage>(message);
        const result = await whatsAppCloudApiService.sendFreeformTextMessage(reply);
        if (!result.success) {
          const failure = new Error(result.errorReason || "WhatsApp reply delivery failed");
          if (PERMANENT_COMMUNICATION_FAILURES.has(result.errorReason || "")) {
            throw new PermanentDeliveryError(failure.message);
          }
          throw failure;
        }
        await NotificationLog.create({
          organizationId: reply.organizationId || undefined,
          recipientPhone: reply.to,
          recipientName: reply.recipientName || undefined,
          channel: "whatsapp",
          templateId: "TWO_WAY_ASSISTANT",
          messageContent: reply.text,
          status: "sent",
          providerMessageId: result.providerMessageId,
          metaMessageId: result.providerMessageId,
          idempotencyKey: `outbound:${message.idempotencyKey}`,
        });
      } else if (message.kind === "transactional_email") {
        const email = readEncryptedOutboundPayload<TransactionalEmailMessage>(message);
        const sent = await emailProvider.sendEmail(email, email.orgSmtp);
        if (!sent) throw new Error("Transactional email provider rejected delivery");
      } else {
        throw new PermanentDeliveryError(`Unsupported outbound message kind: ${(message as any).kind}`);
      }

      await OutboundMessage.updateOne(
        { _id: message._id, status: "processing", lockedBy },
        { $set: { status: "sent", sentAt: new Date() }, $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1, nextAttemptAt: 1 } },
      );
    } catch (error: any) {
      const retry = !(error instanceof PermanentDeliveryError) && message.attempts < message.maxAttempts;
      await OutboundMessage.updateOne(
        { _id: message._id, status: "processing", lockedBy },
        retry
          ? {
              $set: {
                status: "retrying",
                error: error?.message || "Outbound delivery failed",
                nextAttemptAt: new Date(Date.now() + Math.pow(2, Math.max(0, message.attempts - 1)) * 1000),
              },
              $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1 },
            }
          : {
              $set: { status: "failed", error: error?.message || "Outbound delivery failed", sentAt: new Date() },
              $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1, nextAttemptAt: 1 },
            },
      );
    }
    return true;
  }
}

export const outboundMessageDeliveryWorker = new OutboundMessageDeliveryWorker();
