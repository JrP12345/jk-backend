import mongoose, { Schema } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";
import { genuineDetail } from "../utilities/pharmacyEvidence.ts";

export interface IScheduleH1Register {
  recordVersion?: number;
  dispenseId?: mongoose.Types.ObjectId;
  batchId?: mongoose.Types.ObjectId;
  batchKey?: string;
  clinicalNoteId?: mongoose.Types.ObjectId;
  doctorAddress?: string;
  doctorCouncil?: string;
  doctorReviewReference?: string;
  doctorReviewRevision?: number;
  pharmacistRegNumber?: string;
  pharmacistCouncil?: string;
  pharmacistReviewReference?: string;
  pharmacistReviewRevision?: number;
  classificationReviewReference?: string;
  manufacturer?: string;
  signatureMode?: string;
  organizationId: mongoose.Types.ObjectId;
  locationId: mongoose.Types.ObjectId;
  medicineId: mongoose.Types.ObjectId;
  medicineName: string;
  genericName?: string;
  scheduleType: "schedule_h" | "schedule_h1" | "schedule_x" | "narcotic";
  batchNumber: string;
  expiryDate?: Date;
  quantityDispensed: number;
  patientId: mongoose.Types.ObjectId;
  patientName: string;
  patientAddress?: string;
  patientPhone?: string;
  doctorId?: mongoose.Types.ObjectId;
  doctorName?: string;
  doctorRegNumber?: string;
  prescriptionId?: mongoose.Types.ObjectId;
  encounterId?: mongoose.Types.ObjectId;
  invoiceId?: mongoose.Types.ObjectId;
  dispensedBy?: mongoose.Types.ObjectId;
  dispensedByName?: string;
  dispensedAt: Date;
  createdAt: Date;
}

const ScheduleH1RegisterSchema = new Schema<IScheduleH1Register>(
  {
    recordVersion: { type: Number, enum: [1] },
    dispenseId: { type: Schema.Types.ObjectId, ref: "PharmacyDispense" },
    batchId: { type: Schema.Types.ObjectId, ref: "MedicineBatch" }, batchKey: String,
    clinicalNoteId: { type: Schema.Types.ObjectId, ref: "ClinicalNote" },
    doctorAddress: String, doctorCouncil: String, doctorReviewReference: String, doctorReviewRevision: Number,
    pharmacistRegNumber: String, pharmacistCouncil: String, pharmacistReviewReference: String, pharmacistReviewRevision: Number,
    classificationReviewReference: String, manufacturer: String, signatureMode: String,
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    locationId: { type: Schema.Types.ObjectId, ref: "Location", required: true, index: true },
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true, index: true },
    medicineName: { type: String, required: true, trim: true },
    genericName: { type: String, trim: true },
    scheduleType: {
      type: String,
      enum: ["schedule_h", "schedule_h1", "schedule_x", "narcotic"],
      required: true,
      index: true,
    },
    batchNumber: { type: String, required: true, trim: true },
    expiryDate: { type: Date },
    quantityDispensed: { type: Number, required: true, min: 1 },
    patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
    patientName: { type: String, required: true, trim: true },
    patientAddress: { type: String, trim: true },
    patientPhone: { type: String, trim: true },
    doctorId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    doctorName: { type: String, trim: true },
    doctorRegNumber: { type: String, trim: true },
    prescriptionId: { type: Schema.Types.ObjectId, ref: "Prescription" },
    encounterId: { type: Schema.Types.ObjectId, ref: "Encounter" },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice" },
    dispensedBy: { type: Schema.Types.ObjectId, ref: "User" },
    dispensedByName: { type: String, trim: true },
    dispensedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

ScheduleH1RegisterSchema.index({ locationId: 1, dispensedAt: -1 });
ScheduleH1RegisterSchema.index({ locationId: 1, scheduleType: 1 });
ScheduleH1RegisterSchema.index({ dispenseId: 1, medicineId: 1, batchKey: 1, prescriptionId: 1 }, { unique: true, partialFilterExpression: { recordVersion: 1 } });
ScheduleH1RegisterSchema.pre("validate", function () {
  if (!this.isNew) return;
  const fields = [this.patientName, this.patientAddress, this.doctorName, this.doctorAddress, this.doctorRegNumber,
    this.doctorCouncil, this.dispensedByName, this.pharmacistRegNumber, this.pharmacistCouncil, this.pharmacistReviewReference, this.doctorReviewReference, this.classificationReviewReference, this.batchNumber];
  if (this.recordVersion !== 1 || !["schedule_h", "schedule_h1"].includes(this.scheduleType) || !Number.isSafeInteger(this.quantityDispensed) ||
      !this.dispenseId || !this.invoiceId || !this.prescriptionId || !this.encounterId || !this.clinicalNoteId || !this.doctorId || !this.dispensedBy || !this.expiryDate || !this.batchKey ||
      ![this.doctorReviewRevision, this.pharmacistReviewRevision].every(value => Number.isSafeInteger(value) && value! > 0) ||
      this.signatureMode !== "reviewed_electronic_record" || fields.some(value => !genuineDetail(value))) throw new Error("Complete captured restricted-supply evidence is required");
});
ScheduleH1RegisterSchema.pre("save", function () { if (!this.isNew) throw new Error("Register entries are append-only"); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  ScheduleH1RegisterSchema.pre(operation, function () { throw new Error("Register entries are append-only"); });
}
ScheduleH1RegisterSchema.pre("bulkWrite", function () { throw new Error("Register entries are append-only"); });
ScheduleH1RegisterSchema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Register entries are append-only"); });

ScheduleH1RegisterSchema.plugin(auditPlugin);

export const ScheduleH1Register = mongoose.model<IScheduleH1Register>(
  "ScheduleH1Register",
  ScheduleH1RegisterSchema
);
