import crypto from "node:crypto";
import { DomainEventOutbox } from "../models/DomainEventOutbox.ts";
import { readEncryptedDomainEvent } from "./DomainEventOutboxService.ts";
import { eventBus } from "../events/eventBus.ts";
import { domainEventBus } from "../platform/events/DomainEventBus.ts";
import type { DomainEventPayload } from "../events/types.ts";

const LOCK_DURATION_MS = 60_000;

export class DomainEventDeliveryWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  public start(intervalMs = 500) {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.processBatch().catch((error) => console.error("[DomainEventWorker] Batch failed:", error));
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

    try {
      const payload = readEncryptedDomainEvent<DomainEventPayload>(eventRow);

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
      await DomainEventOutbox.updateOne(
        { _id: eventRow._id, status: "processing", lockedBy },
        retry
          ? {
              $set: {
                status: "retrying",
                error: error?.message || "Domain event dispatch failed",
                nextAttemptAt: new Date(Date.now() + Math.pow(2, Math.max(0, eventRow.attempts - 1)) * 1000),
              },
              $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1 },
            }
          : {
              $set: {
                status: "failed",
                error: error?.message || "Domain event dispatch failed",
                sentAt: new Date(),
              },
              $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1, nextAttemptAt: 1 },
            },
      );
    }
    return true;
  }
}

export const domainEventDeliveryWorker = new DomainEventDeliveryWorker();
