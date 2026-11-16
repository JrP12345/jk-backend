import mongoose, { Schema } from "mongoose";

const history = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true },
  enrollmentId: { type: String, required: true }, deviceId: { type: String, required: true },
  evidence: { type: Schema.Types.Mixed, required: true },
  retiredBy: { type: Schema.Types.ObjectId, required: true }, retiredAt: { type: Date, required: true }, reviewReference: { type: String, required: true },
}, { timestamps: true });
history.index({ organizationId: 1, locationId: 1, enrollmentId: 1 }, { unique: true, name: "pharmacy_retired_enrollment_v1" });
history.index({ organizationId: 1, locationId: 1, deviceId: 1 }, { unique: true, name: "pharmacy_retired_device_v1" });
history.pre("save", function () { if (!this.isNew) throw new Error("Retired PC evidence is immutable"); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const)
  history.pre(operation, function () { throw new Error("Retired PC evidence is immutable"); });
history.pre("bulkWrite", function () { throw new Error("Retired PC evidence is immutable"); });
history.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Retired PC evidence is immutable"); });
export const PharmacyOfflineDeviceHistory = mongoose.model("PharmacyOfflineDeviceHistory", history);
