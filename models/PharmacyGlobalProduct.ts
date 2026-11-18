import mongoose, { Schema } from "mongoose";

/** Shared reference identity only. Never store tenant prices, suppliers, batches or stock here. */
const schema = new Schema({
  provider: { type: String, enum: ["cdci", "abdm", "evitalrx", "reviewed"], required: true },
  sourceId: { type: String, required: true, maxlength: 200 },
  name: { type: String, required: true, maxlength: 200 }, genericName: { type: String, maxlength: 500, default: "" },
  composition: { type: String, maxlength: 500, default: "" }, strength: { type: String, maxlength: 80, default: "" },
  dosageForm: { type: String, maxlength: 100, default: "" }, manufacturer: { type: String, maxlength: 200, default: "" },
  supplierName: { type: String, maxlength: 200, default: "" },
  sourceIds: { product: String, generic: String, supplier: String, substances: [String], dosageForms: [String], routes: [String] },
  sourceUpdatedOn: { type: String, default: "" },
  packSize: { type: String, maxlength: 200, default: "" }, barcodes: { type: [String], default: [] },
  revision: { type: Number, required: true, default: 1, min: 1, validate: Number.isSafeInteger },
  active: { type: Boolean, required: true, default: true },
  // Operator-reviewed catalogue availability survives later provider imports.
  // It is independent of branch sale holds and is not a legal ban declaration.
  maintenance: { type: new Schema({
    status: { type: String, enum: ["available", "withdrawn", "discontinued"], required: true },
    reason: { type: String, required: true, maxlength: 500 }, reviewReference: { type: String, required: true, maxlength: 500 },
    changedAt: { type: Date, required: true }, changedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  }, { _id: false }), default: undefined },
  source: { release: { type: String, required: true }, reference: { type: String, required: true },
    licenceSha256: { type: String, required: true }, reviewReference: { type: String, required: true },
    snomedAffiliateReference: String, territory: { type: String, enum: ["IN"] },
    fileSha256: { type: String, required: true }, rowSha256: { type: String, required: true }, importedAt: { type: Date, required: true } },
  search: { value: String, grams: [String] },
}, { timestamps: true });
schema.index({ provider: 1, sourceId: 1 }, { unique: true, name: "pharmacy_global_source" });
schema.index({ active: 1, "search.grams": 1, _id: 1 }, { name: "pharmacy_global_search" });
schema.index({ active: 1, barcodes: 1, _id: 1 }, { name: "pharmacy_global_barcode" });
schema.index({ active: 1, _id: 1 }, { name: "pharmacy_global_page" });
export const PharmacyGlobalProduct = mongoose.model("PharmacyGlobalProduct", schema);
