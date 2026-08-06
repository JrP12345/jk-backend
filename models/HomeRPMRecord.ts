import mongoose, { Schema } from "mongoose";

const HomeRPMRecordSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
    patientName: { type: String, required: true, index: true },
    carePlanType: {
      type: String,
      enum: ["hypertension_management", "diabetes_rpm", "post_op_wound_care", "copd_oxygen_monitoring", "heart_failure_vitals"],
      required: true,
      index: true,
    },
    assignedNurse: { type: String, trim: true },
    deviceSerialNumber: { type: String, required: true, trim: true, index: true },
    latestVitals: {
      systolicBP: { type: Number },
      diastolicBP: { type: Number },
      spO2Percent: { type: Number },
      bloodGlucoseMgDl: { type: Number },
      heartRateBpm: { type: Number },
      lastSyncTimestamp: { type: Date },
    },
    nurseVisitStatus: {
      type: String,
      enum: ["scheduled", "in_transit", "completed", "cancelled"],
      default: "scheduled",
      index: true,
    },
    vitalAlertSeverity: {
      type: String,
      enum: ["normal", "borderline", "critical_alert"],
      default: "normal",
      index: true,
    },
    address: { type: String, required: true, trim: true },
    notes: { type: String, default: "" },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

HomeRPMRecordSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

HomeRPMRecordSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const HomeRPMRecord = mongoose.model("HomeRPMRecord", HomeRPMRecordSchema);
