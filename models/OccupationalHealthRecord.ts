import mongoose, { Schema } from "mongoose";

const OccupationalHealthRecordSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    employeeId: { type: String, required: true, index: true }, // e.g. EMP-9021
    employeeName: { type: String, required: true, index: true },
    department: { type: String, required: true, index: true }, // e.g. Emergency Nursing, Radiology
    recordType: {
      type: String,
      enum: ["annual_health_exam", "needle_stick_incident", "radiation_dosimetry", "immunization_compliance", "fitness_for_duty"],
      required: true,
      index: true,
    },
    immunizationStatus: {
      type: String,
      enum: ["fully_compliant", "booster_due", "non_compliant"],
      default: "fully_compliant",
      index: true,
    },
    radiationDosimetrymSv: { type: Number, default: 0 }, // Cumulative mSv exposure
    needleStickProtocolStatus: {
      type: String,
      enum: ["none", "post_exposure_prophylaxis", "cleared"],
      default: "none",
      index: true,
    },
    fitnessStatus: {
      type: String,
      enum: ["fit_for_unrestricted_duty", "conditional_duty", "temporarily_unfit"],
      default: "fit_for_unrestricted_duty",
      index: true,
    },
    examinationDate: { type: Date, default: Date.now, index: true },
    nextDueDate: { type: Date, default: null },
    examiningPhysician: { type: String, required: true, trim: true },
    notes: { type: String, default: "" },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

OccupationalHealthRecordSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

OccupationalHealthRecordSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const OccupationalHealthRecord = mongoose.model("OccupationalHealthRecord", OccupationalHealthRecordSchema);
