import mongoose, { Schema } from "mongoose";

// The signed assertion ID is consumed once across API replicas. TTL is cleanup;
// callback expiry validation remains mandatory before insertion.
const schema = new Schema({
  _id: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});
export const SsoAssertion = mongoose.model("SsoAssertion", schema);
