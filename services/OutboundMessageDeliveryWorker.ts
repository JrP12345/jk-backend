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
import { resolveWhatsAppAccount, recordWhatsAppCredentialError } from "./WhatsAppAccountService.ts";
import { assertWhatsAppConsent, assertApprovedTemplate, isPermanentWhatsAppFailure } from "./WhatsAppSendPolicy.ts";
import { claimWhatsAppIntent } from "./WhatsAppLedger.ts";

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
  private busy = false;

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
    if (this.stopped || this.busy) return { processed: 0 };
    this.busy = true;
    try {
      const results = await Promise.allSettled(Array.from({ length: batchSize }, () => this.processOne()));
      return { processed: results.filter((result) => result.status === "fulfilled" && result.value).length };
    } finally { this.busy = false; }
  }

  private async dispatchDirectWhatsApp(message: any) {
    const payload = readEncryptedOutboundPayload<WhatsAppDocumentMessage & WhatsAppFreeformMessage>(message);
    const key = `outbound:${message.idempotencyKey}`;
    const existing = await NotificationLog.findOne({ idempotencyKey: key });
    if (existing && ["accepted", "sent", "delivered", "read"].includes(existing.status)) return;
    if (existing?.status === "sending" || existing?.errorReason === "AMBIGUOUS_NETWORK") throw new PermanentDeliveryError("AMBIGUOUS_NETWORK");
    const account = await resolveWhatsAppAccount(payload.organizationId);
    const windowOpen = await assertWhatsAppConsent(account, payload.to);
    const document = message.kind === "whatsapp_document";
    const sandbox = process.env.NODE_ENV === "test";
    if (!document && !windowOpen && !sandbox) throw new PermanentDeliveryError("SESSION_WINDOW_CLOSED");
    if (document && !windowOpen && !sandbox) await assertApprovedTemplate(account, "document_ready", process.env.META_WHATSAPP_LANG || "en");
    const claim = await claimWhatsAppIntent(key, {
      organizationId: payload.organizationId, recipientPhone: payload.to, channel: "whatsapp", templateId: document ? "DOCUMENT_READY" : "TWO_WAY_ASSISTANT",
      messageContent: document ? "[Document notification]" : payload.text, status: "sending",
    });
    if (!claim.claimed) return;
    const intent = claim.log!;
    let result = document
      ? (!windowOpen && !sandbox
        ? await whatsAppCloudApiService.sendTemplateMessage({ to: payload.to, templateName: "document_ready", parameters: [payload.filename, payload.documentUrl], credentials: account })
        : (/\.pdf(?:\?|$)/i.test(payload.documentUrl) || sandbox
          ? await whatsAppCloudApiService.sendDocumentMessage({ ...payload, credentials: account })
          : await whatsAppCloudApiService.sendFreeformTextMessage({ to: payload.to, text: `${payload.caption || payload.filename}\n${payload.documentUrl}`, credentials: account })))
      : await whatsAppCloudApiService.sendFreeformTextMessage({ ...payload, credentials: account });
    if (!result.success && result.errorReason === "MEDIA_UPLOAD_FAILED") {
      result = await whatsAppCloudApiService.sendFreeformTextMessage({ to: payload.to, text: `${payload.caption || payload.filename}\n${payload.documentUrl}`, credentials: account });
    }
    await recordWhatsAppCredentialError(account, result.errorCode);
    await NotificationLog.updateOne({ _id: intent._id }, { $set: { status: result.status, providerMessageId: result.providerMessageId, metaMessageId: result.providerMessageId, errorReason: result.errorReason } });
    if (!result.success) throw isPermanentWhatsAppFailure(result.errorReason) ? new PermanentDeliveryError(result.errorReason) : new Error(result.errorReason);
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
    const heartbeat = setInterval(() => {
      void OutboundMessage.updateOne({ _id: message._id, status: "processing", lockedBy }, { $set: { lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) } }).catch(() => {});
    }, 20_000);
    heartbeat.unref?.();

    try {
      if (message.kind === "payment_receipt") {
        await sendPaymentReceiptNotification(message.payload as any);
      } else if (message.kind === "communication_template") {
        const delivery = await dispatchSmsWhatsAppNotification(readCommunicationTemplate(message));
        // A disabled channel is an intentional suppression, not a retryable
        // provider failure. Failed provider/consent outcomes carry a log reason.
        if (delivery?.status === "failed") {
          const failure = new Error(delivery.errorReason || "Communication provider rejected delivery");
          if (PERMANENT_COMMUNICATION_FAILURES.has(delivery.errorReason || "") || isPermanentWhatsAppFailure(delivery.errorReason)) {
            throw new PermanentDeliveryError(failure.message);
          }
          throw failure;
        }
      } else if (message.kind === "whatsapp_document" || message.kind === "whatsapp_freeform") {
        await this.dispatchDirectWhatsApp(message);
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
      const retry = !(error instanceof PermanentDeliveryError) && !isPermanentWhatsAppFailure(error.message) && message.attempts < message.maxAttempts;
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
    } finally { clearInterval(heartbeat); }
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
