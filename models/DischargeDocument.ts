import mongoose, { Schema } from "mongoose";

/**
 * DischargeDocument — the aggregated clinical summary for an Encounter.
 *
 * Lifecycle:
 *   draft → finalized → countersigned (optional)
 *
 * `aggregated`: Machine-assembled snapshot across notes, obs, scores, prescriptions, MAR, and orders.
 * `clinicianInput`: Clinician-authored narrative required before finalization.
 * `snapshotHash`: SHA-256 cryptographic fingerprint of the finalized summary for legal audit.
 */
const DischargeDocumentSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  clinicId:       { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  encounterId:    { type: Schema.Types.ObjectId, ref: "Encounter", required: true, index: true, unique: true },
  patientId:      { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  authoredBy:     { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

  status: {
    type: String,
    enum: ["draft", "finalized", "countersigned"],
    default: "draft",
    index: true,
  },

  compiledAt:       { type: Date, default: Date.now },
  finalizedAt:      { type: Date, default: null },
  countersignedBy:  { type: Schema.Types.ObjectId, ref: "User", default: null },
  countersignedAt:  { type: Date, default: null },

  // SHA-256 cryptographic fingerprint of aggregated + clinicianInput at finalization
  snapshotHash:     { type: String, default: "" },

  // ─── Machine-assembled snapshot (from 6 engines) ─────────────────
  aggregated: {
    encounterSummary: {
      encounterType: { type: String, default: "" },
      startedAt:     { type: Date, default: null },
      endedAt:       { type: Date, default: null },
      stayDurationDays: { type: Number, default: 0 },
    },
    diagnoses: [{
      code: { type: String },
      description: { type: String },
      codingSystem: { type: String },
      status: { type: String },
    }],
    vitalsOnAdmission: {
      recordedAt: { type: Date },
      vitals: { type: Schema.Types.Mixed },
    },
    vitalsOnDischarge: {
      recordedAt: { type: Date },
      vitals: { type: Schema.Types.Mixed },
    },
    news2Summary: {
      peakScore: { type: Number, default: 0 },
      finalScore: { type: Number, default: 0 },
      alertLevel: { type: String, default: "LOW" },
    },
    medications: [{
      medicineName: { type: String },
      dosage: { type: String },
      frequency: { type: String },
      instructions: { type: String },
      status: { type: String },
      administrationSummary: { type: String },
    }],
    labResults: [{
      testName: { type: String },
      testCode: { type: String },
      value: { type: String },
      unit: { type: String },
      referenceRange: { type: String },
      interpretation: { type: String },
      isAbnormal: { type: Boolean, default: false },
    }],
    procedures: [{ type: String }],
  },

  // ─── Clinician-authored narrative ───────────────────────────────
  clinicianInput: {
    primaryDiagnosis:       { type: String, default: "" },
    conditionOnDischarge:   { type: String, default: "" },
    dischargeInstructions:  { type: String, default: "" },
    followUpPlan:           { type: String, default: "" },
    medicationsOnDischarge: { type: String, default: "" },
    restrictions:           { type: String, default: "" },
  },

  createdAt: { type: Date, default: Date.now },
});

DischargeDocumentSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

DischargeDocumentSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const DischargeDocument = mongoose.model("DischargeDocument", DischargeDocumentSchema);
