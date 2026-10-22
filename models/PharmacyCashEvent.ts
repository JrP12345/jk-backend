import mongoose, { Schema } from "mongoose";
const whole = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true }, partyId: { type: Schema.Types.ObjectId },
  invoiceId: { type: Schema.Types.ObjectId }, actorId: { type: Schema.Types.ObjectId, required: true }, shiftId: { type: Schema.Types.ObjectId }, drawerCode: String, drawerOwnerId: { type: Schema.Types.ObjectId },
  kind: { type: String, enum: ["supplier_credit", "supplier_payment", "supplier_refund", "customer_refund", "cash_in", "cash_out"], required: true },
  domain: { type: String, enum: ["pharmacy", "billing"], required: true, default: "pharmacy" },
  direction: { type: String, enum: ["in", "out", "none"], required: true }, amountPaise: { ...whole, min: 1 },
  currency: { type: String, enum: ["INR", "USD", "CAD", "GBP", "AED", "EUR"], required: true }, paymentMethod: { type: String, enum: ["none", "cash", "upi", "card", "bank"], required: true },
  referenceNumber: { type: String, required: true }, normalizedReference: { type: String, required: true }, financialYear: { type: String, required: true }, sourceDate: String,
  reviewReference: { type: String, required: true }, evidenceMode: { type: String, enum: ["staff_confirmed_manual"], required: true }, operationKey: { type: String, required: true },
  recordedAt: { type: Date, required: true, immutable: true },
  allocations: { type: [new Schema({ purchaseId: { type: Schema.Types.ObjectId }, purchaseReturnId: { type: Schema.Types.ObjectId }, openingBalanceId: { type: Schema.Types.ObjectId }, invoiceId: { type: Schema.Types.ObjectId }, amountPaise: { ...whole, min: 1 } }, { _id: false })], required: true },
});
schema.index({ organizationId: 1, locationId: 1, operationKey: 1 }, { unique: true });
schema.index({ organizationId: 1, kind: 1, partyId: 1, financialYear: 1, normalizedReference: 1 }, { unique: true });
schema.index({ organizationId: 1, locationId: 1, partyId: 1, recordedAt: 1 });
schema.index({ organizationId: 1, locationId: 1, "allocations.purchaseId": 1 });
schema.index({ organizationId: 1, locationId: 1, "allocations.openingBalanceId": 1 });
schema.index({ organizationId: 1, locationId: 1, invoiceId: 1 });
schema.pre("validate", function () {
  const movement = ["cash_in", "cash_out"].includes(this.kind), direction = this.kind === "supplier_credit" ? "none" : ["supplier_refund", "cash_in"].includes(this.kind) ? "in" : "out";
  const ids = this.allocations.map(row => row.openingBalanceId ? `opening:${row.openingBalanceId}` : String(this.kind === "supplier_credit" ? row.purchaseReturnId : this.kind === "customer_refund" ? row.invoiceId : row.purchaseId));
  if (this.domain === "billing" && !movement || this.direction !== direction || (this.kind === "supplier_credit") !== (this.paymentMethod === "none") ||
      (movement ? this.allocations.length !== 0 || this.paymentMethod !== "cash" : !this.allocations.length) || this.allocations.length > 100 || new Set(ids).size !== ids.length || ids.includes("undefined") ||
      this.allocations.some(row => row.openingBalanceId && (row.purchaseId || row.purchaseReturnId || row.invoiceId)) ||
      !movement && this.allocations.reduce((sum, row) => sum + BigInt(row.amountPaise), 0n) !== BigInt(this.amountPaise) ||
      this.kind === "customer_refund" && (this.allocations.length !== 1 || !this.invoiceId || String(this.allocations[0].invoiceId) !== String(this.invoiceId)) ||
      !["customer_refund", "cash_in", "cash_out"].includes(this.kind) && !this.partyId ||
      this.kind !== "supplier_credit" && (!this.shiftId || !this.drawerCode || !this.drawerOwnerId)) throw new Error("Cash/document event allocation does not reconcile");
});
schema.pre("save", function () { if (!this.isNew) throw new Error("Pharmacy cash events are append-only"); });
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) schema.pre(op, function () { throw new Error("Pharmacy cash events are append-only"); });
schema.pre("bulkWrite", function () { throw new Error("Pharmacy cash events are append-only"); });
schema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Pharmacy cash events are append-only"); });
export const PharmacyCashEvent = mongoose.model("PharmacyCashEvent", schema);
