import mongoose, { Schema } from "mongoose";
import { pharmacyTaxAmounts } from "./pharmacyDocumentSchema.ts";

const quantity = { type: Number, required: true, min: 1, validate: Number.isSafeInteger };
const money = { type: Number, required: true, min: 0, validate: Number.isFinite };
const line = new Schema({
  ...pharmacyTaxAmounts,
  taxTreatment: String,
  unitCode: String,
  taxReviewReference: String,
  calculationLineId: String,
  unitSnapshot: { version: Number, baseUnit: String, packUnit: String, unitsPerPack: Number },
  pricingAllocations: [new Schema({ batchId: { type: Schema.Types.ObjectId, ref: "MedicineBatch" }, batchNumber: String,
    expiryDate: Date, expiryPrecision: String, expiryValue: String, mrpPaise: Number, quantity, unitPrice: money, hsnCode: String, gstRate: Number }, { _id: false })],
  medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true },
  description: { type: String, required: true },
  quantity,
  amount: money,
  lineAmount: money,
  hsnSacCode: { type: String, required: true },
  gstRate: { type: Number, default: 0 },
  prescriptions: { type: [new Schema({
    prescriptionId: { type: Schema.Types.ObjectId, ref: "Prescription", required: true },
    quantity,
  }, { _id: false })], required: true },
  batches: [new Schema({
    batchId: { type: Schema.Types.ObjectId, ref: "MedicineBatch", required: true },
    batchNumber: { type: String, required: true },
    quantity,
  }, { _id: false })],
});
const schema = new Schema({
  kind: { type: String, enum: ["clinical", "pharmacy"], default: "clinical", required: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  locationId: { type: Schema.Types.ObjectId, ref: "Location", required: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: function (this: { kind?: string }): boolean { return this.kind !== "pharmacy"; } },
  doctorId: { type: Schema.Types.ObjectId, ref: "User", required: function (this: { kind?: string }): boolean { return this.kind !== "pharmacy"; } },
  encounterId: { type: Schema.Types.ObjectId, ref: "Encounter", required: function (this: { kind?: string }): boolean { return this.kind !== "pharmacy"; } },
  appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment" },
  clinicalNoteId: { type: Schema.Types.ObjectId, ref: "ClinicalNote" },
  focusedCompletionAuditId: { type: Schema.Types.ObjectId, ref: "AuditLog" },
  prescriptionIds: { type: [Schema.Types.ObjectId], required: true },
  fulfillmentClaims: { type: [String], default: undefined },
  prescriptionProgress: { type: [new Schema({ prescriptionId: { type: Schema.Types.ObjectId, required: true },
    mode: { type: String, enum: ["quantity", "single"], required: true }, authorizedQuantity: Number, baseUnit: String,
    suppliedQuantity: { type: Number, required: true }, suppliedNow: quantity, suppliedAfter: { type: Number, required: true },
    remainingAfter: { type: Number, required: true }, revision: { type: Number, required: true }, revisionAfter: { type: Number, required: true },
    completed: { type: Boolean, required: true }, authorizationBasis: { type: String, required: true },
  }, { _id: false })], default: undefined },
  invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true },
  actorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  operationKey: { type: String, required: true },
  lines: { type: [line], required: true },
  createdAt: { type: Date, default: Date.now, immutable: true },
});
schema.index({ organizationId: 1, locationId: 1, operationKey: 1 }, { unique: true });
// A source revision can be consumed once; the source CAS caps the cumulative allowance.
schema.index({ fulfillmentClaims: 1 }, { unique: true, partialFilterExpression: { kind: "clinical" } });
schema.index({ organizationId: 1, locationId: 1, encounterId: 1 });
schema.pre("validate", function () {
  const selected = this.prescriptionIds.map(String).sort();
  const mapped = this.lines.flatMap(item => item.prescriptions.map(rx => String(rx.prescriptionId))).sort();
  const retail = this.kind === "pharmacy";
  const progress = this.prescriptionProgress || [];
  if (progress.length && (progress.length !== selected.length || new Set(progress.map(row => String(row.prescriptionId))).size !== selected.length || progress.some(row => {
    const supplied = this.lines.flatMap(item => item.prescriptions).find(item => String(item.prescriptionId) === String(row.prescriptionId));
    return !supplied || supplied.quantity !== row.suppliedNow || ![row.suppliedQuantity, row.suppliedNow, row.suppliedAfter, row.remainingAfter, row.revision, row.revisionAfter].every(Number.isSafeInteger) ||
      row.suppliedQuantity < 0 || row.remainingAfter < 0 || row.revision < 0 || row.revisionAfter !== row.revision + 1 || row.suppliedAfter !== row.suppliedQuantity + row.suppliedNow ||
      (row.mode === "quantity" && (!Number.isSafeInteger(row.authorizedQuantity) || row.authorizedQuantity! !== row.suppliedAfter + row.remainingAfter || row.completed !== (row.remainingAfter === 0))) ||
      (row.mode === "single" && (row.suppliedQuantity !== 0 || !row.completed || row.remainingAfter !== 0));
  }))) throw new Error("Prescription fulfillment snapshots do not reconcile");
  this.fulfillmentClaims = retail ? [] : this.prescriptionIds.map(id => `${id}:${progress.find(row => String(row.prescriptionId) === String(id))?.revisionAfter ?? 1}`);
  if ((retail ? Boolean(this.patientId || this.doctorId || this.encounterId || this.appointmentId || this.clinicalNoteId || this.focusedCompletionAuditId || selected.length || mapped.length) : (!this.clinicalNoteId && !this.focusedCompletionAuditId) || !selected.length) || !this.lines.length || new Set(selected).size !== selected.length ||
      JSON.stringify(selected) !== JSON.stringify(mapped) || this.lines.some(item =>
        (!retail && item.prescriptions.reduce((sum, rx) => sum + rx.quantity, 0) !== item.quantity) ||
        (retail && (!item.calculationLineId || !item.unitSnapshot || !item.batches.length)) ||
        (item.batches.length > 0 && item.batches.reduce((sum, batch) => sum + batch.quantity, 0) !== item.quantity) ||
        Math.abs(item.amount * item.quantity - (item.baseAmountPaise != null ? item.baseAmountPaise / 100 : item.lineAmount)) > 0.000001 ||
        (item.grossAmountPaise !== undefined && (item.baseAmountPaise! + item.cgstPaise! + item.sgstPaise! !== item.grossAmountPaise || item.lineAmount !== item.grossAmountPaise / 100)))) {
    throw new Error("Dispense source quantities and amounts do not reconcile");
  }
});
schema.pre("save", function () { if (!this.isNew) throw new Error("Dispense sources are append-only"); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  schema.pre(operation, function () { throw new Error("Dispense sources are append-only"); });
}
schema.pre("bulkWrite", function () { throw new Error("Dispense sources are append-only"); });
schema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Dispense sources are append-only"); });
export const PharmacyDispense = mongoose.model("PharmacyDispense", schema);
