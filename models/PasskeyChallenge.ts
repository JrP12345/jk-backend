import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  tokenHash: { type: String, required: true, unique: true },
  challenge: { type: String, required: true },
  kind: { type: String, enum: ["registration", "authentication"], required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User" },
  sessionId: { type: String },
  expiresAt: { type: Date, required: true },
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const PasskeyChallenge = mongoose.models.PasskeyChallenge || mongoose.model("PasskeyChallenge", schema);
