import mongoose, { Schema } from "mongoose";
import { getNextAtomicSequence } from "./Counter.ts";

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
  medicalNotes: { type: String },

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
  activeConsentGrants: [{ type: Schema.Types.ObjectId, ref: "Consent" }],
}, { timestamps: true });

PatientSchema.pre("save", async function () {
  if (!this.mrn) {
    const year = new Date().getFullYear();
    const orgPart = this.organizationId ? this.organizationId.toString() : "GLOBAL";
    const seq = await getNextAtomicSequence(`mrn_${orgPart}_${year}`);
    const orgSuffix = this.organizationId ? this.organizationId.toString().slice(-4).toUpperCase() : "GEN";
    this.mrn = `MRN-${year}-${orgSuffix}-${String(seq).padStart(6, "0")}`;
  }
});

PatientSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

PatientSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const Patient = mongoose.model("Patient", PatientSchema);
