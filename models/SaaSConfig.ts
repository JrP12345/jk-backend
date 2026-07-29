import mongoose, { Schema, Document } from "mongoose";

export interface ISaaSConfig extends Document {
  key: string; // Default: 'platform_config'
  razorpayKeyId: string;
  razorpayKeySecret: string;
  razorpayWebhookSecret: string;
  isLiveMode: boolean;
  currency: string;
  updatedAt: Date;
}

const SaaSConfigSchema = new Schema<ISaaSConfig>(
  {
    key: { type: String, required: true, unique: true, default: "platform_config" },
    razorpayKeyId: { type: String, default: "" },
    razorpayKeySecret: { type: String, default: "" },
    razorpayWebhookSecret: { type: String, default: "ananta_razorpay_webhook_secret_2026" },
    isLiveMode: { type: Boolean, default: false },
    currency: { type: String, default: "INR" },
  },
  { timestamps: true }
);

export const SaaSConfig = mongoose.models.SaaSConfig || mongoose.model<ISaaSConfig>("SaaSConfig", SaaSConfigSchema);
