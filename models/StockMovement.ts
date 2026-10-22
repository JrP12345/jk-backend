import mongoose, { Schema } from "mongoose";

const safeQuantity = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const allocationSchema = new Schema({
  batchId: { type: Schema.Types.ObjectId, ref: "MedicineBatch", required: true },
  beforeQuantity: safeQuantity,
  afterQuantity: safeQuantity,
  quantityDelta: { type: Number, required: true, validate: Number.isSafeInteger },
}, { _id: false });

const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  locationId: { type: Schema.Types.ObjectId, ref: "Location", required: true },
  medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true },
  kind: { type: String, enum: ["opening_baseline", "opening_receipt", "receipt", "dispense", "adjustment", "sales_return", "purchase_return", "transfer_out", "transfer_in", "transfer_return"], required: true },
  stockMode: { type: String, enum: ["legacy_aggregate", "batch"], required: true },
  revision: safeQuantity,
  beforeQuantity: safeQuantity,
  afterQuantity: safeQuantity,
  quantityDelta: { type: Number, required: true, validate: Number.isSafeInteger },
  allocations: { type: [allocationSchema], default: [] },
  reason: { type: String, enum: ["opening_baseline", "opening_receipt", "receipt", "dispense", "physical_audit", "damaged", "expired", "restock", "other", "sales_return", "purchase_return", "transfer_out", "transfer_in", "transfer_return"], required: true },
  disposition: { type: String, enum: ["opening_checkpoint", "opening_receipt", "receipt", "dispense", "count_correction", "write_off", "quarantine_return", "supplier_return", "transfer_out", "transfer_in", "transfer_return"], required: true },
  transferSource: { type: new Schema({ transferId: { type: Schema.Types.ObjectId, required: true }, eventId: { type: Schema.Types.ObjectId, required: true } }, { _id: false }), default: undefined },
  returnId: { type: Schema.Types.ObjectId },
  actorId: { type: Schema.Types.ObjectId, ref: "User" },
  purchaseSource: { type: new Schema({ purchaseId: Schema.Types.ObjectId, purchaseLineId: String, receiptId: Schema.Types.ObjectId }, { _id: false }), default: undefined },
  clientRequestId: { type: String, maxlength: 100 },
  notes: { type: String, trim: true, maxlength: 500 },
  createdAt: { type: Date, default: Date.now, immutable: true },
});

schema.index({ medicineId: 1, revision: 1 }, { unique: true });
schema.index({ organizationId: 1, locationId: 1, medicineId: 1, revision: -1 });
schema.pre("validate", function () {
  if (this.afterQuantity - this.beforeQuantity !== this.quantityDelta ||
      this.allocations.some(lot => lot.afterQuantity - lot.beforeQuantity !== lot.quantityDelta) ||
      (this.allocations.length > 0 && this.allocations.reduce((sum, lot) => sum + lot.quantityDelta, 0) !== this.quantityDelta)) {
    throw new Error("Stock movement quantities do not reconcile");
  }
});
schema.pre("save", function () {
  if (!this.isNew) throw new Error("Stock movements are append-only");
});
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  schema.pre(operation, function () { throw new Error("Stock movements are append-only"); });
}
schema.pre("bulkWrite", function () { throw new Error("Stock movements are append-only"); });
schema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Stock movements are append-only"); });

export const StockMovement = mongoose.model("StockMovement", schema);
