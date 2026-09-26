import mongoose, { Schema } from "mongoose";
const schema = new Schema({
  dedupeKey: { type: String, required: true, unique: true },
  scope: { type: String, index: true },
  payloadCiphertext: { type: String, select: false },
  status: { type: String, default: "pending", enum: ["pending", "processing", "done", "failed"] },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  lockedUntil: Date,
  lockedBy: String,
  error: String,
  expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 86400_000) },
}, { timestamps: true });
schema.index({ status: 1, nextAttemptAt: 1, lockedUntil: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const WhatsAppWebhookInbox = mongoose.model("WhatsAppWebhookInbox", schema);
