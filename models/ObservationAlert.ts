import mongoose, { Schema } from "mongoose";

const ObservationAlertSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  encounterId: { type: Schema.Types.ObjectId, ref: "Encounter", required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },

  scoreId: { type: Schema.Types.ObjectId, ref: "ObservationScore", required: true },
  severity: { type: String, enum: ["warning", "urgent", "emergency"], required: true },
  message: { type: String, required: true },
  recommendedAction: { type: String, required: true },

  status: { type: String, enum: ["open", "acknowledged", "resolved", "expired"], default: "open", index: true },
  acknowledgedBy: { type: Schema.Types.ObjectId, ref: "User" },
  acknowledgedAt: { type: Date },
  resolvedAt: { type: Date },

  createdAt: { type: Date, default: Date.now },
});

ObservationAlertSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

ObservationAlertSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const ObservationAlert = mongoose.model("ObservationAlert", ObservationAlertSchema);
