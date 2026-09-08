import { EventEmitter } from "events";
import type { DomainEventPayload } from "./types.ts";
import { domainEventBus } from "../platform/events/DomainEventBus.ts";

class TypedEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

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
