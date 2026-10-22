import { Schema } from "mongoose";
import { PHARMACY_CALCULATION_POLICY } from "../services/InvoiceCalculationService.ts";

const paise = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const amounts = {
  amountBeforeDiscountPaise: paise, lineDiscountPaise: paise, invoiceDiscountPaise: paise,
  baseAmountPaise: paise, cgstPaise: paise, sgstPaise: paise, utgstPaise: paise, igstPaise: paise,
  unallocatedTaxPaise: paise, grossAmountPaise: paise,
};
const line = new Schema({ lineId: { type: String, required: true }, quantity: { ...paise, min: 1 },
  gstRateBps: { ...paise, max: 10000 }, ...amounts }, { _id: false });
export const pharmacyCalculationSchema = new Schema({
  policy: { type: String, enum: [PHARMACY_CALCULATION_POLICY], required: true }, currency: { type: String, enum: ["INR"], required: true },
  priceMode: { type: String, enum: ["inclusive", "exclusive"], required: true },
  taxMode: { type: String, enum: ["sgst", "utgst", "igst", "unallocated", "none"], required: true },
  lines: { type: [line], required: true },
  totals: { type: new Schema({ ...amounts, roundOffPaise: { type: Number, required: true, min: -99, max: 99, validate: Number.isSafeInteger }, payablePaise: paise }, { _id: false }), required: true },
}, { _id: false });
