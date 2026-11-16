import mongoose, { Schema } from "mongoose";

// Original prescription evidence is encrypted and immutable. Supplies only advance
// this branch's reviewed allowance; a return never grants another prescription fill.
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  locationId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  sourceKey: { type: String, required: true, immutable: true },
  evidenceCiphertext: { type: String, required: true, select: false, immutable: true },
  reviewedBy: { type: Schema.Types.ObjectId, required: true, immutable: true },
  reviewedAt: { type: Date, required: true, immutable: true },
  validUntil: { type: Date, required: true, immutable: true },
  revision: { type: Number, default: 0, required: true },
  status: { type: String, enum: ["approved", "completed", "cancelled"], default: "approved", required: true },
  supplies: [{ _id: false, invoiceId: { type: Schema.Types.ObjectId, required: true }, invoiceNumber: { type: String, required: true }, dispenseId: { type: Schema.Types.ObjectId, required: true },
    suppliedAt: { type: Date, required: true }, suppliedBy: { type: Schema.Types.ObjectId, required: true },
    lines: [{ _id: false, medicineId: { type: Schema.Types.ObjectId, required: true }, quantity: { type: Number, required: true, min: 1 } }] }],
}, { timestamps: true });
schema.index({ organizationId: 1, locationId: 1, sourceKey: 1 }, { unique: true });
schema.index({ organizationId: 1, locationId: 1, _id: -1 });
export const PharmacyExternalPrescription = mongoose.model("PharmacyExternalPrescription", schema);
