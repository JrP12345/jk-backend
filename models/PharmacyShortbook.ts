import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true },
  locationId: { type: Schema.Types.ObjectId, required: true },
  medicineId: { type: Schema.Types.ObjectId, required: true },
  quantity: { type: Number, required: true, min: 1, max: 1_000_000, validate: Number.isSafeInteger },
  unitVersion: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  note: { type: String, maxlength: 300, default: "" },
  status: { type: String, enum: ["open", "resolved"], required: true },
  revision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  updatedBy: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });
schema.index({ organizationId: 1, locationId: 1, medicineId: 1 }, { unique: true });
schema.index({ organizationId: 1, locationId: 1, status: 1, _id: 1 });
export const PharmacyShortbook = mongoose.model("PharmacyShortbook", schema);
