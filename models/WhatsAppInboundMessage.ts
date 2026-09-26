import mongoose, { Schema } from "mongoose";
const schema = new Schema({
  scope: { type: String, required: true },
  wamid: { type: String, required: true },
  phoneHash: { type: String, required: true },
  type: String,
  payloadCiphertext: { type: String, select: false },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 86400_000) },
}, { timestamps: true });
schema.index({ scope: 1, wamid: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const WhatsAppInboundMessage = mongoose.model("WhatsAppInboundMessage", schema);
