import mongoose, { Schema } from "mongoose";

const BiomedicalAssetSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    assetTag: { type: String, required: true, unique: true, index: true }, // e.g. BMED-2026-904
    deviceName: { type: String, required: true, index: true },
    category: {
      type: String,
      enum: ["life_support", "diagnostic_imaging", "surgical_instrument", "patient_monitor", "laboratory_analyzer", "infusion_pump"],
      default: "life_support",
      index: true,
    },
    serialNumber: { type: String, required: true },
    manufacturer: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true, index: true },
    location: { type: String, required: true, trim: true },
    operationalStatus: {
      type: String,
      enum: ["operational", "under_maintenance", "calibration_due", "decommissioned", "out_of_service"],
      default: "operational",
      index: true,
    },
    lastCalibrationDate: { type: Date, default: Date.now },
    nextCalibrationDueDate: { type: Date, required: true, index: true },
    riskClassification: {
      type: String,
      enum: ["low_risk", "medium_risk", "high_risk_critical"],
      default: "high_risk_critical",
      index: true,
    },
    maintenanceContact: { type: String, required: true, trim: true },
    notes: { type: String, default: "" },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

BiomedicalAssetSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

BiomedicalAssetSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const BiomedicalAsset = mongoose.model("BiomedicalAsset", BiomedicalAssetSchema);
