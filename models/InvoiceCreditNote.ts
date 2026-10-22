import mongoose, { Schema } from "mongoose";
import { pharmacyDocumentSchema } from "./pharmacyDocumentSchema.ts";
const whole = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true }, invoiceId: { type: Schema.Types.ObjectId, required: true }, returnId: { type: Schema.Types.ObjectId, required: true },
  creditNoteNumber: { type: String, required: true, unique: true }, sourceInvoiceNumber: { type: String, required: true }, sourceIssuedAt: { type: Date, required: true }, issuedAt: { type: Date, required: true, immutable: true },
  currency: { type: String, enum: ["INR"], required: true }, policy: { type: String, enum: ["source-credit-paise-v1"], required: true }, taxAdjustment: { type: String, enum: ["professional_review_required"], required: true },
  issuerSnapshot: { type: pharmacyDocumentSchema, required: true }, actorId: { type: Schema.Types.ObjectId, required: true }, reason: { type: String, required: true }, reviewReference: { type: String, required: true },
  baseAmountPaise: whole, cgstPaise: whole, sgstPaise: whole, grossAmountPaise: whole, payablePaise: whole, roundOffPaise: { type: Number, required: true, validate: Number.isSafeInteger },
});
schema.index({ returnId: 1 }, { unique: true });
schema.index({ organizationId: 1, locationId: 1, invoiceId: 1, _id: 1 });
schema.pre("validate", function () { if (this.baseAmountPaise + this.cgstPaise + this.sgstPaise !== this.grossAmountPaise || this.grossAmountPaise + this.roundOffPaise !== this.payablePaise) throw new Error("Credit note does not reconcile"); });
schema.pre("save", function () { if (!this.isNew) throw new Error("Credit notes are append-only"); });
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) schema.pre(op, function () { throw new Error("Credit notes are append-only"); });
schema.pre("bulkWrite", function () { throw new Error("Credit notes are append-only"); });
schema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Credit notes are append-only"); });
export const InvoiceCreditNote = mongoose.model("InvoiceCreditNote", schema);
