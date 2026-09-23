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

import {
  OUTBOUND_MESSAGE_WORKER_BATCH_SIZE,
  OUTBOUND_MESSAGE_WORKER_POLL_MS,
  WORKER_BACKPRESSURE_QUEUE_AGE_SEC,
  WORKER_BACKPRESSURE_PENDING_LIMIT,
  WORKER_BACKPRESSURE_POLL_MULTIPLIER,
} from "../utilities/scalability.ts";

const LOCK_DURATION_MS = 60_000;
const PERMANENT_COMMUNICATION_FAILURES = new Set([
  "PATIENT_OPTED_OUT_WHATSAPP",
  "WHATSAPP_DISABLED_FOR_ORGANIZATION",
  "INSUFFICIENT_CREDITS",
  "RECIPIENT_NOT_ON_WHATSAPP",
  "SMS provider is not configured",
]);

class PermanentDeliveryError extends Error {}

export interface OutboundMessageMetrics {
  oldestMessageAgeMs: number | null;
  pendingCount: number;
  retryingCount: number;
  processingCount: number;
  failedCount: number;
  sentCount: number;
  inBackpressure: boolean;
}

/** Durable dispatcher for receipts and encrypted clinical communication templates. */
export class OutboundMessageDeliveryWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private inBackpressure = false;

  public start(intervalMs = OUTBOUND_MESSAGE_WORKER_POLL_MS) {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      const batchSize = this.inBackpressure
        ? Math.max(1, Math.floor(OUTBOUND_MESSAGE_WORKER_BATCH_SIZE / WORKER_BACKPRESSURE_POLL_MULTIPLIER))
        : OUTBOUND_MESSAGE_WORKER_BATCH_SIZE;

      this.processBatch(batchSize).catch((error) => console.error("[OutboundMessageWorker] Batch failed:", error));
    }, intervalMs);
    this.timer.unref?.();
  }

  public async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public async processBatch(batchSize = OUTBOUND_MESSAGE_WORKER_BATCH_SIZE) {
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

  /**
   * Real-time metrics for monitoring queue depth, age, and backpressure state.
   */
  public async getMetrics(): Promise<OutboundMessageMetrics> {
    const stats = await OutboundMessage.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const counts: Record<string, number> = {
      pending: 0,
      retrying: 0,
      processing: 0,
      failed: 0,
      sent: 0,
    };

    for (const item of stats) {
      if (item._id && typeof counts[item._id] === "number") {
        counts[item._id] = item.count;
      }
    }

    const oldest = await OutboundMessage.findOne(
      { status: { $in: ["pending", "retrying"] } },
      { createdAt: 1 },
    )
      .sort({ createdAt: 1 })
      .lean();

    const oldestMessageAgeMs = oldest?.createdAt
      ? Math.max(0, Date.now() - new Date(oldest.createdAt).getTime())
      : null;

    this.inBackpressure =
      counts.pending >= WORKER_BACKPRESSURE_PENDING_LIMIT ||
      (oldestMessageAgeMs !== null && oldestMessageAgeMs >= WORKER_BACKPRESSURE_QUEUE_AGE_SEC * 1000);

    return {
      oldestMessageAgeMs,
      pendingCount: counts.pending,
      retryingCount: counts.retrying,
      processingCount: counts.processing,
      failedCount: counts.failed,
      sentCount: counts.sent,
      inBackpressure: this.inBackpressure,
    };
  }
}

export const outboundMessageDeliveryWorker = new OutboundMessageDeliveryWorker();
