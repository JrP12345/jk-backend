import mongoose, { Schema } from "mongoose";
import { tenantPlugin } from "../utilities/tenantPlugin.ts";
import { encryptField, decryptField } from "../utilities/cryptoEnvelope.ts";

const StructuredDiagnosisSchema = new Schema({
  code: { type: String, required: true },
  codingSystem: { type: String, enum: ["ICD-10", "SNOMED", "CUSTOM"], default: "ICD-10" },
  description: { type: String, required: true },
  status: { type: String, enum: ["active", "resolved", "ruled_out"], default: "active" },
});

const ClinicalNoteSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  encounterId: { type: Schema.Types.ObjectId, ref: "Encounter", required: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

  version: { type: Number, default: 1, required: true },
  parentNoteId: { type: Schema.Types.ObjectId, ref: "ClinicalNote", default: null },
  isLatest: { type: Boolean, default: true, index: true },

  subjective: {
    chiefComplaint: { type: String, required: true },
    historyOfPresentIllness: {
      type: String,
      default: "",
      get: decryptField,
      set: encryptField,
    },
    symptoms: [{ type: String }],
  },
  objective: {
    observationIds: [{ type: Schema.Types.ObjectId, ref: "Observation" }],
    physicalExamination: { type: String, default: "" },
  },
  assessment: {
    diagnoses: [StructuredDiagnosisSchema],
    severity: { type: String, enum: ["mild", "moderate", "acute", "severe"], default: "moderate" },
  },
  plan: {
    treatmentPlan: {
      type: String,
      default: "",
      get: decryptField,
      set: encryptField,
    },
    prescriptionIds: [{ type: Schema.Types.ObjectId, ref: "Prescription" }],
    labOrderIds: [{ type: Schema.Types.ObjectId, ref: "LabOrder" }],
    followUpDate: { type: Date },
    followUpInstructions: { type: String, default: "" },
  },

  status: {
    type: String,
    enum: ["draft", "under_review", "signed", "amended", "entered_in_error"],
    default: "draft",
    index: true,
  },

  signature: {
    signerId: { type: Schema.Types.ObjectId, ref: "User" },
    signerName: { type: String },
    signedAt: { type: Date },
    signingMethod: { type: String, default: "RS256_JWT" },
  },

  amendmentReason: { type: String, default: "" },
  deletedAt: { type: Date, default: null, index: true },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

ClinicalNoteSchema.index({ organizationId: 1, patientId: 1, isLatest: 1 });
ClinicalNoteSchema.index({ encounterId: 1, version: -1 });

// Apply automatic multi-tenant scoping
ClinicalNoteSchema.plugin(tenantPlugin);

ClinicalNoteSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

ClinicalNoteSchema.set("toJSON", {
  virtuals: true,
  getters: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

ClinicalNoteSchema.set("toObject", {
  virtuals: true,
  getters: true,
});

export const ClinicalNote =
  mongoose.models.ClinicalNote || mongoose.model("ClinicalNote", ClinicalNoteSchema);
