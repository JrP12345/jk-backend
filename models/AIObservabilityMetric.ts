import mongoose, { Schema } from "mongoose";

const AIObservabilityMetricSchema = new Schema({
  correlationId: { type: String, required: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  sessionId: { type: String, default: "general", index: true },
  provider: { type: String, required: true },
  model: { type: String, required: true },
  modelAlias: { type: String, default: "CLINICAL_FAST" },
  inputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  estimatedCostUSD: { type: Number, default: 0 },
  latencyMs: { type: Number, default: 0 },
  status: { type: String, enum: ["success", "failover", "error", "blocked_privacy", "blocked_killswitch"], default: "success", index: true },
  errorMessage: { type: String, default: null },
  privacyClassification: {
    type: String,
    enum: ["nonclinical", "deidentified_clinical", "identifiable_clinical"],
    default: "deidentified_clinical"
  },
  dataCategoriesDisclosed: [{ type: String }],
  purpose: { type: String, default: "clinical_assistant" },
  retentionCategory: { type: String, default: "operational_transient" },
  timestamp: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

AIObservabilityMetricSchema.index({ organizationId: 1, timestamp: -1 });
AIObservabilityMetricSchema.index({ userId: 1, timestamp: -1 });

export const AIObservabilityMetric = mongoose.model("AIObservabilityMetric", AIObservabilityMetricSchema);
