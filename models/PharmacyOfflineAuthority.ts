import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  authorityId: { type: String, required: true, unique: true },
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true, index: true },
  deviceId: { type: String, required: true }, enrollmentId: { type: String, required: true }, actorId: { type: Schema.Types.ObjectId, required: true },
  actorAuthVersion: { type: Number, required: true }, drawerId: { type: Schema.Types.ObjectId, required: true },
  requestHash: { type: String, required: true }, reviewReference: { type: String, required: true },
  state: { type: String, enum: ["held", "closed"], required: true, default: "held" },
  revision: { type: Number, default: 0, required: true },
  firstSequence: { type: Number, required: true }, lastSequence: { type: Number, required: true }, importedSequence: { type: Number, required: true },
  validFrom: { type: Date, required: true }, validUntil: { type: Date, required: true },
  inventoryMode: { type: String, required: true, enum: ["tracked", "billing_only"] },
  payload: { type: String, required: true }, signature: { type: String, required: true },
  signingKeyId: { type: String, required: true }, signingPublicKey: { type: Schema.Types.Mixed, required: true },
  closedAt: Date, closeRequestHash: String, closeEvidenceHash: String, closeSequence: Number,
  checkoutActivatedAt: Date,
}, { timestamps: true });
schema.index({ organizationId: 1, locationId: 1 }, { unique: true, partialFilterExpression: { state: "held" }, name: "pharmacy_offline_branch_authority_v1" });
schema.index({ drawerId: 1 }, { unique: true, partialFilterExpression: { state: "held" }, name: "pharmacy_offline_drawer_authority_v1" });
schema.index({ organizationId: 1, locationId: 1, enrollmentId: 1, state: 1 }, { name: "pharmacy_offline_enrollment_history_v1" });
const mutable = new Set(["state", "revision", "importedSequence", "closedAt", "closeRequestHash", "closeEvidenceHash", "closeSequence", "checkoutActivatedAt", "updatedAt", "__v"]);
schema.pre("save", function () { if (!this.isNew && this.modifiedPaths().some(path => !mutable.has(path))) throw new Error("Offline authority evidence is immutable"); });
for (const operation of ["updateOne", "findOneAndUpdate"] as const) schema.pre(operation, function () {
  const update = this.getUpdate() as Record<string, unknown>;
  if (!update || Object.keys(update).some(key => !["$set", "$inc", "$setOnInsert"].includes(key)) || Object.entries(update).some(([operator, fields]) =>
    Object.keys(fields as object).some(key => !(operator === "$setOnInsert" && key === "createdAt") && !mutable.has(key)))) throw new Error("Offline authority evidence is immutable");
});
for (const operation of ["updateMany", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const)
  schema.pre(operation, function () { throw new Error("Offline authority evidence cannot be removed or replaced"); });
schema.pre("bulkWrite", function () { throw new Error("Offline authority evidence is immutable"); });
schema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Offline authority evidence cannot be removed"); });
export const PharmacyOfflineAuthority = mongoose.model("PharmacyOfflineAuthority", schema);
