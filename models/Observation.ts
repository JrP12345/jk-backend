import mongoose, { Schema } from "mongoose";

const ObservationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  encounterId: { type: Schema.Types.ObjectId, ref: "Encounter", required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  recordedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },

  code: { type: String, required: true, index: true }, // e.g. "BP", "HR", "TEMP", "SPO2", "RR", "WEIGHT", "PAIN"
  name: { type: String, required: true },               // e.g. "Blood Pressure", "Heart Rate"
  value: { type: String, required: true },              // e.g. "120/80", "72", "98.4"
  unit: { type: String, default: "" },                 // e.g. "mmHg", "bpm", "°F", "%"
  referenceRange: { type: String, default: "" },       // e.g. "< 120/80"
  recordedAt: { type: Date, default: Date.now, index: true },
});

ObservationSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

ObservationSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const Observation = mongoose.model("Observation", ObservationSchema);
