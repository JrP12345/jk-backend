import mongoose, { Schema, Document } from "mongoose";

export type ContentClass = "clinical_document" | "avatar" | "prescription" | "lab_report" | "radiology" | "other";
export type UploadIntentStatus = "pending" | "quarantined" | "completed" | "rejected" | "expired";

export interface IUploadIntent extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  patientId?: mongoose.Types.ObjectId;
  objectKey: string;
  originalFileName: string;
  contentClass: ContentClass;
  permittedMimeTypes: string[];
  maxSizeBytes: number;
  actualSizeBytes?: number;
  actualMimeType?: string;
  status: UploadIntentStatus;
  rejectionReason?: string;
  magicBytesVerified: boolean;
  malwareClean: boolean;
  downloadUrlExpiresAt?: Date;
  expiresAt: Date;
  registeredDocumentId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const UploadIntentSchema = new Schema<IUploadIntent>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    patientId: { type: Schema.Types.ObjectId, ref: "Patient", index: true },
    objectKey: { type: String, required: true, unique: true, index: true },
    originalFileName: { type: String, required: true },
    contentClass: {
      type: String,
      enum: ["clinical_document", "avatar", "prescription", "lab_report", "radiology", "other"],
      default: "clinical_document",
      index: true,
    },
    permittedMimeTypes: [{ type: String }],
    maxSizeBytes: { type: Number, required: true, default: 15 * 1024 * 1024 }, // 15MB default
    actualSizeBytes: { type: Number },
    actualMimeType: { type: String },
    status: {
      type: String,
      enum: ["pending", "quarantined", "completed", "rejected", "expired"],
      default: "pending",
      index: true,
    },
    rejectionReason: { type: String },
    magicBytesVerified: { type: Boolean, default: false },
    malwareClean: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true, index: true },
    registeredDocumentId: { type: Schema.Types.ObjectId, ref: "DocumentUpload" },
  },
  { timestamps: true }
);

UploadIntentSchema.index({ organizationId: 1, status: 1 });
UploadIntentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 }); // TTL after 24h of expiry

export const UploadIntent = mongoose.model<IUploadIntent>("UploadIntent", UploadIntentSchema);
