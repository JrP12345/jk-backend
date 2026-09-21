import crypto from "node:crypto";
import { NotificationDelivery } from "../../models/NotificationDelivery.ts";
import { emailProvider } from "../providers/emailProvider.ts";

const LOCK_DURATION_MS = 60_000;

/**
 * Standalone durable-outbox worker. Claims use a lease so multiple worker pods
 * cannot send the same delivery simultaneously; an expired lease is retried.
 */
export class NotificationDeliveryWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  public start(intervalMs = 500) {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.processBatch().catch((error) => {
        console.error("[NotificationDeliveryWorker] Batch failed:", error);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  public async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public async processBatch(batchSize = 15) {
    if (this.stopped) return { processed: 0 };
    const results = await Promise.allSettled(
      Array.from({ length: batchSize }, () => this.processOne()),
    );
    return { processed: results.filter((result) => result.status === "fulfilled" && result.value).length };
  }

  private async processOne(): Promise<boolean> {
    const now = new Date();
    const lockedBy = crypto.randomUUID();
    const job = await NotificationDelivery.findOneAndUpdate(
      {
        channel: "email",
        status: { $in: ["pending", "retrying", "processing"] },
        nextAttemptAt: { $lte: now },
        $or: [
          { lockedUntil: { $exists: false } },
          { lockedUntil: null },
          { lockedUntil: { $lte: now } },
        ],
      },
      {
        $set: {
          status: "processing",
          lockedAt: now,
          lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS),
          lockedBy,
        },
        $inc: { attempts: 1 },
      },
      { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: "after" },
    );
    if (!job) return false;

    try {
      const sent = await emailProvider.sendEmail({
        to: job.recipient,
        subject: job.title || "Notification Alert",
        html: `<p>${job.message || ""}</p>`,
        text: job.message || "",
      });
      if (!sent) throw new Error("Email provider declined delivery");

      await NotificationDelivery.updateOne(
        { _id: job._id, status: "processing", lockedBy },
        {
          $set: { status: "sent", sentAt: new Date() },
          $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1, nextAttemptAt: 1 },
        },
      );
    } catch (error: any) {
      const retry = (job.attempts || 1) < (job.maxAttempts || 5);
      const retryDelayMs = Math.pow(2, Math.max(0, (job.attempts || 1) - 1)) * 1000;
      await NotificationDelivery.updateOne(
        { _id: job._id, status: "processing", lockedBy },
        retry
          ? {
              $set: {
                status: "retrying",
                error: error?.message || "Delivery failed",
                nextAttemptAt: new Date(Date.now() + retryDelayMs),
              },
              $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1 },
            }
          : {
              $set: {
                status: "failed",
                error: error?.message || "Exhausted maximum retry attempts",
                sentAt: new Date(),
              },
              $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1, nextAttemptAt: 1 },
            },
      );
    }
    return true;
  }
}

export const notificationDeliveryWorker = new NotificationDeliveryWorker();
