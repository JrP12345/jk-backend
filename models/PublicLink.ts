import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  kind: { type: String, enum: ["location", "doctor"], required: true },
  targetId: { type: Schema.Types.ObjectId, required: true },
  slug: { type: String, required: true, unique: true },
});
schema.index({ kind: 1, targetId: 1 }, { unique: true });
export const PublicLink = mongoose.model("PublicLink", schema);
