import mongoose, { Schema } from "mongoose";

const AIOrganizationConfigSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, unique: true, index: true },
  defaultModelAlias: {
    type: String,
    enum: ["CLINICAL_FAST", "CLINICAL_ACCURATE", "CLINICAL_REASONING"],
    default: "CLINICAL_FAST"
  },
  monthlyTokenQuota: { type: Number, default: 10000000 },
  externalAIKillSwitch: { type: Boolean, default: false, index: true },
  defaultDataClassification: {
    type: String,
    enum: ["nonclinical", "deidentified_clinical", "identifiable_clinical"],
    default: "deidentified_clinical"
  },
  allowIdentifiableClinical: { type: Boolean, default: false },
  providerBAA: { type: Boolean, default: false },
  zeroRetentionContract: { type: Boolean, default: true },
  messageRetentionDays: { type: Number, default: 30 },
  allowedProviders: [{ type: String }],
  featureFlags: {
    enableStreaming: { type: Boolean, default: true },
    enablePHIAnonymization: { type: Boolean, default: true },
    enableMultiAgentRouting: { type: Boolean, default: true },
    enableToolExecution: { type: Boolean, default: true }
  },
  updatedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null }
}, { timestamps: true });

export const AIOrganizationConfig = mongoose.model("AIOrganizationConfig", AIOrganizationConfigSchema);
