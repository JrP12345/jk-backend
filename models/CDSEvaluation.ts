import mongoose, { Schema } from "mongoose";

const CDSEvaluationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  encounterId: { type: Schema.Types.ObjectId, ref: "Encounter", index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  prescriptionIds: [{ type: Schema.Types.ObjectId, ref: "Prescription" }],

  engineVersion: { type: String, default: "1.0.0" },
  terminologyVersion: { type: String, default: "1.0.0" },
  interactionDatasetVersion: { type: String, default: "2026.07.22" },

  findings: [Schema.Types.Mixed],
  clinicianDecision: { type: String, enum: ["accepted", "overridden", "blocked"], required: true },
  overrideReason: { type: String, default: "" },

  metrics: {
    durationMs: { type: Number, default: 0 },
    rulesExecuted: { type: Number, default: 0 },
    findingsCount: { type: Number, default: 0 },
  },

  evaluatedAt: { type: Date, default: Date.now, index: true },
});

CDSEvaluationSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

CDSEvaluationSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const CDSEvaluation = mongoose.model("CDSEvaluation", CDSEvaluationSchema);
