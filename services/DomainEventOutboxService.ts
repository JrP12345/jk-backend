import crypto from "node:crypto";
import mongoose from "mongoose";
import { decrypt, encrypt } from "../utilities/encryption.ts";
import { DomainEventOutbox, type IDomainEventOutbox } from "../models/DomainEventOutbox.ts";

export interface EnqueueDomainEventOptions {
  idempotencyKey?: string;
  eventType: string;
  eventVersion?: number;
  organizationId?: string | mongoose.Types.ObjectId;
  payload: Record<string, any>;
}

export function getDomainEventIdempotencyKey(options: EnqueueDomainEventOptions): string {
  if (options.idempotencyKey) return options.idempotencyKey;
  if (options.payload?.eventId) return options.payload.eventId;
  return `domain:${options.eventType}:${crypto.randomUUID()}`;
}

/**
 * Persist a domain event to the durable outbox before notification/platform subscribers dispatch.
 * Can participate in an active MongoDB transaction session.
 */
export async function enqueueDomainEvent(
  options: EnqueueDomainEventOptions,
  session?: mongoose.ClientSession | null,
): Promise<IDomainEventOutbox> {
  const idempotencyKey = getDomainEventIdempotencyKey(options);
  const orgId = options.organizationId
    ? typeof options.organizationId === "string"
      ? mongoose.Types.ObjectId.isValid(options.organizationId)
        ? new mongoose.Types.ObjectId(options.organizationId)
        : undefined
      : options.organizationId
    : undefined;

  try {
    const doc = await DomainEventOutbox.findOneAndUpdate(
      { idempotencyKey },
      {
        $setOnInsert: {
          idempotencyKey,
          eventType: options.eventType,
          eventVersion: options.eventVersion || 1,
          organizationId: orgId,
          payloadCiphertext: encrypt(JSON.stringify(options.payload)),
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: new Date(),
        },
      },
      {
        upsert: true,
        returnDocument: "after",
        setDefaultsOnInsert: true,
        session: session || undefined,
      },
    );
    return doc;
  } catch (error: any) {
    if (error?.code === 11000) {
      const existing = await DomainEventOutbox.findOne({ idempotencyKey }).session(session || null);
      if (existing) return existing;
    }
    throw error;
  }
}

/**
 * Decrypt the ciphertext payload for worker-only consumption.
 */
export function readEncryptedDomainEvent<T = any>(row: { payloadCiphertext?: string }): T {
  if (!row.payloadCiphertext) {
    throw new Error("Domain event payload is missing or was not selected");
  }
  return JSON.parse(decrypt(row.payloadCiphertext)) as T;
}
