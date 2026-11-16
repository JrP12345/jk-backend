import mongoose, { Schema } from "mongoose";
const schema = new Schema({
  authorityId: { type: String, required: true, unique: true }, organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true },
  actorId: { type: Schema.Types.ObjectId, required: true }, deviceId: { type: String, required: true }, requestHash: { type: String, required: true }, proof: { type: String, required: true }, reviewReference: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.pre("save", function () { if (!this.isNew) throw new Error("Offline cancellation evidence is immutable"); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const)
  schema.pre(operation, function () { throw new Error("Offline cancellation evidence cannot be changed or removed"); });
schema.pre("bulkWrite", function () { throw new Error("Offline cancellation evidence is immutable"); });
schema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Offline cancellation evidence cannot be removed"); });
export const PharmacyOfflineClaimCancellation = mongoose.model("PharmacyOfflineClaimCancellation", schema);
