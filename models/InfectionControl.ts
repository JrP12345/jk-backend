import mongoose, { Schema } from "mongoose";

const InfectionControlSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    patientId: { type: Schema.Types.ObjectId, ref: "Patient", index: true },
    patientName: { type: String, required: true, trim: true, index: true },
    ward: { type: String, required: true, trim: true, index: true },
    pathogenName: { type: String, required: true, index: true }, // e.g. MRSA, C. difficile, VRE, Pseudomonas
    infectionType: {
      type: String,
      enum: ["HAI_CLABSI", "HAI_CAUTI", "HAI_VAP", "HAI_SSI", "COMMUNITY_ACQUIRED", "OUTBREAK_CLUSTER"],
      default: "HAI_CLABSI",
      index: true,
    },
    isolationStatus: {
      type: String,
      enum: ["none", "contact_isolation", "droplet_isolation", "airborne_isolation", "strict_quarantine"],
      default: "contact_isolation",
      index: true,
    },
    riskLevel: {
      type: String,
      enum: ["low", "moderate", "high", "critical"],
      default: "high",
      index: true,
    },
    detectionDate: { type: Date, default: Date.now, index: true },
    reportedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["suspected", "confirmed_active", "cleared", "quarantined"],
      default: "confirmed_active",
      index: true,
    },
    antimicrobialRegimen: { type: String, default: "" },
    environmentalSanitizationDone: { type: Boolean, default: false },
    notes: { type: String, default: "" },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

InfectionControlSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

InfectionControlSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const InfectionControl = mongoose.model("InfectionControl", InfectionControlSchema);
