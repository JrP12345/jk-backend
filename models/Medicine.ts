import mongoose, { Schema } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";
import { MEDICINE_BASE_UNITS, MEDICINE_PACK_UNITS } from "../utilities/medicineCatalogue.ts";
import { installMedicineSearchIndex, medicineSearchFields } from "../utilities/medicineSearchIndex.ts";

const MedicineSchema = new Schema({
  locationId: { type: Schema.Types.ObjectId, ref: "Location", required: true, index: true },
  name: { type: String, required: true, index: true, maxlength: 200 },
  genericName: { type: String, required: true, maxlength: 500 },
  searchIndex: { type: new Schema(Object.fromEntries(medicineSearchFields.map(field => [field, { value: String, grams: [String] }])), { _id: false }), select: false },
  stockQuantity: { type: Number, required: true, default: 0, min: 0,
    validate: { validator: Number.isSafeInteger, message: "Stock must be a safe integer" } },
  stockRevision: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger },
  stockLedgerStartedAt: { type: Date, default: null },
  price: { type: Number, required: true, min: 0, validate: Number.isFinite }, // retail selling price
  costPrice: { type: Number, min: 0, validate: Number.isFinite }, // absent on a zero-stock catalogue item with no acquisition cost
  expiryDate: { type: Date },
  batchNumber: { type: String },
  billingSupply: { type: new Schema({ batchNumber: { type: String, required: true, maxlength: 100 },
    expiry: { precision: { type: String, enum: ["day", "month"], required: true }, value: { type: String, required: true } },
    mrpPaise: { type: Number, required: true, min: 0, max: 100_000_000_000, validate: Number.isSafeInteger },
  }, { _id: false }), default: undefined },
  manufacturer: { type: String, trim: true, maxlength: 200 },
  strength: { type: String, trim: true, maxlength: 80 },
  rackLocation: { type: String, trim: true, maxlength: 60 },
  barcodes: { type: [String], default: undefined },
  unitDefinition: { type: new Schema({ version: { type: Number, min: 1, required: true, validate: Number.isSafeInteger },
    baseUnit: { type: String, enum: MEDICINE_BASE_UNITS, required: true }, packUnit: { type: String, enum: MEDICINE_PACK_UNITS, required: true },
    unitsPerPack: { type: Number, min: 1, max: 1_000_000, required: true, validate: Number.isSafeInteger } }, { _id: false }), default: undefined },
  category: {
    type: String,
    enum: ["tablet", "capsule", "syrup", "injection", "ointment", "drops", "inhaler", "other"],
    default: "tablet"
  },
  scheduleType: {
    type: String,
    enum: ["general", "schedule_h", "schedule_h1", "schedule_x", "narcotic"],
    default: "general"
  },
  reorderLevel: { type: Number, default: 20, min: 0, validate: Number.isSafeInteger },
  dispensingRevision: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  dispensingReview: { scheduleType: String, reviewReference: String, confirmedBy: { type: Schema.Types.ObjectId, ref: "User" }, confirmedAt: Date },
  hsnCode: { type: String, default: "3004" },
  gstRate: { type: Number, default: 5 },
  taxRevision: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  taxClassification: {
    hsnCode: String, unitCode: String, gstRate: Number, treatment: { type: String, enum: ["taxable", "exempt", "nil_rated"] },
    reviewReference: String, confirmedBy: { type: Schema.Types.ObjectId, ref: "User" }, confirmedAt: Date,
  },
  deletedAt: { type: Date, default: null, index: true },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

MedicineSchema.index({ locationId: 1, name: 1 });
for (const field of medicineSearchFields) MedicineSchema.index({ locationId: 1, deletedAt: 1, [`searchIndex.${field}.grams`]: 1, _id: 1 }, { name: `pharmacy_search_${field}` });
installMedicineSearchIndex(MedicineSchema);
// Bound cursor-ordered multi-field search to the selected branch's active catalogue.
MedicineSchema.index({ locationId: 1, deletedAt: 1, _id: 1 }, { name: "pharmacy_counter_catalogue_page" });
MedicineSchema.index({ locationId: 1, barcodes: 1 }, { unique: true, partialFilterExpression: { barcodes: { $type: "string" }, deletedAt: null } });

MedicineSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

MedicineSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.searchIndex;
    return ret;
  }
});

MedicineSchema.plugin(auditPlugin);

export const Medicine = mongoose.model("Medicine", MedicineSchema);
