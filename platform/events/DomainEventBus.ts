import { createDomainEvent, type DomainEvent } from "./DomainEvent.ts";

export type EventSubscriber<T = any> = (event: DomainEvent<T>) => Promise<void> | void;

/**
 * DomainEventBus — in-memory pub-sub event bus.
 *
 * Design Invariants:
 * - Decoupled: Publishers call publish() without knowing who is listening.
 * - Isolated: Subscriber failures are caught & logged, never preventing other subscribers or the publisher from proceeding.
 * - Platform boundary: 100% domain-agnostic (zero imports from models/ or clinical services).
 */
export class DomainEventBus {
  private subscribers: Map<string, Set<EventSubscriber>> = new Map();

  /**
   * Subscribe a handler to a specific event type.
   * Returns an unsubscribe function.
   */
  public subscribe<T = any>(eventType: string, subscriber: EventSubscriber<T>): () => void {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, new Set());
    }

    const set = this.subscribers.get(eventType)!;
    set.add(subscriber as EventSubscriber);

    return () => {
      set.delete(subscriber as EventSubscriber);
      if (set.size === 0) {
        this.subscribers.delete(eventType);
      }
    };
  }

  /**
   * Publish a domain event to all registered subscribers.
   * Subscribers run in isolated try-catch blocks so errors in one handler
   * do not interrupt execution of other handlers or throw back to the publisher.
   */
  public async publish<T = any>(event: DomainEvent<T>): Promise<void> {
    const handlers = this.subscribers.get(event.eventType);
    if (!handlers || handlers.size === 0) return;

    for (const handler of Array.from(handlers)) {
      try {
        await handler(event);
      } catch (err) {
        console.error(`[DomainEventBus] Error executing subscriber for '${event.eventType}' (eventId: ${event.eventId}):`, err);
      }
    }
  }

  /**
   * Convenient helper: constructs a DomainEvent envelope and publishes it.
   */
  public async publishEvent<T = any>(eventType: string, payload: T, version: number = 1): Promise<void> {
    const event = createDomainEvent(eventType, payload, version);
    await this.publish(event);
  }

  /**
   * Get total subscriber count for an event type (useful for testing).
   */
  public getSubscriberCount(eventType: string): number {
    return this.subscribers.get(eventType)?.size || 0;
  }

  /**
   * Resets all subscribers (for test isolation).
   */
  public clear(): void {
    this.subscribers.clear();
  }
}

/**
 * Global singleton instance for application-wide domain event publishing & subscribing.
 */
export const domainEventBus = new DomainEventBus();
