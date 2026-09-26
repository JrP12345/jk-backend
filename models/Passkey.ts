import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  credentialId: { type: String, required: true, unique: true },
  publicKey: { type: Buffer, required: true },
  counter: { type: Number, required: true, default: 0 },
  transports: { type: [String], default: [] },
  name: { type: String, default: "My passkey", maxlength: 80 },
  backedUp: { type: Boolean, default: false },
  lastUsedAt: { type: Date },
}, { timestamps: true });

export const Passkey = mongoose.models.Passkey || mongoose.model("Passkey", schema);
