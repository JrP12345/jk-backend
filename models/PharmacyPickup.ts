import mongoose, { Schema, type InferSchemaType } from "mongoose";

const whole = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true },
  reference: { type: String, required: true }, tokenHash: { type: String, required: true, select: false },
  customerNameCiphertext: { type: String, required: true, select: false }, phoneCiphertext: { type: String, required: true, select: false },
  phoneHash: { type: String, required: true, select: false },
  status: { type: String, enum: ["requested", "ready", "collected", "cancelled"], required: true }, revision: whole,
  items: { type: [new Schema({ medicineId: { type: Schema.Types.ObjectId, required: true }, name: { type: String, required: true }, strength: String, baseUnit: { type: String, required: true }, unitVersion: { ...whole, min: 1 }, quantity: { ...whole, min: 1, max: 1000 } }, { _id: false })], required: true, immutable: true },
  invoiceId: { type: Schema.Types.ObjectId, default: undefined }, invoiceNumber: String,
  preparedBy: { type: Schema.Types.ObjectId }, readyAt: Date, collectedBy: { type: Schema.Types.ObjectId }, collectedAt: Date, cancelledBy: { type: Schema.Types.ObjectId }, cancelledAt: Date,
  createdAt: { type: Date, required: true, immutable: true }, expiresAt: { type: Date, required: true, immutable: true },
});
schema.index({ tokenHash: 1 }, { unique: true });
schema.index({ reference: 1 }, { unique: true });
schema.index({ invoiceId: 1 }, { unique: true, partialFilterExpression: { invoiceId: { $type: "objectId" } } });
schema.index({ organizationId: 1, locationId: 1, status: 1, _id: -1 });
schema.index({ locationId: 1, phoneHash: 1, expiresAt: 1 });
schema.pre("validate", function () { if (!this.items.length || this.items.length > 25 || new Set(this.items.map(item => String(item.medicineId))).size !== this.items.length) throw Error("A pickup needs distinct requested products"); });
export type StoredPharmacyPickup = InferSchemaType<typeof schema> & { _id: mongoose.Types.ObjectId };
export const PharmacyPickup = mongoose.model("PharmacyPickup", schema);
