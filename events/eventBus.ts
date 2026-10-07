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
        payload: { ...event, eventId: idempotencyKey },
      },
      session,
    );
  }

  /** Await every subscriber before the durable worker acknowledges the event. */
  public async dispatch(event: DomainEventPayload): Promise<void> {
    const handlers = [...this.rawListeners("notification_event"), ...this.rawListeners(event.eventType)];
    const results = await Promise.allSettled(handlers.map(handler => Promise.resolve().then(() => handler.call(this, event))));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    await domainEventBus.publishEvent(event.eventType, event, 1, true);
  }

  public subscribe(eventType: string, handler: (payload: DomainEventPayload) => void | Promise<void>): void {
    this.on(eventType, handler);
  }

  public subscribeAll(handler: (payload: DomainEventPayload) => void | Promise<void>): void {
    this.on("notification_event", handler);
  }
}

export const eventBus = new TypedEventBus();
