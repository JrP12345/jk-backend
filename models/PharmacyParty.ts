import mongoose, { Schema } from "mongoose";

export const pharmacyPartySnapshotSchema = new Schema({
  partyId: { type: Schema.Types.ObjectId, required: true }, revision: { type: Number, required: true },
  name: { type: String, required: true }, address: { type: String, required: true }, phone: String, email: String,
  gstRegistration: { type: String, enum: ["registered", "unregistered"], required: true }, gstin: String,
  licence: { type: new Schema({ number: String, validUntil: String }, { _id: false }), default: undefined },
}, { _id: false });
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
  locationIds: { type: [Schema.Types.ObjectId], required: true },
  name: { type: String, required: true }, normalizedName: { type: String, required: true },
  kinds: { type: [String], required: true, enum: ["supplier", "customer"] }, address: { type: String, required: true },
  phone: String, email: String, gstRegistration: { type: String, enum: ["registered", "unregistered"], required: true }, gstin: String,
  licence: { type: new Schema({ number: String, validUntil: String }, { _id: false }), default: undefined },
  archived: { type: Boolean, default: false }, revision: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  createdBy: { type: Schema.Types.ObjectId, required: true }, updatedBy: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });
schema.index({ organizationId: 1, locationIds: 1, archived: 1, _id: 1 });
// Retain GST identity after archive; one party can carry both business roles.
schema.index({ organizationId: 1, gstin: 1 }, { unique: true, partialFilterExpression: { gstin: { $type: "string" } } });
export const PharmacyParty = mongoose.model("PharmacyParty", schema);
