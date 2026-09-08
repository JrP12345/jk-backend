import mongoose, { Schema } from "mongoose";

const ClinicSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  name: { type: String, required: true },
  logo: { type: String },
  description: { type: String },
  phone: { type: String },
  email: { type: String },
  address: { type: String },
  city: { type: String, required: true },
  latitude: { type: Number },
  longitude: { type: Number },
  timings: { type: String }, // JSON schedule string
  facilities: [{ type: String }],
  onlineBookingSafetyBuffer: { type: Number, default: 30 }, // Default safety buffer in minutes for online bookings
  upiVpa: { type: String, trim: true, default: "" }, // Direct NPCI/BharatPe UPI VPA for countertop QR
  merchantName: { type: String, trim: true, default: "" }, // Official registered merchant business name
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

ClinicSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

ClinicSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const Clinic = mongoose.model("Clinic", ClinicSchema);
