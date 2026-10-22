import { Schema } from "mongoose";

const quantity = { type: Number, min: 0, required: true, validate: Number.isSafeInteger };
const rates = new Schema({ clinicPaise: quantity, pharmacyPaise: quantity, pharmacyAddonPaise: quantity, extraDoctorPaise: quantity,
  additionalPharmacyPaise: { type: Number, min: 0, validate: Number.isSafeInteger } }, { _id: false });
export const commercialPricingSchema = new Schema({ revision: { ...quantity, min: 1 }, monthly: { type: rates, required: true }, annual: { type: rates, default: undefined },
  taxMode: { type: String, enum: ["inclusive", "exclusive"], required: true }, taxRateBps: { ...quantity, max: 10000 }, includedDoctors: quantity, doctorsPerAdditionalClinic: quantity }, { _id: false });
const location = new Schema({ locationId: { type: String, required: true }, clinic: { type: Boolean, required: true }, pharmacy: { type: Boolean, required: true }, capabilityRevision: quantity }, { _id: false });
export const commercialQuoteSchema = new Schema({ version: { type: Number, enum: [1], required: true }, organizationId: { type: String, required: true }, planId: { type: String, required: true }, priceRevision: quantity,
  commercialFamily: { type: String, enum: ["pharmacy", "clinic", "mixed"], required: true }, legacyTier: { type: String, enum: ["starter", "professional", "enterprise"], required: true },
  billingCycle: { type: String, enum: ["monthly", "annual"], required: true }, currency: { type: String, enum: ["INR"], required: true }, taxMode: { type: String, enum: ["inclusive", "exclusive"], required: true }, taxRateBps: quantity,
  periodStart: { type: String, required: true }, periodEnd: { type: String, required: true }, expiresAt: { type: String, required: true },
  lines: { type: [new Schema({ id: { type: String, required: true }, kind: { type: String, enum: ["clinic", "pharmacy", "pharmacy_addon", "extra_doctor"], required: true }, locationId: String,
    quantity, unitPricePaise: quantity, amountPaise: quantity }, { _id: false })], required: true },
  subtotalPaise: quantity, taxPaise: quantity, totalPaise: quantity,
  entitlements: { maxLocations: quantity, maxDoctors: quantity, maxStaff: quantity, locations: { type: [location], required: true } },
  fingerprint: { type: String, required: true, match: /^[a-f\d]{64}$/ },
}, { _id: false });
