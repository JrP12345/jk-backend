import mongoose, { Schema } from "mongoose";

const PrescriptionSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  encounterId: { type: Schema.Types.ObjectId, ref: "Encounter", required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

  medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", index: true },
  medicineName: { type: String, required: true },
  dosage: { type: String, required: true },       // e.g. "500mg"
  frequency: { type: String, required: true },    // e.g. "1-0-1"
  duration: { type: String, required: true },     // e.g. "5 days"
  instructions: { type: String, default: "" },   // e.g. "Take after food"

  status: { type: String, enum: ["active", "dispensed", "discontinued"], default: "active", index: true },
  deletedAt: { type: Date, default: null, index: true },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

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

export const Prescription = mongoose.model("Prescription", PrescriptionSchema);
