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
  private stopped = false;
  private workerTimer: ReturnType<typeof setInterval>;
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private queueStats = {
    processedCount: 0,
    failureCount: 0,
  };
  private readonly batchSize = 15;

  constructor() {
    // Process jobs every 500ms
    this.workerTimer = setInterval(() => {
      if (this.stopped) return;
      this.processQueue().catch((err) => {
        console.error("[NotificationQueue Error] Queue processing failure:", err);
      });
    }, 500);
    this.workerTimer.unref?.();
  }

  /**
   * Enqueue job for background processing with retries
   */
  public async enqueue(job: Omit<DeliveryJob, "id" | "attempts" | "maxAttempts" | "createdAt">): Promise<string> {
    if (this.stopped) {
      throw new Error("Notification queue is shutting down");
    }
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const fullJob: DeliveryJob = {
      ...job,
      id: jobId,
      attempts: 0,
      maxAttempts: 5,
      createdAt: new Date(),
    };

    if (redisClient && redisClient.status === "ready") {
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
   * Worker loop to process background queue jobs in concurrent batches
   */
  private async processQueue() {
    if (this.stopped || this.isProcessing) return;
    this.isProcessing = true;

    try {
      const batch: DeliveryJob[] = [];

      if (redisClient && redisClient.status === "ready") {
        try {
          const pipeline = redisClient.pipeline();
          for (let i = 0; i < this.batchSize; i++) {
            pipeline.rpop("notification_delivery_queue");
          }
          const results = await pipeline.exec();
          if (results) {
            for (const [err, rawJob] of results) {
              if (!err && rawJob && typeof rawJob === "string") {
                try {
                  batch.push(JSON.parse(rawJob));
                } catch (parseErr) {
                  console.warn("[NotificationQueue Warning] Failed to parse job payload:", parseErr);
                }
              }
            }
          }
        } catch (err) {
          console.warn("[NotificationQueue Warning] Redis queue batch pop failed:", err);
        }
      }

      const remainingCapacity = this.batchSize - batch.length;
      if (remainingCapacity > 0 && this.inMemoryQueue.length > 0) {
        const inMemJobs = this.inMemoryQueue.splice(0, remainingCapacity);
        batch.push(...inMemJobs);
      }

      if (batch.length > 0) {
        await Promise.allSettled(batch.map((job) => this.executeJob(job)));
      }
    } catch (err) {
      console.error("[NotificationQueue Error] Error during batch processing:", err);
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
        
        const retryTimer = setTimeout(() => {
          this.retryTimers.delete(retryTimer);
          if (!this.stopped) this.inMemoryQueue.push(job);
        }, delayMs);
        this.retryTimers.add(retryTimer);
        retryTimer.unref?.();
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

  /** Stop local processing before application/database shutdown. */
  public async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.workerTimer);
    for (const retryTimer of this.retryTimers) clearTimeout(retryTimer);
    this.retryTimers.clear();
    this.inMemoryQueue.length = 0;
  }
}

export const notificationQueue = new NotificationQueueManager();
