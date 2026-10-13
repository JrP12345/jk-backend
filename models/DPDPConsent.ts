import mongoose, { Schema } from "mongoose";

export const DPDP_PURPOSES = [
  "COMMUNICATION_WHATSAPP",
  "AI_CLINICAL_ASSISTANCE",
  "PREVENTIVE_HEALTH_RECALLS",
  "FEEDBACK_AND_SURVEYS",
  "COMMUNICATION_EMAIL",
  "COMMUNICATION_PHONE",
] as const;

export type DPDPPurpose = (typeof DPDP_PURPOSES)[number];

const DPDPConsentSchema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    revision: { type: Number, default: 0 },

    purposes: [
      {
        purpose: {
          type: String,
          enum: DPDP_PURPOSES,
          required: true,
        },
        status: {
          type: String,
          enum: ["UNKNOWN", "GRANTED", "WITHDRAWN"],
          default: "UNKNOWN",
          required: true,
        },
        updatedAt: { type: Date, default: Date.now },
        evidence: {
          noticeVersion: String,
          method: { type: String, enum: ["portal_confirmation", "in_person_confirmation", "written_consent", "verified_patient_request"] },
          recordedBy: { type: Schema.Types.ObjectId, ref: "User" },
          recordedAt: Date,
          activityId: { type: Schema.Types.ObjectId, ref: "CrmActivity" },
          recipientHash: String,
          familyRelationshipId: { type: Schema.Types.ObjectId, ref: "FamilyRelationship" },
          familyAuthorityRevision: Number,
        },
      },
    ],

    history: [
      {
        purpose: { type: String, enum: DPDP_PURPOSES, required: true },
        action: { type: String, enum: ["GRANTED", "WITHDRAWN"], required: true },
        timestamp: { type: Date, default: Date.now },
        actorId: { type: Schema.Types.ObjectId, ref: "User" },
        ipAddress: { type: String },
        userAgent: { type: String },
        source: {
          type: String,
          enum: ["PATIENT_PORTAL", "LOCATION_DESK", "API", "CONSENT_WITHDRAWAL_REQUEST"],
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
