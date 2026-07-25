import { EventEmitter } from "events";
import type { DomainEventPayload } from "./types.ts";

class TypedEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  public publish(event: DomainEventPayload): void {
    setImmediate(() => {
      this.emit("notification_event", event);
      this.emit(event.eventType, event);
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
