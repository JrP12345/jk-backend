import mongoose, { Schema } from "mongoose";
const schema = new Schema({
  key: { type: String, unique: true, required: true },
  payloadCiphertext: { type: String, select: false },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const WhatsAppBookingSession = mongoose.model("WhatsAppBookingSession", schema);
