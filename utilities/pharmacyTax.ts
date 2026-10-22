import { CommandError } from "../services/CommandReceiptService.ts";
import { splitPharmacyTax } from "../services/InvoiceCalculationService.ts";
const statePattern = /^(0[1-9]|[12][0-9]|3[0-8])$/;
const gstPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export function validatePharmacyProfile(profile: any, forIssue = true) {
  if (!["regular", "composition", "unregistered"].includes(profile.registration) ||
      ![profile.legalName, profile.address, profile.authorisedSignatory, profile.reviewReference].every(value => typeof value === "string" && value.trim().length >= 3) ||
      !statePattern.test(profile.stateCode) || !Array.isArray(profile.drugLicenceNumbers) || !profile.drugLicenceNumbers.length ||
      profile.drugLicenceNumbers.some((value: unknown) => typeof value !== "string" || value.trim().length < 3) ||
      typeof profile.pricesIncludeTax !== "boolean" || typeof profile.electronicReportingRequired !== "boolean" || ![4, 6, 8].includes(profile.minimumHsnDigits)) {
    throw new CommandError(409, "Complete the reviewed pharmacy issuer profile");
  }
  if (profile.registration === "unregistered" ? Boolean(profile.gstin) : (!gstPattern.test(profile.gstin || "") || profile.gstin.slice(0, 2) !== profile.stateCode)) {
    throw new CommandError(409, "GST registration and issuer state do not match the selected pharmacy profile");
  }
  if (forIssue && !profile.pricesIncludeTax) throw new CommandError(409, "Only inclusive pharmacy counter prices are supported by this document path");
  if (forIssue && profile.electronicReportingRequired) throw new CommandError(409, "This issuer requires electronic reporting that is not supported by this pharmacy document path");
}

export function toPaise(value: number) {
  const scaled = value * 100;
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(scaled)) || Math.abs(scaled - Math.round(scaled)) > 0.000001) {
    throw new CommandError(409, "Pharmacy prices must be nonnegative, bounded amounts with at most two decimal places");
  }
  return Math.round(scaled);
}
export function inclusiveTax(grossPaise: number, gstRate: number) {
  const rate = Math.round(gstRate * 100);
  if (!Number.isSafeInteger(grossPaise) || grossPaise < 0 || !Number.isFinite(gstRate) || gstRate < 0 || gstRate > 100 || Math.abs(rate - gstRate * 100) > 0.000001) {
    throw new CommandError(409, "Invalid reviewed pharmacy tax rate or amount");
  }
  const { baseAmountPaise, cgstPaise, sgstPaise, grossAmountPaise } = splitPharmacyTax(grossPaise, rate, "inclusive", "sgst");
  return { baseAmountPaise, cgstPaise, sgstPaise, grossAmountPaise };
}
