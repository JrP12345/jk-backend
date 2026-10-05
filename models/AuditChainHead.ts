import mongoose, { Schema } from "mongoose";
const schema = new Schema({
  _id: { type: String },
  sequence: { type: Number, required: true },
  hash: { type: String, required: true },
}, { versionKey: false });
export const AuditChainHead = mongoose.models.AuditChainHead || mongoose.model("AuditChainHead", schema);
