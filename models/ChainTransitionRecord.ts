import mongoose, { Schema, Document } from "mongoose";

export interface IChainTransitionRecord extends Document {
  organizationId: mongoose.Types.ObjectId | null;
  cutoffTimestamp: Date;
  legacyChainExportHash: string;
  entriesRemediated: number;
  remediatedBy?: mongoose.Types.ObjectId | null;
  remediatedAt: Date;
  reason: string;
  rollbackAvailable: boolean;
  metadata?: Record<string, any>;
  createdAt: Date;
}

const ChainTransitionRecordSchema = new Schema<IChainTransitionRecord>({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true, default: null },
  cutoffTimestamp: { type: Date, required: true },
  legacyChainExportHash: { type: String, required: true },
  entriesRemediated: { type: Number, required: true, default: 0 },
  remediatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  remediatedAt: { type: Date, default: Date.now },
  reason: { type: String, required: true },
  rollbackAvailable: { type: Boolean, default: true },
  metadata: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, index: true },
});

ChainTransitionRecordSchema.index({ organizationId: 1, cutoffTimestamp: -1 });

ChainTransitionRecordSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

ChainTransitionRecordSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const ChainTransitionRecord =
  mongoose.models.ChainTransitionRecord ||
  mongoose.model<IChainTransitionRecord>("ChainTransitionRecord", ChainTransitionRecordSchema);
