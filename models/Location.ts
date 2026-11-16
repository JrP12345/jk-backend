import mongoose, { Schema } from "mongoose";
import { FACILITY_TYPES } from "../utilities/facility.ts";
import { isGoogleMapsEmbedUrl } from "../utilities/googleMapsEmbed.ts";

// One physical healthcare location owned by an organization.
const LocationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  name: { type: String, required: true },
  // Held until an authenticated, reconciled release; expiry never clears ownership.
  pharmacyOfflineOwner: { type: String, default: undefined },
  facilityType: { type: String, enum: [...FACILITY_TYPES], default: null },
  publicPharmacy: { type: new Schema({ catalogueEnabled: { type: Boolean, default: false }, pickupEnabled: { type: Boolean, default: false }, revision: { type: Number, required: true, min: 0, validate: Number.isSafeInteger } }, { _id: false }), default: undefined },
  pharmacyCapability: { type: new Schema({ enabled: { type: Boolean, required: true }, revision: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    inventoryMode: { type: String, enum: ["tracked", "billing_only"], default: "tracked", required: true },
    reviewReference: String, confirmedBy: { type: Schema.Types.ObjectId, ref: "User" }, confirmedAt: Date }, { _id: false }), default: undefined },
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
  googleMapsEmbedUrl: { type: String, default: null, validate: { validator: (value: unknown) => value == null || value === "" || isGoogleMapsEmbedUrl(value), message: "Use a Google Maps embed URL" } },
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
    if (ret.pharmacyCapability) ret.pharmacyCapability = { enabled: ret.pharmacyCapability.enabled, revision: ret.pharmacyCapability.revision, inventoryMode: ret.pharmacyCapability.inventoryMode };
    delete ret._id;
    delete ret.__v;
    delete ret.pharmacyOfflineOwner;
    return ret;
  }
});

export const Location = mongoose.model("Location", LocationSchema);
