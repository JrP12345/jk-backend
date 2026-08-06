import mongoose, { Schema } from "mongoose";

const DietOrderSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    patientId: { type: Schema.Types.ObjectId, ref: "Patient", index: true },
    patientName: { type: String, required: true, trim: true },
    bedNumber: { type: String, required: true, trim: true, index: true },
    ward: { type: String, required: true, trim: true, index: true },
    dietType: {
      type: String,
      enum: ["regular", "diabetic_low_carb", "renal_low_sodium", "soft_bland", "liquid_clear", "high_protein", "npo_nothing_by_mouth"],
      default: "regular",
      index: true,
    },
    caloricTarget: { type: Number, default: 2000 },
    allergies: [{ type: String }],
    specialInstructions: { type: String, default: "" },
    mealTime: {
      type: String,
      enum: ["breakfast", "lunch", "dinner", "snack_morning", "snack_evening"],
      default: "lunch",
      index: true,
    },
    deliveryStatus: {
      type: String,
      enum: ["ordered", "preparing", "dispatched", "delivered", "npo_held"],
      default: "ordered",
      index: true,
    },
    prescribedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    deliveredAt: { type: Date, default: null },
    intakePercentage: { type: Number, default: 100 }, // 0 to 100%
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

DietOrderSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

DietOrderSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const DietOrder = mongoose.model("DietOrder", DietOrderSchema);
