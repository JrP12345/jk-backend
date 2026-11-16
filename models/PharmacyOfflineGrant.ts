import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  authorityId: { type: String, required: true, unique: true }, organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true },
  actorId: { type: Schema.Types.ObjectId, required: true }, deviceId: { type: String, required: true }, manifestDigest: { type: String, required: true }, requestHash: { type: String, required: true },
  payload: { type: String, required: true }, sha256: { type: String, required: true }, signature: { type: String, required: true }, signingKeyId: { type: String, required: true }, signingPublicKey: { type: Schema.Types.Mixed, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.pre("save", function () { if (!this.isNew) throw new Error("Offline checkout grant is immutable"); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const)
  schema.pre(operation, function () { throw new Error("Offline checkout grant cannot be changed or removed"); });
schema.pre("bulkWrite", function () { throw new Error("Offline checkout grant is immutable"); });
schema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Offline checkout grant cannot be removed"); });
export const PharmacyOfflineGrant = mongoose.model("PharmacyOfflineGrant", schema);
