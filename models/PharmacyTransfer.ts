import mongoose, { Schema } from "mongoose";

const id = (ref: string) => ({ type: Schema.Types.ObjectId, ref, required: true, immutable: true });
const count = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const schema = new Schema({
  organizationId: id("Organization"), sourceLocationId: id("Location"), destinationLocationId: id("Location"),
  sourceMedicineId: id("Medicine"), destinationMedicineId: id("Medicine"), sourceBatchId: id("MedicineBatch"),
  quantity: { ...count, min: 1, max: 1_000_000, immutable: true },
  sourceSnapshot: { type: Schema.Types.Mixed, required: true, immutable: true }, destinationSnapshot: { type: Schema.Types.Mixed, required: true, immutable: true },
  issuerSnapshot: { type: Schema.Types.Mixed, required: true, immutable: true },
  transportReference: { type: String, required: true, immutable: true }, reviewReference: { type: String, required: true, immutable: true },
  createdBy: id("User"), approvedBy: { type: Schema.Types.ObjectId, ref: "User" }, approvedAt: Date, dispatchedAt: Date,
  status: { type: String, enum: ["draft", "approved", "in_transit", "closed", "cancelled"], required: true, default: "draft" },
  revision: { ...count, default: 0 }, dispatchedQuantity: { ...count, default: 0 }, receivedQuantity: { ...count, default: 0 },
  quarantinedQuantity: { ...count, default: 0 }, lostQuantity: { ...count, default: 0 }, returnedQuantity: { ...count, default: 0 },
}, { timestamps: true });
schema.index({ organizationId: 1, sourceLocationId: 1, _id: -1 });
schema.index({ organizationId: 1, destinationLocationId: 1, _id: -1 });
schema.pre("validate", function () {
  const resolved = this.receivedQuantity + this.quarantinedQuantity + this.lostQuantity + this.returnedQuantity;
  if (String(this.sourceLocationId) === String(this.destinationLocationId) || this.dispatchedQuantity > this.quantity || resolved > this.dispatchedQuantity ||
      this.status === "in_transit" && (this.dispatchedQuantity !== this.quantity || resolved >= this.quantity) ||
      this.status === "closed" && (resolved !== this.quantity || this.dispatchedQuantity !== this.quantity) ||
      ["draft", "approved", "cancelled"].includes(this.status) && this.dispatchedQuantity !== 0) throw new Error("Transfer quantities do not conserve dispatched stock");
});
schema.pre("save", function () { if (!this.isNew) throw new Error("Transfer stages require conditional recorded commands"); });
schema.pre(["updateOne", "findOneAndUpdate"], function () {
  const update = this.getUpdate();
  if (!update || Array.isArray(update)) throw new Error("Transfer sources require explicit stage updates");
  const protectedFields = ["organizationId", "sourceLocationId", "destinationLocationId", "sourceMedicineId", "destinationMedicineId", "sourceBatchId", "quantity", "sourceSnapshot", "destinationSnapshot", "issuerSnapshot", "transportReference", "reviewReference", "createdBy"];
  const paths = Object.entries(update).flatMap(([key, value]) => key.startsWith("$") && value && typeof value === "object" ? Object.keys(value) : [key]);
  if (paths.some(path => protectedFields.some(field => path === field || path.startsWith(`${field}.`)))) throw new Error("Approved transfer source facts are immutable");
});
schema.pre("bulkWrite", function () { throw new Error("Transfer sources require recorded stage commands"); });
for (const operation of ["deleteOne", "deleteMany", "findOneAndDelete", "replaceOne", "findOneAndReplace", "updateMany"] as const) schema.pre(operation, function () { throw new Error("Transfer sources cannot be replaced or removed"); });
export const PharmacyTransfer = mongoose.model("PharmacyTransfer", schema);

const eventSchema = new Schema({ organizationId: id("Organization"), transferId: id("PharmacyTransfer"), locationId: id("Location"), actorId: id("User"),
  revision: count, action: { type: String, enum: ["create", "approve", "dispatch", "receive", "resolve", "cancel"], required: true },
  quantity: count, disposition: String, reviewReference: { type: String, required: true }, operationKey: { type: String, required: true },
  batchId: { type: Schema.Types.ObjectId, ref: "MedicineBatch" }, createdAt: { type: Date, default: Date.now, immutable: true },
});
eventSchema.index({ transferId: 1, revision: 1 }, { unique: true });
eventSchema.index({ organizationId: 1, transferId: 1, _id: -1 });
eventSchema.pre("save", function () { if (!this.isNew) throw new Error("Transfer events are append-only"); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) eventSchema.pre(operation, function () { throw new Error("Transfer events are append-only"); });
eventSchema.pre("bulkWrite", function () { throw new Error("Transfer events are append-only"); });
eventSchema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Transfer events are append-only"); });
export const PharmacyTransferEvent = mongoose.model("PharmacyTransferEvent", eventSchema);
