import { Schema } from "mongoose";

export const pharmacyDocumentSchema = new Schema({
  version: { type: Number, required: true },
  kind: { type: String, enum: ["tax_invoice", "bill_of_supply", "invoice_cum_bill_of_supply", "ordinary_bill"], required: true },
  pricingPolicy: { type: String, required: true }, supplyMode: { type: String, required: true }, signatureMode: { type: String, required: true },
  issuer: { legalName: String, address: String, stateCode: String, gstin: String, registration: String, drugLicenceNumbers: [String], authorisedSignatory: String },
  recipient: { name: String, address: String, stateCode: String, deliveryAddress: String },
  placeOfSupply: String, reverseCharge: Boolean, profileRevision: Number, reviewReference: String,
  issuedBy: { type: Schema.Types.ObjectId, ref: "User" }, issuedAt: Date, notice: String,
}, { _id: false });

export const pharmacyTaxAmounts = {
  baseAmountPaise: { type: Number, min: 0, validate: Number.isSafeInteger },
  cgstPaise: { type: Number, min: 0, validate: Number.isSafeInteger },
  sgstPaise: { type: Number, min: 0, validate: Number.isSafeInteger },
  grossAmountPaise: { type: Number, min: 0, validate: Number.isSafeInteger },
};
