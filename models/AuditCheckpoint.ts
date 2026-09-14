import mongoose, { Schema } from "mongoose";

const AuditCheckpointSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true, default: null },
  archivedUpToSequence: { type: Number, required: true },
  archivedUpToHash: { type: String, required: true },
  archivedCount: { type: Number, required: true },
  archiveFilePath: { type: String },
  archiveFileChecksum: { type: String },
  cutoffDate: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now, index: true },
});

AuditCheckpointSchema.index({ organizationId: 1, archivedUpToSequence: -1 });

AuditCheckpointSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

AuditCheckpointSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const AuditCheckpoint =
  mongoose.models.AuditCheckpoint || mongoose.model("AuditCheckpoint", AuditCheckpointSchema);
