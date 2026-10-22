import mongoose, { Schema } from "mongoose";
import { encryptField } from "../utilities/cryptoEnvelope.ts";

const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true }, actorId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ["catalogue", "opening_stock", "customer_dues", "supplier_dues"], required: true },
  digest: { type: String, required: true, match: /^[a-f\d]{64}$/ }, fileHash: { type: String, required: true, match: /^[a-f\d]{64}$/ },
  payloadCiphertext: { type: String, required: true, select: false, set: encryptField },
  sourceErrors: { type: Map, of: String, default: () => ({}) },
}, { timestamps: true });
schema.index({ organizationId: 1, locationId: 1, actorId: 1, digest: 1 }, { unique: true });
schema.index({ organizationId: 1, locationId: 1, actorId: 1, _id: -1 });
schema.index({ organizationId: 1, locationId: 1, kind: 1, fileHash: 1 });
// Reviewed source manifests have no TTL. Expiry must never make a repeated source new stock or debt.
export const PharmacyImport = mongoose.model("PharmacyImport", schema);
