import mongoose, { Schema } from "mongoose";
import { encryptField } from "../utilities/cryptoEnvelope.ts";

const schema = new Schema({
  email: { type: String, required: true, trim: true, lowercase: true },
  setupTokenHash: { type: String, required: true, select: false },
  intentCiphertext: { type: String, required: true, select: false, set: encryptField },
  resultCiphertext: { type: String, select: false, set: encryptField },
  state: { type: String, enum: ["pending", "verified", "provisioned"], default: "pending", required: true },
  ownerUserId: { type: Schema.Types.ObjectId, ref: "User", default: undefined },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization" },
  expiresAt: { type: Date, required: true }, verifiedAt: Date, provisionedAt: Date, lastSentAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ email: 1 }, { unique: true });
schema.index({ ownerUserId: 1 }, { unique: true, sparse: true });
// This is also the persistent self-service trial claim; expiry must not erase it.
export const PharmacyOnboardingRequest = mongoose.model("PharmacyOnboardingRequest", schema);
