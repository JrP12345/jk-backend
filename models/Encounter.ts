import mongoose, { Schema } from "mongoose";

const EncounterSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

  encounterType: { type: String, enum: ["opd", "ipd", "emergency", "telehealth"], default: "opd" },
  status: { type: String, enum: ["scheduled", "in_progress", "completed", "cancelled", "closed"], default: "in_progress", index: true },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
  deletedAt: { type: Date, default: null, index: true },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

EncounterSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

EncounterSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const Encounter = mongoose.model("Encounter", EncounterSchema);
