import crypto from "node:crypto";
import mongoose, { Schema } from "mongoose";

// Page -1 publishes the signed manifest; no TTL or overwrite of prepared evidence.
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true },
  authorityId: { type: String, required: true }, page: { type: Number, required: true, min: -1, max: 500, validate: Number.isSafeInteger },
  recordIds: { type: [String], default: undefined, select: false },
  payload: { type: String, required: true, validate: (value: string) => Buffer.byteLength(value) <= 1024 * 1024 },
  sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  signature: String, signingKeyId: String, signingPublicKey: Schema.Types.Mixed,
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ authorityId: 1, page: 1 }, { unique: true, name: "pharmacy_offline_snapshot_page_v1" });
schema.index({ authorityId: 1, recordIds: 1 }, { name: "pharmacy_offline_snapshot_lookup_v1" });
schema.pre("validate", function () {
  if (crypto.createHash("sha256").update(this.payload).digest("hex") !== this.sha256 ||
      this.page === -1 && (!this.signature || !this.signingKeyId || !this.signingPublicKey)) throw new Error("Offline preparation digest/signature is incomplete");
  if (this.page >= 0) {
    const records = JSON.parse(this.payload).records;
    if (!Array.isArray(records) || records.length > 200 || !Array.isArray(this.recordIds) || JSON.stringify(records.map(record => record.id)) !== JSON.stringify(this.recordIds)) throw new Error("Offline preparation lookup differs from its immutable page");
  }
});
schema.pre("save", function () { if (!this.isNew) throw new Error("Prepared offline evidence is immutable"); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const)
  schema.pre(operation, function () { throw new Error("Prepared offline evidence cannot be overwritten or removed"); });
schema.pre("bulkWrite", function () { throw new Error("Prepared offline evidence is immutable"); });
schema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Prepared offline evidence cannot be removed"); });
export const PharmacyOfflineSnapshotPage = mongoose.model("PharmacyOfflineSnapshotPage", schema);
