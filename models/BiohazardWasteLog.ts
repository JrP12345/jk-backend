import mongoose, { Schema } from "mongoose";

const BiohazardWasteLogSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    manifestNumber: { type: String, required: true, unique: true, index: true }, // e.g. HAZ-2026-8801
    wasteCategory: {
      type: String,
      enum: ["yellow_pathological", "red_soiled_plastics", "white_sharps", "blue_glassware", "cytotoxic"],
      required: true,
      index: true,
    },
    weightKg: { type: Number, required: true },
    originDepartment: { type: String, required: true, index: true },
    disposalMethod: {
      type: String,
      enum: ["autoclaving", "incineration", "chemical_disinfection", "secure_landfill", "recycling_vendor"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["collected", "stored_in_holding", "transported", "processed_disposed"],
      default: "collected",
      index: true,
    },
    disposalVendor: { type: String, required: true, trim: true },
    loggedBy: { type: String, required: true },
    disposedDate: { type: Date, default: null },
    notes: { type: String, default: "" },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

BiohazardWasteLogSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

BiohazardWasteLogSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const BiohazardWasteLog = mongoose.model("BiohazardWasteLog", BiohazardWasteLogSchema);
