import mongoose, { Schema } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

const BedSchema = new Schema({
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  wardName: { type: String, required: true },
  floor: { type: String, default: "Ground Floor", trim: true },
  wing: { type: String, default: "Main Wing", trim: true },
  bedType: {
    type: String,
    enum: ["general", "semi_private", "private_suite", "icu", "nicu", "isolation"],
    default: "general",
    index: true,
  },
  bedNumber: { type: String, required: true },
  status: { 
    type: String, 
    enum: ["available", "occupied", "maintenance", "reserved"], 
    default: "available",
    index: true 
  },
  pricePerDay: { type: Number, required: true },
  occupiedBy: { type: Schema.Types.ObjectId, ref: "Patient", default: null, index: true },
  createdAt: { type: Date, default: Date.now }
});

BedSchema.index({ clinicId: 1, floor: 1, wardName: 1 });

BedSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

BedSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

BedSchema.plugin(auditPlugin);

export const Bed = mongoose.model("Bed", BedSchema);
