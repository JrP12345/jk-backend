import mongoose, { Schema } from "mongoose";

const OrganizationSchema = new Schema({
  name: { type: String, required: true },
  address: { type: String },
  city: { type: String, required: true },
  phone: { type: String },
  email: { type: String },
  description: { type: String },
  image_url: { type: String },
  timings: { type: String }, // JSON string of schedule
  working_days: { type: String }, // JSON string
  plan: { type: String, enum: ["starter", "pro", "enterprise"], default: "starter" },
  maxClinics: { type: Number, default: 1 },
  maxDoctors: { type: Number, default: 2 },
  maxStaff: { type: Number, default: 2 },
  onboardingStatus: {
    type: String,
    enum: ["NOT_STARTED", "ORGANIZATION_CREATED", "ADMIN_CREATED", "CLINIC_CREATED", "TWO_FACTOR_PENDING", "COMPLETED"],
    default: "NOT_STARTED",
  },
  isOnboarded: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  status: { type: String, enum: ["active", "inactive"], default: "active" },
  createdAt: { type: Date, default: Date.now },
});

OrganizationSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

OrganizationSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const Organization = mongoose.model("Organization", OrganizationSchema);
