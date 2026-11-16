import mongoose, { Schema } from "mongoose";
import { permitsOfflineDeviceReplacement } from "../utilities/pharmacyOfflineDeviceReplacement.ts";

const publicKey = new Schema({ kty: { type: String, required: true }, crv: { type: String, required: true }, x: { type: String, required: true }, y: { type: String, required: true } }, { _id: false });
const device = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true, ref: "Organization" },
  locationId: { type: Schema.Types.ObjectId, required: true, ref: "Location", unique: true },
  deviceId: { type: String, required: true }, deviceName: { type: String, required: true, maxlength: 80 },
  enrolledBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
  publicKey: { type: publicKey, required: true }, keyFingerprint: { type: String, required: true },
  enrollmentId: { type: String, required: true }, requestHash: { type: String, required: true },
  payload: { type: String, required: true }, signature: { type: String, required: true }, signingKeyId: { type: String, required: true },
  signingPublicKey: { type: new Schema({ kty: { type: String, required: true }, n: { type: String, required: true }, e: { type: String, required: true } }, { _id: false }), required: true },
  revision: { type: Number, required: true, default: 1 }, status: { type: String, required: true, enum: ["enrolled", "revoked"], default: "enrolled" },
  authorityRevision: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger },
  revokedBy: { type: Schema.Types.ObjectId, ref: "User" }, revokedAt: Date, revokeReference: String,
}, { timestamps: true });
// Enrollment and its reserved numbers survive expiry/revocation. Replacement must
// reconcile the old ledger first; neither TTL nor a second enrollment frees it.
const mutable = new Set(["status", "revision", "authorityRevision", "revokedBy", "revokedAt", "revokeReference", "updatedAt", "__v"]);
device.pre("save", function () { if (!this.isNew && this.modifiedPaths().some(path => !mutable.has(path))) throw new Error("Offline enrollment evidence is immutable"); });
for (const operation of ["updateOne", "findOneAndUpdate"] as const) device.pre(operation, function () {
  const update = this.getUpdate() as Record<string, unknown>;
  if (permitsOfflineDeviceReplacement(this.getFilter(), Boolean(this.getOptions().session?.inTransaction()))) {
    const allowed = new Set(["deviceId", "deviceName", "enrolledBy", "publicKey", "keyFingerprint", "enrollmentId", "requestHash", "payload", "signature", "signingKeyId", "signingPublicKey", "revision", "status", "authorityRevision", "updatedAt", "__v"]);
    if (!update || Object.keys(update).some(operator => !["$set", "$unset", "$setOnInsert"].includes(operator)) ||
        Object.entries(update).some(([operator, fields]) => Object.keys(fields as object).some(key => operator === "$unset" ? !["revokedBy", "revokedAt", "revokeReference"].includes(key) : operator === "$setOnInsert" ? key !== "createdAt" : !allowed.has(key))))
      throw new Error("Offline PC replacement fields differ from the archived enrollment");
    return;
  }
  if (!update || Object.keys(update).some(key => key !== "$set" && key !== "$setOnInsert") ||
      Object.entries(update).some(([operator, fields]) => Object.keys(fields as object).some(key => !(operator === "$setOnInsert" && key === "createdAt") && !mutable.has(key))))
    throw new Error("Offline enrollment evidence is immutable");
});
for (const operation of ["updateMany", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const)
  device.pre(operation, function () { throw new Error("Offline enrollment evidence cannot be removed or replaced"); });
device.pre("bulkWrite", function () { throw new Error("Offline enrollment evidence is immutable"); });
device.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Offline enrollment evidence cannot be removed"); });
export const PharmacyOfflineDevice = mongoose.model("PharmacyOfflineDevice", device);

const challenge = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true },
  actorId: { type: Schema.Types.ObjectId, required: true }, challengeId: { type: String, required: true, unique: true },
  deviceId: { type: String, required: true }, publicKey: { type: publicKey, required: true }, keyFingerprint: { type: String, required: true },
  context: { type: String, required: true }, expiresAt: { type: Date, required: true }, consumedAt: Date,
}, { timestamps: true });
challenge.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "pharmacy_device_challenge_expiry" });
export const PharmacyOfflineChallenge = mongoose.model("PharmacyOfflineChallenge", challenge);
