import mongoose, { Schema } from "mongoose";

const TransplantCaseSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    caseNumber: { type: String, required: true, unique: true, index: true }, // e.g. TXP-2026-8801
    patientName: { type: String, required: true, index: true },
    organType: {
      type: String,
      enum: ["kidney", "liver", "heart", "lung", "pancreas", "cornea"],
      default: "kidney",
      index: true,
    },
    caseRole: {
      type: String,
      enum: ["recipient_waitlist", "donor_registered"],
      default: "recipient_waitlist",
      index: true,
    },
    bloodGroup: {
      type: String,
      enum: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"],
      required: true,
      index: true,
    },
    hlaTyping: { type: String, required: true, trim: true },
    urgencyScore: { type: Number, default: 15, index: true }, // MELD / OPTN score
    matchStatus: {
      type: String,
      enum: ["seeking_match", "potential_match_found", "crossmatch_verified", "transplant_scheduled", "completed"],
      default: "seeking_match",
      index: true,
    },
    donorHospital: { type: String, required: true, trim: true },
    preservationTimeHours: { type: Number, default: 12 }, // Cold ischemia limit in hours
    leadSurgeon: { type: String, required: true, trim: true },
    notes: { type: String, default: "" },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

TransplantCaseSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

TransplantCaseSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const TransplantCase = mongoose.model("TransplantCase", TransplantCaseSchema);
