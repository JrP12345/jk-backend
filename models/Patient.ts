import mongoose, { Schema } from "mongoose";
import { getNextAtomicSequence } from "./Counter.ts";
import { tenantPlugin } from "../utilities/tenantPlugin.ts";
import { encryptField, decryptField } from "../utilities/cryptoEnvelope.ts";

const PatientSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", unique: true, sparse: true, index: true },
  name: { type: String, trim: true, index: true },
  phone: { type: String, trim: true, index: true },
  email: { type: String, trim: true, index: true },
  accountType: { type: String, enum: ["self", "dependent", "walkin"], default: "self" },
  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
  personalVaultId: { type: String, unique: true, sparse: true, index: true },
  abdmHealthId: { type: String, sparse: true },
  abhaNumber: { type: String, sparse: true, index: true },
  abhaAddress: { type: String, sparse: true, index: true },
  abhaStatus: { type: String, enum: ["unverified", "verified", "active", "deactivated"], default: "unverified" },
  abhaLinkedAt: { type: Date },
  abhaVerificationMethod: { type: String, enum: ["aadhaar_otp", "mobile_otp", "scan_and_share", "manual"] },
  dob: { type: Date },
  gender: { type: String, enum: ["male", "female", "other"] },
  bloodGroup: { type: String, enum: ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"] },
  address: { type: String },
  city: { type: String, trim: true, index: true },
  state: { type: String, trim: true },
  pincode: { type: String, trim: true },
  nationality: { type: String, trim: true, default: "Indian" },
  allergies: [{ type: String }],
  conditions: [{ type: String }],
  medicalNotes: {
    type: String,
    get: decryptField,
    set: encryptField,
  },

  emergencyContacts: [
    {
      name: { type: String, required: true },
      relationship: { type: String, required: true },
      phone: { type: String, required: true },
    },
  ],

  insurancePolicies: [
    {
      providerName: { type: String, required: true },
      policyNumber: { type: String, required: true },
      coverageAmount: { type: Number },
      validUntil: { type: Date },
    },
  ],

  mrn: { type: String, unique: true, sparse: true, index: true },
  globalPatientId: { type: String, unique: true, sparse: true, index: true },
  activeConsentGrants: [{ type: Schema.Types.ObjectId, ref: "Consent" }],
  optOutWhatsApp: { type: Boolean, default: false, index: true },

  // ABDM Milestone 3 (M3) HIP Care Contexts & HIU Consent
  careContexts: [
    {
      careContextReference: { type: String, required: true },
      display: { type: String, required: true },
      appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment" },
      hipId: { type: String },
      linkedAt: { type: Date, default: Date.now },
    }
  ],
  abdmConsentRequests: [
    {
      consentRequestId: { type: String, required: true },
      status: { type: String, enum: ["REQUESTED", "GRANTED", "DENIED", "EXPIRED"], default: "REQUESTED" },
      purpose: { type: String, default: "CAREMGT" },
      hiTypes: [{ type: String }],
      dateFrom: { type: Date },
      dateTo: { type: Date },
      requestedAt: { type: Date, default: Date.now },
      grantedAt: { type: Date },
    }
  ],

  // DPDP 2023 Compliance & NMC Legal Retention Fields
  dpdpStatus: {
    type: String,
    enum: ["ACTIVE", "ERASURE_REQUESTED", "ANONYMIZED"],
    default: "ACTIVE",
    index: true,
  },
  anonymizedAt: { type: Date },
  legalRetentionHoldUntil: { type: Date, index: true },
  erasureRequestedAt: { type: Date },
  erasureReason: { type: String },
}, { timestamps: true });

PatientSchema.index({ organizationId: 1, createdAt: -1 });
PatientSchema.index({ organizationId: 1, phone: 1 });

PatientSchema.pre("save", async function () {
  if (!this.globalPatientId) {
    const year = new Date().getFullYear();
    const seq = await getNextAtomicSequence(`gpid_${year}`);
    this.globalPatientId = `UPI-${year}-${String(seq).padStart(7, "0")}`;
  }
  if (!this.mrn) {
    const year = new Date().getFullYear();
    const orgPart = this.organizationId ? this.organizationId.toString() : "GLOBAL";
    const seq = await getNextAtomicSequence(`mrn_${orgPart}_${year}`);
    const orgSuffix = this.organizationId ? this.organizationId.toString().slice(-4).toUpperCase() : "GEN";
    this.mrn = `MRN-${year}-${orgSuffix}-${String(seq).padStart(6, "0")}`;
  }
});

// Apply automatic multi-tenant scoping
PatientSchema.plugin(tenantPlugin);

PatientSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

PatientSchema.set("toJSON", {
  virtuals: true,
  getters: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

PatientSchema.set("toObject", {
  virtuals: true,
  getters: true,
});

export const Patient = mongoose.models.Patient || mongoose.model("Patient", PatientSchema);
