import mongoose, { Schema } from "mongoose";
import { pharmacyPartySnapshotSchema } from "./PharmacyParty.ts";
const integer = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const line = new Schema({
  lineId: { type: String, required: true }, medicineId: { type: Schema.Types.ObjectId, required: true },
  medicineSnapshot: { name: String, genericName: String, strength: String, manufacturer: String },
  unitSnapshot: { version: Number, baseUnit: String, packUnit: String, unitsPerPack: Number },
  packs: integer, looseUnits: integer, quantity: integer,
}, { _id: false });
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true }, locationId: { type: Schema.Types.ObjectId, required: true },
  reference: { type: String, required: true, maxlength: 80 }, normalizedReference: { type: String, required: true },
  supplierId: { type: Schema.Types.ObjectId, required: true }, supplierSnapshot: { type: pharmacyPartySnapshotSchema, required: true },
  buyerSnapshot: { name: { type: String, required: true }, branch: { type: String, required: true }, address: String },
  lines: { type: [line], required: true, validate: (rows: unknown[]) => rows.length > 0 && rows.length <= 100 },
  notes: { type: String, default: "", maxlength: 1000 },
  state: { type: String, enum: ["draft", "submitted", "accepted", "partially_accepted", "rejected", "dispatched", "cancelled", "closed"], required: true, default: "draft" },
  revision: { ...integer, default: 0 }, invoiceCount: { ...integer, default: 0, max: 50 },
  sent: { type: new Schema({ channel: String, reference: String, recordedAt: Date, recordedBy: Schema.Types.ObjectId }, { _id: false }), default: undefined },
  response: { type: new Schema({ reference: String, recordedAt: Date, recordedBy: Schema.Types.ObjectId, lines: [new Schema({ lineId: String, acceptedQuantity: integer,
    quotedUnitPricePaise: { type: Number, min: 0, validate: Number.isSafeInteger }, note: { type: String, maxlength: 300 } }, { _id: false })] }, { _id: false }), default: undefined },
  dispatch: { type: new Schema({ reference: String, expectedDelivery: String, recordedAt: Date, recordedBy: Schema.Types.ObjectId }, { _id: false }), default: undefined },
  closure: { type: new Schema({ reference: String, recordedAt: Date, recordedBy: Schema.Types.ObjectId }, { _id: false }), default: undefined },
  supplierAccess: { type: new Schema({ tokenHash: String, tokenCiphertext: String, issuedKey: String, expiresAt: Date, revokedAt: Date, createdBy: Schema.Types.ObjectId }, { _id: false }), default: undefined },
  supplierEmail: { type: new Schema({ messageId: Schema.Types.ObjectId, queuedAt: Date, requestedBy: Schema.Types.ObjectId }, { _id: false }), default: undefined },
  documents: { type: [new Schema({ documentId: { type: String, required: true }, name: { type: String, required: true }, kind: { type: String, enum: ["invoice", "credit_note", "statement", "dispatch", "other"], required: true },
    contentType: String, size: Number, objectKey: { type: String, required: true }, sha256: String, source: { type: String, enum: ["staff", "supplier_link"], required: true }, supplierVisible: { type: Boolean, default: false }, createdAt: { type: Date, required: true }, createdBy: Schema.Types.ObjectId }, { _id: false })], default: [], validate: (rows: unknown[]) => rows.length <= 25 },
  createdBy: { type: Schema.Types.ObjectId, required: true }, updatedBy: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });
schema.index({ organizationId: 1, locationId: 1, normalizedReference: 1 }, { unique: true, name: "pharmacy_order_reference" });
schema.index({ organizationId: 1, locationId: 1, supplierId: 1, _id: 1 });
schema.index({ organizationId: 1, locationId: 1, _id: 1 });
schema.index({ "supplierAccess.tokenHash": 1 }, { unique: true, sparse: true });
export const PharmacyPurchaseOrder = mongoose.model("PharmacyPurchaseOrder", schema);
