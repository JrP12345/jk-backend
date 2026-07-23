import mongoose, { Schema } from "mongoose";

const ObservationScoreSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  encounterId: { type: Schema.Types.ObjectId, ref: "Encounter", required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },

  algorithmId: { type: String, required: true },
  algorithmVersion: { type: String, required: true },

  totalScore: { type: Number, required: true },
  riskCategory: { type: String, enum: ["Low", "Low-Medium", "Medium", "High"], required: true },
  isComplete: { type: Boolean, required: true },
  missingParameters: [{ type: String }],
  parameterBreakdown: [Schema.Types.Mixed],
  observationIds: [{ type: Schema.Types.ObjectId, ref: "Observation" }],

  evaluatedAt: { type: Date, default: Date.now, index: true },
});

ObservationScoreSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

ObservationScoreSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const ObservationScore = mongoose.model("ObservationScore", ObservationScoreSchema);
