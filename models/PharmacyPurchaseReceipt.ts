import mongoose, { Schema } from "mongoose";
const whole = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true }, purchaseId: { type: Schema.Types.ObjectId, required: true },
  deliveryReference: { type: String, required: true }, normalizedDeliveryReference: { type: String, required: true },
  actorId: { type: Schema.Types.ObjectId, required: true }, receivedAt: { type: Date, required: true }, revision: whole,
  lines: { type: [new Schema({ lineId: { type: String, required: true }, purchaseLineId: { type: String, required: true },
    medicineId: { type: Schema.Types.ObjectId, required: true }, batchId: { type: Schema.Types.ObjectId, required: true }, movementId: { type: Schema.Types.ObjectId, required: true },
    billedBaseUnits: whole, freeBaseUnits: whole, costPaise: whole, batchNumber: { type: String, required: true },
    expiry: { precision: { type: String, enum: ["day", "month"], required: true }, value: { type: String, required: true } },
  }, { _id: false })], required: true },
}, { timestamps: true });
schema.index({ organizationId: 1, locationId: 1, purchaseId: 1, normalizedDeliveryReference: 1 }, { unique: true });
schema.index({ organizationId: 1, locationId: 1, purchaseId: 1, _id: 1 });
schema.pre("save", function () { if (!this.isNew) throw new Error("Purchase receipts are append-only"); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) schema.pre(operation, function () { throw new Error("Purchase receipts are append-only"); });
schema.pre("bulkWrite", function () { throw new Error("Purchase receipts are append-only"); });
schema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Purchase receipts are append-only"); });
export const PharmacyPurchaseReceipt = mongoose.model("PharmacyPurchaseReceipt", schema);
