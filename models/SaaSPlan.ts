import mongoose, { Schema } from "mongoose";

const SaaSPlanSchema = new Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true, index: true },
  description: { type: String, required: true },
  monthlyPrice: { type: Number, required: true, default: 0 },
  annualPrice: { type: Number, required: true, default: 0 },
  currency: { type: String, default: "INR" },
  trialDays: { type: Number, default: 15 },
  status: { type: String, enum: ["active", "inactive", "archived"], default: "active", index: true },
  displayOrder: { type: Number, default: 0 },
  isPopular: { type: Boolean, default: false },
  limits: {
    maxHospitals: { type: Number, default: 1 },
    maxClinics: { type: Number, default: 1 },
    maxDoctors: { type: Number, default: 2 },
    maxStaff: { type: Number, default: 5 },
    maxPatients: { type: Number, default: 500 },
    maxAppointments: { type: Number, default: 1000 },
    maxStorageMB: { type: Number, default: 1024 },
  },
  features: {
    analytics: { type: Boolean, default: false },
    auditLogs: { type: Boolean, default: false },
    multiBranch: { type: Boolean, default: false },
    dataExport: { type: Boolean, default: false },
    apiAccess: { type: Boolean, default: false },
    aiFeatures: { type: Boolean, default: false },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

SaaSPlanSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

SaaSPlanSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const SaaSPlan = mongoose.model("SaaSPlan", SaaSPlanSchema);
