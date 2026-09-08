import mongoose, { Schema } from "mongoose";

export const DPDP_PURPOSES = [
  "COMMUNICATION_WHATSAPP",
  "AI_CLINICAL_ASSISTANCE",
  "PREVENTIVE_HEALTH_RECALLS",
  "FEEDBACK_AND_SURVEYS",
] as const;

export type DPDPPurpose = (typeof DPDP_PURPOSES)[number];

const DPDPConsentSchema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    purposes: [
      {
        purpose: {
          type: String,
          enum: DPDP_PURPOSES,
          required: true,
        },
        status: {
          type: String,
          enum: ["GRANTED", "WITHDRAWN"],
          default: "GRANTED",
          required: true,
        },
        updatedAt: { type: Date, default: Date.now },
      },
    ],

    history: [
      {
        purpose: { type: String, enum: DPDP_PURPOSES, required: true },
        action: { type: String, enum: ["GRANTED", "WITHDRAWN"], required: true },
        timestamp: { type: Date, default: Date.now },
        ipAddress: { type: String },
        userAgent: { type: String },
        source: {
          type: String,
          enum: ["PATIENT_PORTAL", "CLINIC_DESK", "API", "CONSENT_WITHDRAWAL_REQUEST"],
          default: "PATIENT_PORTAL",
        },
      },
    ],
  },
  { timestamps: true }
);

DPDPConsentSchema.index({ patientId: 1, organizationId: 1 }, { unique: true });

DPDPConsentSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

DPDPConsentSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const DPDPConsent = mongoose.model("DPDPConsent", DPDPConsentSchema);
