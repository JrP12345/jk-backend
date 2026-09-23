import mongoose, { Schema } from "mongoose";
import { MAX_EVENT_RETRY_COUNT } from "../utilities/scalability.ts";

export interface IDomainEventOutbox extends mongoose.Document {
  idempotencyKey: string;
  eventType: string;
  eventVersion: number;
  organizationId?: mongoose.Types.ObjectId;
  // Encrypted serialized DomainEventPayload — only the worker decrypts
  payloadCiphertext: string;
  status: "pending" | "processing" | "retrying" | "sent" | "failed" | "dead_letter";
  attempts: number;
  maxAttempts: number;
  nextAttemptAt?: Date;
  lockedAt?: Date;
  lockedUntil?: Date;
  lockedBy?: string;
  error?: string;
  sentAt?: Date;
  replayCount: number;
  lastReplayedAt?: Date;
  lastReplayedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const DomainEventOutboxSchema = new Schema<IDomainEventOutbox>(
  {
    idempotencyKey: { type: String, required: true, unique: true },
    eventType: { type: String, required: true, index: true },
    eventVersion: { type: Number, default: 1 },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
    payloadCiphertext: { type: String, required: true, select: false },
    status: {
      type: String,
      enum: ["pending", "processing", "retrying", "sent", "failed", "dead_letter"],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: MAX_EVENT_RETRY_COUNT },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lockedAt: { type: Date },
    lockedUntil: { type: Date, index: true },
    lockedBy: { type: String, index: true },
    error: { type: String },
    sentAt: { type: Date },
    replayCount: { type: Number, default: 0 },
    lastReplayedAt: { type: Date },
    lastReplayedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

DomainEventOutboxSchema.index({ status: 1, nextAttemptAt: 1, lockedUntil: 1 });

export const DomainEventOutbox =
  mongoose.models.DomainEventOutbox ||
  mongoose.model<IDomainEventOutbox>("DomainEventOutbox", DomainEventOutboxSchema);
