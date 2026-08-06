import mongoose, { Schema } from "mongoose";

const MortuaryEntrySchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    tagNumber: { type: String, required: true, unique: true, index: true }, // e.g. MORT-2026-9901
    deceasedName: { type: String, required: true, index: true },
    age: { type: Number, required: true },
    gender: { type: String, enum: ["male", "female", "other"], required: true },
    dateOfDeath: { type: Date, default: Date.now, index: true },
    causeOfDeath: { type: String, required: true },
    deathCertificateNumber: { type: String, default: "" },
    mortuaryCompartment: { type: String, required: true, index: true }, // e.g. Cold Bay B-04
    temperatureCelsius: { type: Number, default: -4.0 },
    autopsyRequired: { type: Boolean, default: false },
    autopsyStatus: {
      type: String,
      enum: ["not_required", "scheduled", "in_progress", "completed"],
      default: "not_required",
      index: true,
    },
    releaseStatus: {
      type: String,
      enum: ["admitted", "pending_autopsy", "pending_clearance", "released_to_kin", "transferred_to_coroner"],
      default: "admitted",
      index: true,
    },
    nextOfKinName: { type: String, default: "" },
    nextOfKinContact: { type: String, default: "" },
    releasedDate: { type: Date, default: null },
    notes: { type: String, default: "" },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

MortuaryEntrySchema.virtual("id").get(function () {
  return this._id.toHexString();
});

MortuaryEntrySchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const MortuaryEntry = mongoose.model("MortuaryEntry", MortuaryEntrySchema);
