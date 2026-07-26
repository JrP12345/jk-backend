import mongoose, { Schema } from "mongoose";

const ClaimSchema = new Schema({
  claimNumber: { type: String, required: true, unique: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", index: true },

  payerName: { type: String, required: true },
  policyNumber: { type: String, required: true },
  preAuthCode: { type: String, default: "" },

  totalClaimAmount: { type: Number, required: true },
  approvedAmount: { type: Number, default: 0 },
  copayAmount: { type: Number, default: 0 },
  deductibleAmount: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ["submitted", "under_review", "approved", "rejected", "settled"],
    default: "submitted",
    index: true,
  },
  rejectionReason: { type: String, default: "" },
  adjudicatedAt: { type: Date },
  submittedAt: { type: Date, default: Date.now },
  deletedAt: { type: Date, default: null, index: true },
}, { timestamps: true });

ClaimSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

ClaimSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const Claim = mongoose.model("Claim", ClaimSchema);
