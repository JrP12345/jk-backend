import mongoose, { Schema } from "mongoose";
const whole = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true },
  invoiceId: { type: Schema.Types.ObjectId, required: true }, invoiceNumber: { type: String, required: true },
  actorId: { type: Schema.Types.ObjectId, required: true }, currency: { type: String, enum: ["INR"], required: true },
  shiftId: { type: Schema.Types.ObjectId, required: true }, drawerCode: { type: String, required: true },
  operationKey: { type: String, required: true }, paidAt: { type: Date, required: true },
  collectedPaise: whole, paidPaise: whole, balancePaise: whole, revision: whole,
  creditedPaise: { ...whole, default: 0 },
  cashTenderedPaise: whole, cashChangePaise: whole,
  status: { type: String, enum: ["paid", "partially_paid"], required: true },
  evidenceMode: { type: String, enum: ["staff_confirmed_manual"], required: true },
  entries: { type: [new Schema({ componentId: { type: String, required: true }, amountPaise: { ...whole, min: 1 },
    paymentMethod: { type: String, enum: ["cash", "upi", "card"], required: true }, referenceNumber: String,
  }, { _id: false })], required: true },
}, { timestamps: true });
schema.index({ organizationId: 1, locationId: 1, operationKey: 1 }, { unique: true });
schema.index({ organizationId: 1, locationId: 1, invoiceId: 1, _id: 1 });
schema.pre("validate", function () {
  const amount = this.entries.reduce((sum, entry) => sum + BigInt(entry.amountPaise), 0n);
  const cash = this.entries.filter(entry => entry.paymentMethod === "cash").reduce((sum, entry) => sum + BigInt(entry.amountPaise), 0n);
  if (!this.entries.length || this.entries.length > 10 || new Set(this.entries.map(entry => entry.componentId)).size !== this.entries.length ||
      amount !== BigInt(this.collectedPaise) || this.collectedPaise <= 0 || this.collectedPaise > this.paidPaise ||
      BigInt(this.cashTenderedPaise) - cash !== BigInt(this.cashChangePaise) || (this.status === "paid") !== (this.balancePaise === 0) ||
      this.entries.some(entry => entry.paymentMethod !== "cash" && !entry.referenceNumber)) throw new Error("Collection receipt amounts and evidence do not reconcile");
});
schema.pre("save", function () { if (!this.isNew) throw new Error("Collection receipts are append-only"); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) schema.pre(operation, function () { throw new Error("Collection receipts are append-only"); });
schema.pre("bulkWrite", function () { throw new Error("Collection receipts are append-only"); });
schema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Collection receipts are append-only"); });
export const InvoiceCollectionReceipt = mongoose.model("InvoiceCollectionReceipt", schema);
