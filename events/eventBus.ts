import { EventEmitter } from "events";
import crypto from "node:crypto";
import type mongoose from "mongoose";
import type { DomainEventPayload } from "./types.ts";
import { enqueueDomainEvent } from "../services/DomainEventOutboxService.ts";
import { domainEventBus } from "../platform/events/DomainEventBus.ts";

class TypedEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /**
   * Persist event to the durable outbox before any subscriber runs.
   * Can accept a database transaction session to guarantee atomic persistence with business entities.
   */
  public async publishDurable(
    event: DomainEventPayload,
    session?: mongoose.ClientSession | null,
  ): Promise<void> {
    const idempotencyKey = event.eventId || `domain:${event.eventType}:${crypto.randomUUID()}`;
    await enqueueDomainEvent(
      {
        idempotencyKey,
        eventType: event.eventType,
        eventVersion: 1,
        organizationId: event.organizationId || event.tenantId,
        payload: event,
      },
      session,
    );
  }

  /**
   * @deprecated Use publishDurable for crash-safe delivery. Retained for synchronous test execution and fallbacks.
   */
  public publish(event: DomainEventPayload): void {
    setImmediate(() => {
      this.emit("notification_event", event);
      this.emit(event.eventType, event);

      // Unified bridge: Propagate to platform DomainEventBus
      try {
        domainEventBus.publishEvent(event.eventType, event).catch(() => {});
      } catch {
        // Safe fallback
      }
    });
  }

  public subscribe(eventType: string, handler: (payload: DomainEventPayload) => void): void {
    this.on(eventType, handler);
  }

  public subscribeAll(handler: (payload: DomainEventPayload) => void): void {
    this.on("notification_event", handler);
  }
}

export const eventBus = new TypedEventBus();
