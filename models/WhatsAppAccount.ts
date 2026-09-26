import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  key: { type: String, unique: true, default: "platform" },
  enabled: { type: Boolean, default: false },
  wabaId: String,
  phoneNumberId: String,
  accessToken: { type: String, select: false },
  appSecret: { type: String, select: false },
  verifyToken: { type: String, select: false },
  connectionStatus: { type: String, default: "disconnected" },
  verifiedAt: Date,
  lastError: String,
  phoneDisplay: String,
}, { timestamps: true });
export const WhatsAppAccount = mongoose.model("WhatsAppAccount", schema);
