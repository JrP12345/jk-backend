import mongoose, { Schema } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

const MedicineSchema = new Schema({
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  name: { type: String, required: true, index: true },
  genericName: { type: String, required: true },
  stockQuantity: { type: Number, required: true, default: 0 },
  price: { type: Number, required: true }, // retail selling price
  costPrice: { type: Number, required: true }, // purchase cost price
  expiryDate: { type: Date },
  batchNumber: { type: String },
  reorderLevel: { type: Number, default: 20 },
  hsnCode: { type: String, default: "3004" },
  gstRate: { type: Number, default: 5 },
  deletedAt: { type: Date, default: null, index: true },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

MedicineSchema.index({ clinicId: 1, name: 1 });

MedicineSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

MedicineSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

MedicineSchema.plugin(auditPlugin);

export const Medicine = mongoose.model("Medicine", MedicineSchema);
