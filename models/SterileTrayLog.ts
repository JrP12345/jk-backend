import mongoose, { Schema } from "mongoose";

const SterileTrayLogSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    trayBarcode: { type: String, required: true, unique: true, index: true }, // e.g. TRAY-SURG-9001
    trayName: { type: String, required: true, index: true }, // e.g. Major Orthopedic Surgery Set #4
    autoclaveUnitId: { type: String, required: true, trim: true, index: true },
    sterilizationCycleNo: { type: String, required: true, index: true }, // e.g. CYC-2026-8812
    sterilizationMethod: {
      type: String,
      enum: ["steam_autoclave", "ethylene_oxide", "hydrogen_peroxide_plasma", "dry_heat"],
      default: "steam_autoclave",
      index: true,
    },
    biologicalIndicatorStatus: {
      type: String,
      enum: ["passed", "failed", "incubation_pending"],
      default: "passed",
      index: true,
    },
    chemicalIndicatorColor: {
      type: String,
      enum: ["black_pass", "brown_fail", "unprocessed"],
      default: "black_pass",
    },
    sterilizationDate: { type: Date, default: Date.now, index: true },
    expirationDate: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ["decontamination", "packing", "sterilizing", "sterile_storage", "issued_to_or", "expired"],
      default: "sterile_storage",
      index: true,
    },
    targetDepartment: { type: String, required: true, trim: true },
    technicianName: { type: String, required: true },
    notes: { type: String, default: "" },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

SterileTrayLogSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

SterileTrayLogSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const SterileTrayLog = mongoose.model("SterileTrayLog", SterileTrayLogSchema);
