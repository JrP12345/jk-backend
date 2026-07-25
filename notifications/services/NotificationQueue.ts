import { redisClient } from "../../utilities/redis.ts";
import { emailProvider } from "../providers/emailProvider.ts";
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

class NotificationQueueManager {
  private inMemoryQueue: DeliveryJob[] = [];
  private isProcessing = false;
  private queueStats = {
    processedCount: 0,
    failureCount: 0,
  };

  constructor() {
    // Process jobs every 500ms
    setInterval(() => {
      this.processQueue().catch((err) => {
        console.error("[NotificationQueue Error] Queue processing failure:", err);
      });
    }, 500);
  }

  /**
   * Enqueue job for background processing with retries
   */
  public async enqueue(job: Omit<DeliveryJob, "id" | "attempts" | "maxAttempts" | "createdAt">): Promise<string> {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const fullJob: DeliveryJob = {
      ...job,
      id: jobId,
      attempts: 0,
      maxAttempts: 5,
      createdAt: new Date(),
    };

    if (redisClient) {
      try {
        await redisClient.lpush("notification_delivery_queue", JSON.stringify(fullJob));
        return jobId;
      } catch (err) {
        console.warn("[NotificationQueue Warning] Failed pushing to Redis queue, falling back to in-memory queue:", err);
      }
    }

    this.inMemoryQueue.push(fullJob);
    return jobId;
  }

  /**
   * Worker loop to process background queue jobs
   */
  private async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      let job: DeliveryJob | null = null;

      if (redisClient) {
        try {
          const rawJob = await redisClient.rpop("notification_delivery_queue");
          if (rawJob) {
            job = JSON.parse(rawJob);
          }
        } catch (err) {
          console.warn("[NotificationQueue Warning] Redis queue pop failed:", err);
        }
      }

      if (!job && this.inMemoryQueue.length > 0) {
        job = this.inMemoryQueue.shift() || null;
      }

      if (job) {
        await this.executeJob(job);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Execute dispatch for a delivery channel with exponential backoff retries
   */
  private async executeJob(job: DeliveryJob) {
    job.attempts += 1;
    let success = false;
    let errorMsg: string | undefined;

    try {
      if (job.channel === "email") {
        success = await emailProvider.sendEmail({
          to: job.recipient,
          subject: job.title,
          html: `<p>${job.message}</p>`,
          text: job.message,
        });
      }
    } catch (err: any) {
      errorMsg = err.message || "Execution exception";
      success = false;
    }

    if (success) {
      this.queueStats.processedCount += 1;
      try {
        await NotificationDelivery.create({
          notificationId: job.notificationId,
          channel: job.channel,
          recipient: job.recipient,
          status: "sent",
          sentAt: new Date(),
        });
      } catch {
        // Safe fallback during DB disconnection/shutdown
      }
    } else {
      if (job.attempts < job.maxAttempts) {
        // Exponential backoff delay (1s, 2s, 4s, 8s, 16s)
        const delayMs = Math.pow(2, job.attempts - 1) * 1000;
        console.warn(`[NotificationQueue Retry] Job ${job.id} failed (Attempt ${job.attempts}/${job.maxAttempts}). Retrying in ${delayMs}ms...`);
        
        setTimeout(() => {
          this.inMemoryQueue.push(job);
        }, delayMs);
      } else {
        this.queueStats.failureCount += 1;
        console.error(`[NotificationQueue DeadLetter] Job ${job.id} exhausted max retries (${job.maxAttempts}). Marked as failed.`);
        
        await NotificationDelivery.create({
          notificationId: job.notificationId,
          channel: job.channel,
          recipient: job.recipient,
          status: "failed",
          error: errorMsg || "Exhausted maximum retry attempts",
          sentAt: new Date(),
        });
      }
    }
  }

  /**
   * Queue depth & metrics getter
   */
  public async getQueueDepth(): Promise<number> {
    if (redisClient) {
      try {
        const len = await redisClient.llen("notification_delivery_queue");
        return len + this.inMemoryQueue.length;
      } catch (err) {
        // Fallback
      }
    }
    return this.inMemoryQueue.length;
  }

  public getStats() {
    return {
      ...this.queueStats,
      inMemoryPending: this.inMemoryQueue.length,
    };
  }
}

export const notificationQueue = new NotificationQueueManager();
