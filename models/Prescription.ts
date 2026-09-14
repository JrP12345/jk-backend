import mongoose, { Schema } from "mongoose";
import { tenantPlugin } from "../utilities/tenantPlugin.ts";

const PrescriptionSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  encounterId: { type: Schema.Types.ObjectId, ref: "Encounter", required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

  medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", index: true },
  medicineName: { type: String, required: true },
  genericName: { type: String, trim: true },
  dosage: { type: String, required: true },       // e.g. "500mg"
  frequency: { type: String, required: true },    // e.g. "1-0-1"
  duration: { type: String, required: true },     // e.g. "5 days"
  instructions: { type: String, default: "" },   // e.g. "Take after food"

  // NMC RMP Regulations (2023) Compliance Fields
  doctorRegistrationNumber: { type: String, trim: true },
  doctorCouncil: { type: String, trim: true },
  diagnosisCode: { type: String, trim: true }, // ICD-10
  diagnosisDescription: { type: String, trim: true },

  // Medico-Legal Cryptographic Sealing & Immutability
  prescriptionHash: { type: String, index: true },
  digitalSignature: { type: String },
  isSealed: { type: Boolean, default: false, index: true },
  sealedAt: { type: Date },

  status: { type: String, enum: ["active", "dispensed", "discontinued"], default: "active", index: true },
  deletedAt: { type: Date, default: null, index: true },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

PrescriptionSchema.index({ patientId: 1, createdAt: -1 });
PrescriptionSchema.index({ clinicId: 1, status: 1 });

// Apply automatic multi-tenant scoping
PrescriptionSchema.plugin(tenantPlugin);

// Immutability guard: once a prescription is sealed, core medical details cannot be tampered with
PrescriptionSchema.pre("save", function () {
  if (!this.isNew && this.isModified() && this.isSealed) {
    const modifiedPaths = this.modifiedPaths();
    const allowedSealingPaths = [
      "isSealed",
      "sealedAt",
      "prescriptionHash",
      "digitalSignature",
      "doctorRegistrationNumber",
      "doctorCouncil",
      "status",
      "updatedAt",
    ];
    const illegalModifications = modifiedPaths.filter((p) => !allowedSealingPaths.includes(p));
    if (illegalModifications.length > 0) {
      throw new Error(
        `Prescription is cryptographically sealed and immutable under NMC regulations. Cannot modify: ${illegalModifications.join(
          ", "
        )}`
      );
    }
  }
});

PrescriptionSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

PrescriptionSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const Prescription =
  mongoose.models.Prescription || mongoose.model("Prescription", PrescriptionSchema);
