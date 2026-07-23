import crypto from "node:crypto";

/**
 * Standard interface for all domain events.
 * Payload MUST contain serialization-friendly primitives (strings, numbers, booleans, dates/ISO strings),
 * never live Mongoose documents or active model instances.
 */
export interface DomainEvent<TPayload = any> {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly occurredAt: Date;
  readonly payload: TPayload;
}

/**
 * Factory helper to construct a standardized DomainEvent envelope.
 */
export function createDomainEvent<TPayload>(
  eventType: string,
  payload: TPayload,
  version: number = 1
): DomainEvent<TPayload> {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    eventVersion: version,
    occurredAt: new Date(),
    payload,
  };
}
