import mongoose, { Schema } from "mongoose";

const DocumentUploadSchema = new Schema({
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
  uploadedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },

  fileName: { type: String, required: true },
  fileUrl: { type: String, required: true },
  fileSizeBytes: { type: Number },
  mimeType: { type: String, required: true },

  category: {
    type: String,
    enum: [
      "LAB_REPORT",
      "PRESCRIPTION",
      "RADIOLOGY_SCAN",
      "DISCHARGE_SUMMARY",
      "VACCINATION_RECORD",
      "DENTAL_RECORD",
      "OPHTHALMIC_RECORD",
      "OTHER",
    ],
    default: "OTHER",
    index: true,
  },

  ocrStatus: {
    type: String,
    enum: ["pending", "processing", "completed", "failed"],
    default: "pending",
    index: true,
  },

  ocrRawText: { type: String },

  extractedConcepts: {
    diagnoses: [{ type: String }],
    medications: [{ type: String }],
    labCodes: [{ type: String }],
    importantFindings: [{ type: String }],
    suggestedFollowUpDate: { type: Date },
  },

  confidenceScore: { type: Number, default: 0.95 },
  uploadedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

DocumentUploadSchema.index({ patientId: 1, uploadedAt: -1 });
DocumentUploadSchema.index({ organizationId: 1, category: 1 });

DocumentUploadSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

DocumentUploadSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const DocumentUpload = mongoose.model("DocumentUpload", DocumentUploadSchema);
