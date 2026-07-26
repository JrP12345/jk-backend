import mongoose, { Schema } from "mongoose";

const PatientSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
  personalVaultId: { type: String, unique: true, sparse: true, index: true },
  abdmHealthId: { type: String, sparse: true },
  dob: { type: Date },
  gender: { type: String, enum: ["male", "female", "other"] },
  bloodGroup: { type: String, enum: ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"] },
  address: { type: String },
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

  activeConsentGrants: [{ type: Schema.Types.ObjectId, ref: "Consent" }],
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
