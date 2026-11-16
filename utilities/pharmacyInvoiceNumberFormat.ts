import { CommandError } from "../services/CommandReceiptService.ts";
import { indiaFinancialYear } from "./indiaFinancialYear.ts";

export interface PharmacyNumberFormat { prefixTemplate: string; digits: number; resetPolicy: "continuous" | "financial_year" }
export interface PharmacyNumberSnapshot extends PharmacyNumberFormat { version: 1; prefix: string; sequence: number; configurationRevision: number }

export function pharmacyNumberPrefix(format: PharmacyNumberFormat, financialYear: string) {
  if (!format || typeof format.prefixTemplate !== "string" || !Number.isSafeInteger(format.digits) || format.digits < 1 || format.digits > 9 ||
      !["continuous", "financial_year"].includes(format.resetPolicy) || !/^20\d{2}-\d{2}$/.test(financialYear) || Number(financialYear.slice(0, 4)) > 2098 || String(Number(financialYear.slice(0, 4)) + 1).slice(-2) !== financialYear.slice(-2)) throw new CommandError(409, "Review the invoice prefix, digits and financial-year policy");
  const tokens = format.prefixTemplate.match(/\{FY\}/g)?.length ?? 0;
  if (format.resetPolicy === "financial_year" ? tokens !== 1 : tokens !== 0) throw new CommandError(409, "Use exactly one {FY} in a yearly prefix, or no {FY} for a continuous sequence");
  const prefix = format.prefixTemplate.replace("{FY}", financialYear.slice(2));
  if (!/^[A-Z0-9][A-Z0-9/-]*[/-]$/.test(prefix) || prefix.length + format.digits > 16 || /^[ICO][A-Z0-9]{4}[0-9]{4}\/$/.test(prefix))
    throw new CommandError(409, "Use an uppercase branch prefix ending in / or -, with at most 16 characters including the number. Internal document prefixes are reserved.");
  return prefix;
}

/** Validate captured evidence, never today's mutable branch settings. */
export function validPharmacyInvoiceNumber(invoice: { invoiceNumber?: string | null; numberingVersion?: number | null; invoiceSeries?: string | null; financialYear?: string | null; issuedAt?: Date | null; numberingSnapshot?: any } | null | undefined) {
  if (!invoice) return false;
  if (invoice.numberingVersion === 2) return !invoice.numberingSnapshot && /^I[A-Z0-9]{4}[0-9]{4}\/[0-9]{6}$/.test(invoice.invoiceNumber ?? "") && invoice.invoiceSeries === invoice.invoiceNumber!.slice(1, 5);
  if (invoice.numberingVersion !== 3 || !invoice.issuedAt || !invoice.financialYear) return false;
  try {
    const snapshot = invoice.numberingSnapshot as PharmacyNumberSnapshot | undefined;
    if (!snapshot || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.configurationRevision) || snapshot.configurationRevision < 1 ||
        !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 1 || snapshot.sequence >= 10 ** snapshot.digits ||
        indiaFinancialYear(invoice.issuedAt).label !== invoice.financialYear) return false;
    const prefix = pharmacyNumberPrefix(snapshot, invoice.financialYear);
    return snapshot.prefix === prefix && invoice.invoiceSeries === prefix && invoice.invoiceNumber === `${prefix}${String(snapshot.sequence).padStart(snapshot.digits, "0")}`;
  } catch { return false; }
}
