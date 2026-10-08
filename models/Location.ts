import mongoose, { Schema } from "mongoose";
import { FACILITY_TYPES } from "../utilities/facility.ts";

// One physical healthcare location owned by an organization.
const LocationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  name: { type: String, required: true },
  facilityType: { type: String, enum: [...FACILITY_TYPES], default: null },
  logo: { type: String },
  images: [{ type: String }],
  description: { type: String },
  brandColor: { type: String, enum: ["#0F6F66", "#1D4ED8", "#6D28D9", "#9A3412"], default: "#0F6F66" },
  phone: { type: String },
  email: { type: String },
  address: { type: String },
  city: { type: String, required: true },
  timezone: { type: String }, // Optional branch override; otherwise use organization timezone.
  latitude: { type: Number },
  longitude: { type: Number },
  timings: { type: String }, // JSON schedule string
  amenities: [{ type: String }],
  onlineBookingSafetyBuffer: { type: Number, default: 30 }, // Default safety buffer in minutes for online bookings
  upiVpa: { type: String, trim: true, default: "" }, // Direct NPCI/BharatPe UPI VPA for countertop QR
  merchantName: { type: String, trim: true, default: "" }, // Official registered merchant business name
  isActive: { type: Boolean, default: true },
  // Publishing is independent of operational activation and subscription access.
  isPublished: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

LocationSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

LocationSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const Location = mongoose.model("Location", LocationSchema);
