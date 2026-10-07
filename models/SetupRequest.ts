import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  requestKey: { type: String, required: true, unique: true },
  organization: { type: String, required: true, trim: true, maxlength: 200 },
  city: { type: String, required: true, trim: true, maxlength: 100 },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  planSlug: { type: String, default: "" },
  planName: { type: String, default: "Help me choose a plan" },
  status: { type: String, enum: ["new", "contacted", "closed"], default: "new" },
  reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });
schema.index({ status: 1, _id: -1 });
export const SetupRequest = mongoose.model("SetupRequest", schema);
