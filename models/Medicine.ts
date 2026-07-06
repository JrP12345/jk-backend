import mongoose, { Schema } from "mongoose";

const MedicineSchema = new Schema({
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  name: { type: String, required: true, index: true },
  genericName: { type: String, required: true },
  stockQuantity: { type: Number, required: true, default: 0 },
  price: { type: Number, required: true }, // retail price
  costPrice: { type: Number, required: true }, // purchase cost price
  expiryDate: { type: Date, required: true },
  batchNumber: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

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

export const Medicine = mongoose.model("Medicine", MedicineSchema);
