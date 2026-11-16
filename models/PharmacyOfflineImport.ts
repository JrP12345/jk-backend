import mongoose, { Schema } from "mongoose";
import { encryptField } from "../utilities/cryptoEnvelope.ts";

const schema = new Schema({
  authorityId: { type: String, required: true }, organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true },
  actorId: { type: Schema.Types.ObjectId, required: true }, importedBy: { type: Schema.Types.ObjectId, required: true },
  commandId: { type: String, required: true }, sequence: { type: Number, required: true, min: 1, validate: Number.isSafeInteger }, digest: { type: String, required: true },
  deviceSignature: { type: String, required: true }, evidenceCiphertext: { type: String, required: true, select: false, set: encryptField },
  invoiceId: { type: Schema.Types.ObjectId, required: true }, collectionId: { type: Schema.Types.ObjectId, required: true },
  invoiceNumber: { type: String, required: true }, issuedAt: { type: Date, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ authorityId: 1, commandId: 1 }, { unique: true });
schema.index({ authorityId: 1, sequence: 1 }, { unique: true });
schema.index({ invoiceId: 1 }, { unique: true });
schema.pre("save", function () { if (!this.isNew) throw new Error("Offline import evidence is immutable"); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const)
  schema.pre(operation, function () { throw new Error("Offline import evidence cannot be changed or removed"); });
schema.pre("bulkWrite", function () { throw new Error("Offline import evidence is immutable"); });
schema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Offline import evidence cannot be removed"); });
export const PharmacyOfflineImport = mongoose.model("PharmacyOfflineImport", schema);
