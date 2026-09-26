import mongoose, { Schema } from "mongoose";
const schema = new Schema({
  scope: { type: String, required: true },
  phoneHash: { type: String, required: true },
  optedOut: { type: Boolean, default: false },
  lastInboundAt: Date,
}, { timestamps: true });
schema.index({ scope: 1, phoneHash: 1 }, { unique: true });
export const WhatsAppRecipient = mongoose.model("WhatsAppRecipient", schema);
