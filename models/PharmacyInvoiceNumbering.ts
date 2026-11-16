import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  locationId: { type: Schema.Types.ObjectId, ref: "Location", required: true, unique: true },
  prefixTemplate: { type: String, required: true, maxlength: 20 },
  digits: { type: Number, required: true, min: 1, max: 9, validate: Number.isSafeInteger },
  resetPolicy: { type: String, enum: ["continuous", "financial_year"], required: true },
  revision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  allocationRevision: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger },
  reviewReference: { type: String, required: true, maxlength: 500 },
  confirmedBy: { type: Schema.Types.ObjectId, ref: "User", required: true }, confirmedAt: { type: Date, required: true },
}, { timestamps: true });
export const PharmacyInvoiceNumbering = mongoose.model("PharmacyInvoiceNumbering", schema);

// A prefix is never reassigned, including after the owner changes their active format.
const reservation = new Schema({
  prefix: { type: String, required: true },
  locationId: { type: Schema.Types.ObjectId, ref: "Location", required: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
reservation.index({ organizationId: 1, prefix: 1 }, { unique: true, name: "pharmacy_organization_prefix_v1" });
reservation.pre("save", function () { if (!this.isNew) throw new Error("Invoice prefix reservations are immutable"); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const)
  reservation.pre(operation, function () { throw new Error("Invoice prefix reservations are immutable"); });
reservation.pre("bulkWrite", function () { throw new Error("Invoice prefix reservations are immutable"); });
reservation.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Invoice prefix reservations are immutable"); });
export const PharmacyInvoicePrefix = mongoose.model("PharmacyInvoicePrefix", reservation);
