import mongoose, { Schema } from "mongoose";
const whole = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true }, invoiceId: { type: Schema.Types.ObjectId, required: true },
  invoiceNumber: { type: String, required: true }, creditNoteId: { type: Schema.Types.ObjectId, required: true }, actorId: { type: Schema.Types.ObjectId, required: true }, approvedBy: { type: Schema.Types.ObjectId, required: true },
  operationKey: { type: String, required: true }, revision: whole, reason: { type: String, required: true }, reviewReference: { type: String, required: true }, createdAt: { type: Date, required: true, immutable: true },
  disposition: { type: String, enum: ["quarantined"], required: true },
  lines: { type: [new Schema({ sourceLineId: { type: Schema.Types.ObjectId, required: true }, sourceBatchId: { type: Schema.Types.ObjectId, required: true }, medicineId: { type: Schema.Types.ObjectId, required: true },
    quarantineBatchId: { type: Schema.Types.ObjectId, required: true }, description: { type: String, required: true }, batchNumber: { type: String, required: true }, quantity: { ...whole, min: 1 }, condition: { type: String, enum: ["unopened", "opened", "damaged", "expired", "unknown"], required: true },
    baseAmountPaise: whole, cgstPaise: whole, sgstPaise: whole, grossAmountPaise: whole, payablePaise: whole, roundOffPaise: { type: Number, required: true, validate: Number.isSafeInteger },
  }, { _id: false })], required: true },
});
schema.index({ organizationId: 1, locationId: 1, operationKey: 1 }, { unique: true });
schema.index({ organizationId: 1, locationId: 1, invoiceId: 1, revision: 1 }, { unique: true });
schema.pre("validate", function () { if (!this.lines.length || this.lines.length > 100 || new Set(this.lines.map(line => `${line.sourceLineId}:${line.sourceBatchId}`)).size !== this.lines.length || this.lines.some(line => line.baseAmountPaise + line.cgstPaise + line.sgstPaise !== line.grossAmountPaise || line.grossAmountPaise + line.roundOffPaise !== line.payablePaise)) throw new Error("Return lines do not reconcile"); });
schema.pre("save", function () { if (!this.isNew) throw new Error("Pharmacy returns are append-only"); });
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) schema.pre(op, function () { throw new Error("Pharmacy returns are append-only"); });
schema.pre("bulkWrite", function () { throw new Error("Pharmacy returns are append-only"); });
schema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Pharmacy returns are append-only"); });
export const PharmacyReturn = mongoose.model("PharmacyReturn", schema);
