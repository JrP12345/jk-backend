import crypto from "node:crypto";
import { DomainEventOutbox } from "../models/DomainEventOutbox.ts";
import { readEncryptedDomainEvent } from "./DomainEventOutboxService.ts";
import { eventBus } from "../events/eventBus.ts";
import { domainEventBus } from "../platform/events/DomainEventBus.ts";
import type { DomainEventPayload } from "../events/types.ts";

const LOCK_DURATION_MS = Number(process.env.DOMAIN_EVENT_LOCK_MS) || 60_000;
const DEFAULT_POLL_INTERVAL_MS = Number(process.env.DOMAIN_EVENT_WORKER_POLL_MS) || 500;
const DEFAULT_BATCH_SIZE = Number(process.env.DOMAIN_EVENT_WORKER_BATCH_SIZE) || 10;
const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 300_000; // 5 minutes ceiling

export interface DomainEventMetrics {
  oldestEventAgeMs: number | null;
  pendingCount: number;
  retryingCount: number;
  processingCount: number;
  failures: number;
  deadLetterCount: number;
  sentCount: number;
  totalAttempts: number;
}

export class DomainEventDeliveryWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  public start(intervalMs = DEFAULT_POLL_INTERVAL_MS) {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.processBatch(DEFAULT_BATCH_SIZE).catch((error) =>
        console.error("[DomainEventWorker] Batch failed:", error),
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  public async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public async processBatch(batchSize = DEFAULT_BATCH_SIZE) {
    if (this.stopped) return { processed: 0 };
    const results = await Promise.allSettled(Array.from({ length: batchSize }, () => this.processOne()));
    return { processed: results.filter((result) => result.status === "fulfilled" && result.value).length };
  }

  public async processOne(): Promise<boolean> {
    const now = new Date();
    const lockedBy = crypto.randomUUID();
    const eventRow = await DomainEventOutbox.findOneAndUpdate(
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
    ).select("+payloadCiphertext");

    if (!eventRow) return false;

    // Guard: Poison event detection during deserialization
    let payload: DomainEventPayload;
    try {
      payload = readEncryptedDomainEvent<DomainEventPayload>(eventRow);
      if (!payload || !payload.eventType) {
        throw new Error("Poison event: missing deserialized payload or eventType");
      }
    } catch (deserializationError: any) {
      // Poison event: unparseable or corrupted payload ciphertext. Retries will never succeed.
      await DomainEventOutbox.updateOne(
        { _id: eventRow._id, status: "processing", lockedBy },
        {
          $set: {
            status: "dead_letter",
            error: `Poison event deserialization failure: ${deserializationError?.message || "Corrupted payload"}`,
            sentAt: new Date(),
          },
          $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1, nextAttemptAt: 1 },
        },
      );
      return true;
    }

    try {
      // Dispatch to in-process eventBus (notification listeners, audit, etc.)
      eventBus.emit("notification_event", payload);
      eventBus.emit(payload.eventType, payload);

      // Dispatch to platform domainEventBus
      try {
        await domainEventBus.publishEvent(payload.eventType, payload);
      } catch (busError) {
        console.error(`[DomainEventWorker] platform domainEventBus handler error for ${payload.eventType}:`, busError);
      }

      await DomainEventOutbox.updateOne(
        { _id: eventRow._id, status: "processing", lockedBy },
        {
          $set: { status: "sent", sentAt: new Date() },
          $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1, nextAttemptAt: 1 },
        },
      );
    } catch (error: any) {
      const retry = eventRow.attempts < eventRow.maxAttempts;
      if (retry) {
        // Bounded exponential backoff with full jitter (min: 1s, max: 300s)
        const exponentialDelay = Math.min(
          MAX_RETRY_DELAY_MS,
          BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, eventRow.attempts - 1)),
        );
        const jitter = Math.floor(Math.random() * (exponentialDelay * 0.25));
        const delayMs = Math.min(MAX_RETRY_DELAY_MS, exponentialDelay + jitter);

        await DomainEventOutbox.updateOne(
          { _id: eventRow._id, status: "processing", lockedBy },
          {
            $set: {
              status: "retrying",
              error: error?.message || "Domain event dispatch failed",
              nextAttemptAt: new Date(Date.now() + delayMs),
            },
            $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1 },
          },
        );
      } else {
        // Reached terminal max attempts: transition to dead_letter for operator inspection
        await DomainEventOutbox.updateOne(
          { _id: eventRow._id, status: "processing", lockedBy },
          {
            $set: {
              status: "dead_letter",
              error: `Max retry attempts (${eventRow.maxAttempts}) exceeded: ${error?.message || "Dispatch failed"}`,
              sentAt: new Date(),
            },
            $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1, nextAttemptAt: 1 },
          },
        );
      }
    }
    return true;
  }

  /**
   * Real-time metrics for monitoring queue depth, age, and dead letters.
   */
  public async getMetrics(): Promise<DomainEventMetrics> {
    const stats = await DomainEventOutbox.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalAttempts: { $sum: "$attempts" },
        },
      },
    ]);

    const counts: Record<string, number> = {
      pending: 0,
      retrying: 0,
      processing: 0,
      failed: 0,
      dead_letter: 0,
      sent: 0,
    };
    let totalAttempts = 0;

    for (const item of stats) {
      if (item._id && typeof counts[item._id] === "number") {
        counts[item._id] = item.count;
      }
      totalAttempts += item.totalAttempts || 0;
    }

    const oldestEvent = await DomainEventOutbox.findOne(
      { status: { $in: ["pending", "retrying"] } },
      { createdAt: 1 },
    )
      .sort({ createdAt: 1 })
      .lean();

    const oldestEventAgeMs = oldestEvent?.createdAt
      ? Math.max(0, Date.now() - new Date(oldestEvent.createdAt).getTime())
      : null;

    return {
      oldestEventAgeMs,
      pendingCount: counts.pending,
      retryingCount: counts.retrying,
      processingCount: counts.processing,
      failures: counts.failed,
      deadLetterCount: counts.dead_letter,
      sentCount: counts.sent,
      totalAttempts,
    };
  }
}

export const domainEventDeliveryWorker = new DomainEventDeliveryWorker();
