import mongoose, { Schema } from "mongoose";
import { pharmacyPartySnapshotSchema } from "./PharmacyParty.ts";
import { pharmacyCalculationSchema } from "./pharmacyCalculationSchema.ts";
const integer = { type: Number, min: 0, validate: Number.isSafeInteger, required: true };
const line = new Schema({
  lineId: { type: String, required: true }, medicineId: { type: Schema.Types.ObjectId, required: true },
  medicineSnapshot: { name: String, genericName: String, strength: String },
  unitSnapshot: { version: Number, baseUnit: String, packUnit: String, unitsPerPack: Number },
  packs: integer, looseUnits: integer, freePacks: integer, freeLooseUnits: integer, billedBaseUnits: integer, freeBaseUnits: integer,
  baseAmountPaise: integer, discountPaise: integer, gstRateBps: integer, hsnCode: { type: String, required: true },
  sellingPricePaise: integer, mrpPaise: { type: Number, min: 0, validate: Number.isSafeInteger },
}, { _id: false });
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true },
  supplierId: { type: Schema.Types.ObjectId, required: true }, supplierSnapshot: { type: pharmacyPartySnapshotSchema, required: true },
  supplierInvoiceNumber: { type: String, required: true }, normalizedInvoiceNumber: { type: String, required: true },
  invoiceDate: { type: String, required: true }, invoiceFY: { type: String, required: true }, currency: { type: String, enum: ["INR"], required: true },
  statedTotalPaise: integer, lines: { type: [line], required: true }, notes: { type: String, default: "" },
  calculation: { type: pharmacyCalculationSchema },
  status: { type: String, enum: ["draft", "posted"], default: "draft", required: true }, revision: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  posting: { type: new Schema({ postedAt: { type: Date, required: true }, postedBy: { type: Schema.Types.ObjectId, required: true },
    reviewReference: { type: String, required: true }, supplierRevision: integer, profileRevision: integer,
    supplierStateCode: { type: String, required: true }, recipientStateCode: { type: String, required: true },
    costTreatment: { type: String, enum: ["exclude_tax", "include_tax"], required: true },
    calculation: { type: pharmacyCalculationSchema, required: true }, payablePaise: integer,
  }, { _id: false }), default: undefined },
  receiptCount: { type: Number, default: 0, min: 0, max: 100, validate: Number.isSafeInteger },
  settlementRevision: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  receiptProgress: { type: [new Schema({ lineId: { type: String, required: true }, billedBaseUnits: integer, freeBaseUnits: integer, costPaise: integer }, { _id: false })], default: undefined },
  createdBy: { type: Schema.Types.ObjectId, required: true }, updatedBy: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });
// One source bill across branches. Later partial receipts must share this document.
schema.index({ organizationId: 1, supplierId: 1, invoiceFY: 1, normalizedInvoiceNumber: 1 }, { unique: true });
schema.index({ organizationId: 1, locationId: 1, _id: 1 });
const financial = ["organizationId", "locationId", "supplierId", "supplierSnapshot", "supplierInvoiceNumber", "normalizedInvoiceNumber", "invoiceDate", "invoiceFY", "currency", "statedTotalPaise", "lines", "notes", "calculation", "status", "posting", "createdBy"];
schema.pre("save", async function () {
  if (!this.isNew && financial.some(field => this.isModified(field)) && await mongoose.model("PharmacyPurchase").exists({ _id: this._id, status: "posted" }).session(this.$session())) throw new Error("Posted purchase financial facts are immutable");
});
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "findOneAndDelete"] as const) schema.pre(operation, async function () {
  const update = this.getUpdate() as Record<string, any> | null;
  const changesFinance = !update || Array.isArray(update) || Object.entries(update).some(([operator, fields]) => !operator.startsWith("$") || Object.keys(fields || {}).some(path => financial.includes(path.split(".")[0])) || operator === "$rename" && Object.values(fields || {}).some(path => typeof path === "string" && financial.includes(path.split(".")[0])));
  if (changesFinance && await this.model.exists({ ...this.getQuery(), status: "posted" }).session(this.getOptions().session ?? null)) throw new Error("Posted purchase financial facts are immutable");
});
for (const operation of ["replaceOne", "findOneAndReplace"] as const) schema.pre(operation, function () { throw new Error("Replace/bulk operations cannot rewrite purchase history"); });
schema.pre("bulkWrite", function () { throw new Error("Bulk operations cannot rewrite purchase history"); });
schema.pre("deleteOne", { document: true, query: false }, async function () { if (await mongoose.model("PharmacyPurchase").exists({ _id: this._id, status: "posted" }).session(this.$session())) throw new Error("Posted purchase financial facts are immutable"); });
export const PharmacyPurchase = mongoose.model("PharmacyPurchase", schema);
