import mongoose, { Schema } from "mongoose";
const whole = { type: Number, min: 0, required: true, validate: Number.isSafeInteger };
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true }, purchaseId: { type: Schema.Types.ObjectId, required: true }, supplierId: { type: Schema.Types.ObjectId, required: true },
  supplierInvoiceNumber: { type: String, required: true }, actorId: { type: Schema.Types.ObjectId, required: true }, operationKey: { type: String, required: true }, createdAt: { type: Date, required: true, immutable: true },
  settlementRevision: whole, reason: { type: String, required: true }, reviewReference: { type: String, required: true }, expectedCreditPaise: whole,
  lines: { type: [new Schema({ receiptId: { type: Schema.Types.ObjectId, required: true }, receiptLineId: { type: String, required: true }, purchaseLineId: { type: String, required: true },
    batchId: { type: Schema.Types.ObjectId, required: true }, medicineId: { type: Schema.Types.ObjectId, required: true }, batchNumber: { type: String, required: true }, quantity: { ...whole, min: 1 }, expectedCreditPaise: whole,
    movementId: { type: Schema.Types.ObjectId, required: true },
  }, { _id: false })], required: true },
});
schema.index({ organizationId: 1, locationId: 1, operationKey: 1 }, { unique: true });
schema.index({ organizationId: 1, locationId: 1, purchaseId: 1, _id: 1 });
schema.pre("validate", function () { if (!this.lines.length || this.lines.length > 100 || new Set(this.lines.map(line => `${line.receiptId}:${line.receiptLineId}`)).size !== this.lines.length || this.lines.reduce((sum, line) => sum + BigInt(line.expectedCreditPaise), 0n) !== BigInt(this.expectedCreditPaise)) throw new Error("Purchase return sources do not reconcile"); });
schema.pre("save", function () { if (!this.isNew) throw new Error("Purchase returns are append-only"); });
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) schema.pre(op, function () { throw new Error("Purchase returns are append-only"); });
schema.pre("bulkWrite", function () { throw new Error("Purchase returns are append-only"); });
schema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Purchase returns are append-only"); });
export const PharmacyPurchaseReturn = mongoose.model("PharmacyPurchaseReturn", schema);
