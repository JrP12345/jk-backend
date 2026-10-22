import mongoose, { Schema } from "mongoose";
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true }, partyId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ["supplier_due", "customer_due"], required: true }, currency: { type: String, enum: ["INR"], required: true }, amountPaise: { type: Number, min: 1, required: true, validate: Number.isSafeInteger },
  statementNumber: { type: String, required: true, unique: true }, sourceDate: { type: String, required: true }, sourceReference: { type: String, required: true }, normalizedReference: { type: String, required: true },
  reviewReference: { type: String, required: true }, partyRevision: { type: Number, min: 0, required: true, validate: Number.isSafeInteger },
  partySnapshot: { name: { type: String, required: true }, address: { type: String, required: true }, phone: String },
  issuerSnapshot: { legalName: { type: String, required: true }, address: { type: String, required: true }, drugLicenceNumbers: [String] },
  actorId: { type: Schema.Types.ObjectId, required: true }, operationKey: { type: String, required: true }, recordedAt: { type: Date, required: true, immutable: true },
  invoiceId: { type: Schema.Types.ObjectId }, settlementRevision: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
});
schema.index({ organizationId: 1, locationId: 1, operationKey: 1 }, { unique: true });
schema.index({ organizationId: 1, partyId: 1, kind: 1, sourceDate: 1, normalizedReference: 1 }, { unique: true });
schema.index({ organizationId: 1, locationId: 1, partyId: 1, _id: 1 });
schema.pre("validate", function () { if ((this.kind === "customer_due") !== Boolean(this.invoiceId)) throw new Error("Opening balance statement source does not reconcile"); });
schema.pre("save", function () { if (!this.isNew && this.modifiedPaths().some(path => !["settlementRevision", "__v"].includes(path))) throw new Error("Opening balance source facts are immutable"); });
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) schema.pre(op, function () { throw new Error("Use guarded opening balance settlement mutations"); });
schema.pre("bulkWrite", function () { throw new Error("Opening balance source facts are immutable"); });
schema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Opening balance source facts are immutable"); });
export const PharmacyOpeningBalance = mongoose.model("PharmacyOpeningBalance", schema);
