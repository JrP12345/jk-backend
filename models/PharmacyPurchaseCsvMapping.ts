import mongoose, { Schema } from "mongoose";

// Scope-derived SHA-256 primary keys make first-save races safe without a separate
// unique-index readiness dependency. Setup still owns creating these collections.
const formatSchema = new Schema({
  _id: { type: String, required: true, match: /^[a-f\d]{64}$/ },
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true }, supplierId: { type: Schema.Types.ObjectId, required: true },
  formatKey: { type: String, required: true }, mapping: { type: Map, of: String, required: true }, priceBasis: { type: String, enum: ["base_unit", "pack"], required: true },
  revision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger }, lastSaveHash: { type: String, required: true },
  createdBy: { type: Schema.Types.ObjectId, required: true }, updatedBy: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });
const itemSchema = new Schema({
  _id: { type: String, required: true, match: /^[a-f\d]{64}$/ },
  formatId: { type: String, required: true }, sourceColumn: { type: String, required: true, maxlength: 100 }, sourceValue: { type: String, required: true, maxlength: 2000 },
  medicineId: { type: Schema.Types.ObjectId, required: true }, identityHash: { type: String, required: true, match: /^[a-f\d]{64}$/ },
  updatedBy: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });

export const PharmacyPurchaseCsvFormat = mongoose.model("PharmacyPurchaseCsvFormat", formatSchema);
export const PharmacySupplierItemMapping = mongoose.model("PharmacySupplierItemMapping", itemSchema);
