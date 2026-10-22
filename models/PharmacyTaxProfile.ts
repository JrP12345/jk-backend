import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  locationId: { type: Schema.Types.ObjectId, ref: "Location", required: true, unique: true },
  revision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  registration: { type: String, enum: ["regular", "composition", "unregistered"], required: true },
  legalName: { type: String, required: true },
  address: { type: String, required: true },
  stateCode: { type: String, required: true },
  gstin: { type: String },
  drugLicenceNumbers: { type: [String], required: true },
  authorisedSignatory: { type: String, required: true },
  reviewReference: { type: String, required: true },
  pricesIncludeTax: { type: Boolean, required: true },
  electronicReportingRequired: { type: Boolean, required: true },
  minimumHsnDigits: { type: Number, enum: [4, 6, 8], required: true },
  confirmedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  confirmedAt: { type: Date, required: true },
});
export const PharmacyTaxProfile = mongoose.model("PharmacyTaxProfile", schema);
