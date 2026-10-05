import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  scope: { type: String, required: true },
  key: { type: String, required: true },
  requestHash: { type: String, required: true },
  resultId: { type: Schema.Types.ObjectId },
  createdAt: { type: Date, default: Date.now },
});
schema.index({ scope: 1, key: 1 }, { unique: true });
// Financial receipts intentionally have no TTL: expiry must not enable replay.
export const OperationReceipt = mongoose.models.OperationReceipt || mongoose.model("OperationReceipt", schema);
