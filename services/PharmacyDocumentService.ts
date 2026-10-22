import { PharmacyTaxProfile } from "../models/PharmacyTaxProfile.ts";
import { Organization } from "../models/Organization.ts";
import { User } from "../models/User.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { inclusiveTax, toPaise, validatePharmacyProfile } from "../utilities/pharmacyTax.ts";
import { calculatePharmacyDocument, PHARMACY_CALCULATION_POLICY } from "./InvoiceCalculationService.ts";

export async function loadPharmacyIssuer(organizationId: string, locationId: string, readOnly = false) {
  const organization = await Organization.findById(organizationId).select("countryCode currency").lean();
  if (organization?.countryCode !== "IN" || organization.currency !== "INR") throw new CommandError(409, "Pharmacy document issue requires an explicit India/INR organization profile");
  const issuer = readOnly ? await PharmacyTaxProfile.findOne({ organizationId, locationId })
    : await PharmacyTaxProfile.findOneAndUpdate({ organizationId, locationId }, { $inc: { __v: 1 } }, { returnDocument: "after" });
  if (!issuer) throw new CommandError(409, "Configure and review the pharmacy issuer tax profile before dispensing");
  if (!issuer.confirmedAt || !issuer.confirmedBy || !Number.isSafeInteger(issuer.revision) || issuer.revision < 1) throw new CommandError(409, "Pharmacy issuer review evidence is incomplete");
  validatePharmacyProfile(issuer);
  return issuer;
}

export function pricePharmacySupply(medicine: any, allocations: Array<{ quantity: number; unitPrice: number; hsnCode: string; gstRate?: number }>, issuer: any) {
  const reviewed = medicine.taxClassification;
  if (!reviewed?.confirmedAt || !reviewed.confirmedBy || !reviewed.reviewReference ||
      reviewed.hsnCode !== medicine.hsnCode || reviewed.gstRate !== medicine.gstRate ||
      !/^\d{4}(\d{2})?(\d{2})?$/.test(reviewed.hsnCode) || reviewed.hsnCode.length < issuer.minimumHsnDigits || !/^[A-Z]{3}$/.test(reviewed.unitCode || "") ||
      !["taxable", "exempt", "nil_rated"].includes(reviewed.treatment) ||
      (reviewed.treatment === "taxable" ? reviewed.gstRate <= 0 : reviewed.gstRate !== 0)) {
    throw new CommandError(409, "Review this medicine's HSN and tax classification before dispensing");
  }
  let gross = 0n;
  inclusiveTax(0, reviewed.gstRate);
  for (const allocation of allocations) {
    if (allocation.hsnCode !== reviewed.hsnCode || allocation.gstRate !== reviewed.gstRate) throw new CommandError(409, "Batch tax classification differs from the reviewed medicine; reconcile it before supply");
    if (!Number.isSafeInteger(allocation.quantity) || allocation.quantity <= 0) throw new CommandError(409, "Pharmacy allocations require positive safe base quantities");
    gross += BigInt(toPaise(allocation.unitPrice)) * BigInt(allocation.quantity);
    if (gross > BigInt(Number.MAX_SAFE_INTEGER)) throw new CommandError(409, "Pharmacy line amount exceeds the supported monetary bound");
  }
  if (!allocations.length) throw new CommandError(409, "Pharmacy supply requires captured lot allocations");
  const gstRate = issuer.registration === "regular" ? reviewed.gstRate : 0;
  // Aggregate captured lots before decomposition to retain issued inclusive-paise-v1 rounding.
  const priced = calculatePharmacyDocument({ policy: PHARMACY_CALCULATION_POLICY, currency: "INR", priceMode: "inclusive", taxMode: "sgst",
    lines: [{ lineId: "supply", quantity: 1, unitPrice: { numeratorPaise: Number(gross), denominatorUnits: 1 }, gstRateBps: Math.round(gstRate * 100) }] }).lines[0];
  return { baseAmountPaise: priced.baseAmountPaise, cgstPaise: priced.cgstPaise, sgstPaise: priced.sgstPaise, grossAmountPaise: priced.grossAmountPaise, gstRate, hsnSacCode: reviewed.hsnCode,
    unitCode: reviewed.unitCode, taxTreatment: reviewed.treatment, taxReviewReference: reviewed.reviewReference };
}

export async function pharmacyDocumentSnapshot(issuer: any, patient: any, actorId: string, issuedAt: Date, lines: Array<{ gstRate: number }>) {
  const user = patient.userId ? await User.findById(patient.userId).select("name").lean() : null;
  const recipientName = patient.name || user?.name;
  if (!recipientName) throw new CommandError(409, "A recipient name is required for this pharmacy document");
  const hasTax = lines.some(line => line.gstRate > 0), hasExempt = lines.some(line => line.gstRate === 0);
  const kind = issuer.registration === "unregistered" ? "ordinary_bill" : issuer.registration === "composition" || !hasTax
    ? "bill_of_supply" : hasExempt ? "invoice_cum_bill_of_supply" : "tax_invoice";
  return { version: 1, kind, pricingPolicy: "inclusive-paise-v1", supplyMode: "counter_pickup", signatureMode: "manual_on_print",
    issuer: { legalName: issuer.legalName, address: issuer.address, stateCode: issuer.stateCode, gstin: issuer.gstin,
      registration: issuer.registration, drugLicenceNumbers: [...issuer.drugLicenceNumbers], authorisedSignatory: issuer.authorisedSignatory },
    recipient: { name: recipientName, address: patient.address || "", stateCode: /^(0[1-9]|[12][0-9]|3[0-8])$/.test(patient.state || "") ? patient.state : "",
      deliveryAddress: issuer.address },
    placeOfSupply: issuer.stateCode, reverseCharge: false, profileRevision: issuer.revision,
    reviewReference: issuer.reviewReference, issuedBy: actorId, issuedAt,
    notice: issuer.registration === "composition" ? "Composition taxable person, not eligible to collect tax on supplies."
      : issuer.registration === "unregistered" ? "Unregistered supplier. GST is not collected." : "",
  };
}
