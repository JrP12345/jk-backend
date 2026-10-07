import mongoose, { Schema } from "mongoose";

const SiteVisitSchema = new Schema(
  {
    date: { type: String, required: true, index: true }, // "YYYY-MM-DD"
    path: { type: String, required: true, index: true },
    locationId: { type: Schema.Types.ObjectId, ref: "Location", index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
    visitorId: { type: String, index: true }, // Anonymous visitor fingerprint
    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    device: { type: String, enum: ["Desktop", "Mobile", "Tablet", "Other"], default: "Desktop" },
    browser: { type: String, default: "Other" },
    os: { type: String, default: "Other" },
    referrer: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

SiteVisitSchema.index({ date: 1, locationId: 1 });
SiteVisitSchema.index({ createdAt: -1 });

SiteVisitSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

SiteVisitSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const SiteVisit = mongoose.model("SiteVisit", SiteVisitSchema);
