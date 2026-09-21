import mongoose, { Schema } from "mongoose";

export interface IOutboundMessage extends mongoose.Document {
  kind: "payment_receipt" | "communication_template" | "whatsapp_document" | "whatsapp_freeform" | "transactional_email";
  idempotencyKey: string;
  payload: Record<string, unknown>;
  // Delivery data includes phone numbers, names, tracker capabilities and
  // sometimes clinical context. Keep it encrypted and unselected by default.
  sensitivePayloadCiphertext?: string;
  status: "pending" | "processing" | "retrying" | "sent" | "failed";
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
}

const OutboundMessageSchema = new Schema<IOutboundMessage>(
  {
    kind: {
      type: String,
      enum: ["payment_receipt", "communication_template", "whatsapp_document", "whatsapp_freeform", "transactional_email"],
      required: true,
      index: true,
    },
    idempotencyKey: { type: String, required: true, unique: true },
    payload: { type: Schema.Types.Mixed, required: true },
    sensitivePayloadCiphertext: { type: String, select: false },
    status: {
      type: String,
      enum: ["pending", "processing", "retrying", "sent", "failed"],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
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

OutboundMessageSchema.index({ status: 1, nextAttemptAt: 1, lockedUntil: 1 });

export const OutboundMessage = mongoose.models.OutboundMessage || mongoose.model<IOutboundMessage>(
  "OutboundMessage",
  OutboundMessageSchema,
);
