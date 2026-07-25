import mongoose, { Schema } from "mongoose";

const PendingTwoFactorSetupSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  secret: { type: String, required: true },
  otpCode: { type: String },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }, // MongoDB TTL index auto-deletes record when expired
});

export const PendingTwoFactorSetup = mongoose.model("PendingTwoFactorSetup", PendingTwoFactorSetupSchema);
