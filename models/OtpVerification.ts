import mongoose, { Schema, Document } from "mongoose";

export interface IOtpVerification extends Document {
  phone?: string;
  email?: string;
  otpHash: string;
  purpose: "authentication" | "phone_verification" | "email_verification" | "record_claim" | "record_access";
  context?: string;
  expiresAt: Date;
  attempts: number;
  verified: boolean;
  requestCount: number;
  windowStart: Date;
  createdAt: Date;
  updatedAt: Date;
}

const OtpVerificationSchema = new Schema<IOtpVerification>(
  {
    phone: { type: String, required: false, index: true },
    email: { type: String, required: false, index: true, lowercase: true, trim: true },
    otpHash: { type: String, required: true },
    purpose: {
      type: String,
      enum: ["authentication", "phone_verification", "email_verification", "record_claim", "record_access"],
      required: true,
    },
    expiresAt: { type: Date, required: true, expires: 0 }, // TTL index
    context: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    verified: { type: Boolean, default: false },
    requestCount: { type: Number, default: 1 },
    windowStart: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

OtpVerificationSchema.index({ phone: 1, purpose: 1 }, { sparse: true });
OtpVerificationSchema.index({ email: 1, purpose: 1 }, { sparse: true });

export const OtpVerification =
  mongoose.models.OtpVerification ||
  mongoose.model<IOtpVerification>("OtpVerification", OtpVerificationSchema);
