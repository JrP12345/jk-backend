import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";
import { validateCapturedLot } from "../utilities/pharmacyLot.ts";
import { MEDICINE_BASE_UNITS, MEDICINE_PACK_UNITS } from "../utilities/medicineCatalogue.ts";

export interface IMedicineBatch extends Document {
  organizationId?: mongoose.Types.ObjectId;
  medicineId: mongoose.Types.ObjectId;
  locationId: mongoose.Types.ObjectId;
  batchNumber: string;
  expiryDate: Date;
  quantity: number;
  purchaseCost: number;
  sellingPrice: number;
  mrp?: number;
  hsnCode?: string;
  gstRate?: number;
  status: "active" | "expired" | "depleted" | "quarantined";
  createdAt: Date;
  updatedAt: Date;
  lotVersion?: number; receiptLineId?: string; receiptKind?: "opening" | "receipt" | "return" | "transfer"; receivedAt?: Date; receivedQuantity?: number;
  transferSource?: { transferId: mongoose.Types.ObjectId; eventId: mongoose.Types.ObjectId; originalBatchId: mongoose.Types.ObjectId };
  returnSource?: { returnId: mongoose.Types.ObjectId; originalBatchId: mongoose.Types.ObjectId; invoiceId: mongoose.Types.ObjectId };
  unitSnapshot?: { version: number; baseUnit: string; packUnit: string; unitsPerPack: number };
  costBasis?: { totalPaise: number; receivedBaseUnits: number; currency: string };
  expirySnapshot?: { precision: "day" | "month"; value: string; timezone: string; cutoff: Date };
  sellingPricePaise?: number; mrpPaise?: number; openingSourceReference?: string;
  purchaseSource?: { purchaseId: mongoose.Types.ObjectId; purchaseLineId: string; receiptId: mongoose.Types.ObjectId };
}

const medicineBatchSchema = new Schema<IMedicineBatch>(
  {
    lotVersion: { type: Number, enum: [1], immutable: true },
    purchaseSource: { type: new Schema({ purchaseId: { type: Schema.Types.ObjectId, required: true }, purchaseLineId: { type: String, required: true }, receiptId: { type: Schema.Types.ObjectId, required: true } }, { _id: false }), immutable: true, default: undefined },
    returnSource: { type: new Schema({ returnId: { type: Schema.Types.ObjectId, required: true }, originalBatchId: { type: Schema.Types.ObjectId, required: true }, invoiceId: { type: Schema.Types.ObjectId, required: true } }, { _id: false }), immutable: true, default: undefined },
    transferSource: { type: new Schema({ transferId: { type: Schema.Types.ObjectId, required: true }, eventId: { type: Schema.Types.ObjectId, required: true }, originalBatchId: { type: Schema.Types.ObjectId, required: true } }, { _id: false }), immutable: true, default: undefined },
    receiptLineId: { type: String, immutable: true }, receiptKind: { type: String, enum: ["opening", "receipt", "return", "transfer"], immutable: true },
    receivedAt: { type: Date, immutable: true }, receivedQuantity: { type: Number, immutable: true }, openingSourceReference: { type: String, immutable: true },
    unitSnapshot: { type: new Schema({ version: Number, baseUnit: { type: String, enum: MEDICINE_BASE_UNITS }, packUnit: { type: String, enum: MEDICINE_PACK_UNITS }, unitsPerPack: Number }, { _id: false }), immutable: true, default: undefined },
    costBasis: { type: new Schema({ totalPaise: Number, receivedBaseUnits: Number, currency: String }, { _id: false }), immutable: true, default: undefined },
    expirySnapshot: { type: new Schema({ precision: { type: String, enum: ["day", "month"] }, value: String, timezone: String, cutoff: Date }, { _id: false }), immutable: true, default: undefined },
    sellingPricePaise: { type: Number, immutable: true }, mrpPaise: { type: Number, immutable: true },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      index: true,
    },
    medicineId: {
      type: Schema.Types.ObjectId,
      ref: "Medicine",
      required: true,
      index: true,
    },
    locationId: {
      type: Schema.Types.ObjectId,
      ref: "Location",
      required: true,
      index: true,
    },
    batchNumber: {
      type: String,
      required: true,
      trim: true,
    },
    expiryDate: {
      type: Date,
      required: true,
      index: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: "Batch quantity must be a safe integer" },
    },
    purchaseCost: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isFinite,
    },
    sellingPrice: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isFinite,
    },
    mrp: {
      type: Number,
      min: 0,
      validate: Number.isFinite,
    },
    hsnCode: {
      type: String,
      default: "3004",
    },
    gstRate: {
      type: Number,
      default: 5,
    },
    status: {
      type: String,
      enum: ["active", "expired", "depleted", "quarantined"],
      default: "active",
      index: true,
    },
  },
  { timestamps: true }
);

medicineBatchSchema.index({ medicineId: 1, expiryDate: 1, status: 1 });
// Do not recreate the legacy label index after a separately reviewed T25 cutover.
// Existing database indexes are retained: neither deployment nor this schema drops them.
// The legacy receipt adapter still serializes on Medicine and rejects duplicate labels.
medicineBatchSchema.index({ organizationId: 1, locationId: 1, receiptLineId: 1 }, { name: "pharmacy_receipt_line_v1", unique: true, partialFilterExpression: { lotVersion: 1 } });
medicineBatchSchema.index({ organizationId: 1, locationId: 1, medicineId: 1 });

medicineBatchSchema.plugin(auditPlugin);
medicineBatchSchema.pre("validate", function () { validateCapturedLot(this); });

export const MedicineBatch = mongoose.model<IMedicineBatch>("MedicineBatch", medicineBatchSchema);
