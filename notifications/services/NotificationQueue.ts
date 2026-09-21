import crypto from "node:crypto";
import { NotificationDelivery } from "../../models/NotificationDelivery.ts";

export interface DeliveryJob {
  id: string;
  notificationId: string;
  channel: "email";
  recipient: string;
  title: string;
  message: string;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
}

/**
 * Durable delivery outbox repository.
 *
 * It intentionally does not run a timer or send mail. API processes only add
 * idempotent jobs; NotificationDeliveryWorker is the sole dispatcher.
 */
class NotificationQueueManager {
  public async enqueue(job: Omit<DeliveryJob, "id" | "attempts" | "maxAttempts" | "createdAt">): Promise<string> {
    const recipientDigest = crypto.createHash("sha256").update(job.recipient.trim().toLowerCase()).digest("hex");
    const idempotencyKey = `notification:${job.notificationId}:${job.channel}:${recipientDigest}`;

    try {
      const delivery = await NotificationDelivery.findOneAndUpdate(
        { idempotencyKey },
        {
          $setOnInsert: {
            notificationId: job.notificationId,
            channel: job.channel,
            recipient: job.recipient,
            title: job.title,
            message: job.message,
            idempotencyKey,
            status: "pending",
            attempts: 0,
            maxAttempts: 5,
            nextAttemptAt: new Date(),
          },
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
      return delivery!._id.toString();
    } catch (error: any) {
      // Two API pods can race the upsert before the unique index responds. In
      // that case, return the one durable job instead of creating a duplicate.
      if (error?.code === 11000) {
        const existing = await NotificationDelivery.findOne({ idempotencyKey }).select("_id");
        if (existing) return existing._id.toString();
      }
      throw error;
    }
  }

  public async getQueueDepth(): Promise<number> {
    return NotificationDelivery.countDocuments({
      channel: "email",
      status: { $in: ["pending", "retrying", "processing"] },
    });
  }

  public async getStats() {
    const rows = await NotificationDelivery.aggregate<{
      _id: string;
      count: number;
    }>([
      { $match: { channel: "email" } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const byStatus = Object.fromEntries(rows.map((row) => [row._id, row.count]));
    return {
      processedCount: byStatus.sent || 0,
      failureCount: byStatus.failed || 0,
      pendingCount: (byStatus.pending || 0) + (byStatus.retrying || 0) + (byStatus.processing || 0),
    };
  }
}

export const notificationQueue = new NotificationQueueManager();
