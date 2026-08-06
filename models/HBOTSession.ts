import mongoose, { Schema } from "mongoose";

const HBOTSessionSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    chamberId: { type: String, required: true, default: "HBOT-CHAMBER-BAY-01", index: true },
    patientName: { type: String, required: true, index: true },
    indication: {
      type: String,
      enum: ["diabetic_foot_ulcer", "decompression_sickness", "radiation_tissue_necrosis", "carbon_monoxide_poisoning", "chronic_osteomyelitis"],
      required: true,
      index: true,
    },
    pressureATA: { type: Number, default: 2.4 }, // Atmospheres Absolute (e.g. 2.0, 2.4, 2.8 ATA)
    sessionDurationMinutes: { type: Number, default: 90 },
    barotraumaSafetyCleared: { type: Boolean, default: true, index: true },
    sessionStatus: {
      type: String,
      enum: ["scheduled", "compressing", "at_depth_treatment", "decompressing", "completed", "aborted"],
      default: "scheduled",
      index: true,
    },
    supervisingPhysician: { type: String, required: true, trim: true },
    chamberOperator: { type: String, required: true, trim: true },
    notes: { type: String, default: "" },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

HBOTSessionSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

HBOTSessionSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const HBOTSession = mongoose.model("HBOTSession", HBOTSessionSchema);
