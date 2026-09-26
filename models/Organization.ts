import mongoose, { Schema } from "mongoose";

const OrganizationSchema = new Schema({
  name: { type: String, required: true },
  address: { type: String },
  city: { type: String, required: true },
  phone: { type: String },
  email: { type: String },
  description: { type: String },
  image_url: { type: String },
  logo_url: { type: String },
  images: [{ type: String }],
  timings: { type: String }, // JSON string of schedule
  working_days: { type: String }, // JSON string
  plan: { type: String, enum: ["starter", "pro", "enterprise"], default: "starter" },
  maxClinics: { type: Number, default: 1 },
  maxDoctors: { type: Number, default: 2 },
  maxStaff: { type: Number, default: 2 },
  taxId: { type: String }, // GSTIN / EIN
  licenseNumber: { type: String }, // Operating License No.
  currency: { type: String, enum: ["INR", "USD", "EUR", "GBP", "AED"], default: "INR" },
  timezone: { type: String, default: "Asia/Kolkata" },
  onboardingStatus: {
    type: String,
    enum: ["NOT_STARTED", "ORGANIZATION_CREATED", "ADMIN_CREATED", "CLINIC_CREATED", "TWO_FACTOR_PENDING", "COMPLETED"],
    default: "NOT_STARTED",
  },
  isOnboarded: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  status: { type: String, enum: ["active", "inactive"], default: "active" },
  authVersion: { type: Number, default: 1 },
  // ─── SMTP / Outbound Email Gateway Configuration ───────────────────────
  // If set, overrides backend .env SMTP credentials for this organization.
  smtp: {
    host: { type: String, default: null },
    port: { type: Number, default: 587 },
    secure: { type: Boolean, default: false },
    user: { type: String, default: null },
    pass: { type: String, default: null, select: false }, // stored encrypted/internal, never selected by default
    fromEmail: { type: String, default: null },
    fromName: { type: String, default: null },
  },
  // ─── Meta WhatsApp Business Gateway & Credits Configuration ────────────
  whatsappConfig: {
    mode: { type: String, enum: ["disabled", "shared", "dedicated"], default: "shared" },
    wabaId: { type: String, default: null },
    phoneNumberId: { type: String, default: null },
    accessToken: { type: String, default: null, select: false }, // encrypted by configuration controller
    appSecret: { type: String, default: null, select: false },
    verifyToken: { type: String, default: null, select: false },
    connectionStatus: { type: String, enum: ["disconnected", "pending", "connected", "error"], default: "disconnected" },
    verifiedAt: Date,
    lastError: String,
    phoneDisplay: String,
    monthlyQuota: { type: Number, default: 500 },
    creditsBalance: { type: Number, default: 500 },
    creditsUsedThisMonth: { type: Number, default: 0 },
    prepaidCredits: { type: Number, default: 0 },
    quotaResetMonth: { type: String, default: "" },
    lowBalanceThreshold: { type: Number, default: 50 },
    autoRechargeEnabled: { type: Boolean, default: false },
    autoRechargePack: { type: String, enum: ["bronze", "silver", "gold"], default: "bronze" },
    notifications: {
      sendBookingConfirmation: { type: Boolean, default: true },
      sendConsultationComplete: { type: Boolean, default: true },
      sendAppointmentCancellation: { type: Boolean, default: true },
      sendTurnApproaching: { type: Boolean, default: false },
      sendQueueDelayAlert: { type: Boolean, default: true },
      sendDisruptionAlert: { type: Boolean, default: true },
    },
  },
  createdAt: { type: Date, default: Date.now },
});

OrganizationSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

OrganizationSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    if (ret.smtp && "pass" in ret.smtp) {
      delete ret.smtp.pass;
    }
    if (ret.whatsappConfig && "accessToken" in ret.whatsappConfig) {
      delete ret.whatsappConfig.accessToken;
    }
    if (ret.whatsappConfig) {
      delete ret.whatsappConfig.appSecret;
      delete ret.whatsappConfig.verifyToken;
    }
    return ret;
  }
});

OrganizationSchema.index({ "whatsappConfig.wabaId": 1 }, { unique: true, partialFilterExpression: { "whatsappConfig.wabaId": { $type: "string" } } });
export const Organization = mongoose.model("Organization", OrganizationSchema);
