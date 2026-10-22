import mongoose, { Schema } from "mongoose";

// An operator's reviewed evidence reference; this is not government registration verification.
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  locationId: { type: Schema.Types.ObjectId, ref: "Location", required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  profession: { type: String, enum: ["pharmacist", "prescriber"], required: true },
  registrationNumber: { type: String, required: true, trim: true },
  council: { type: String, required: true, trim: true },
  address: { type: String, required: true, trim: true },
  reviewReference: { type: String, required: true, trim: true },
  validUntil: { type: Date, required: true },
  active: { type: Boolean, required: true },
  revision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  confirmedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  confirmedAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ organizationId: 1, locationId: 1, userId: 1, profession: 1 }, { unique: true });
export const PharmacyProfessionalReview = mongoose.model("PharmacyProfessionalReview", schema);
