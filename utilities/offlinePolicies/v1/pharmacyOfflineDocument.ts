import { calculatePharmacyDocument, PHARMACY_CALCULATION_POLICY } from "./pharmacyCalculation.ts";

export interface OfflineDocumentIssuer {
  legalName: string; address: string; stateCode: string; gstin?: string; registration: string; drugLicenceNumbers: string[]; authorisedSignatory: string;
}
export interface OfflineDocumentProduct {
  id: string; name: string; unitDefinition: { version: number; baseUnit: string; packUnit: string; unitsPerPack: number };
  hsnSacCode: string; unitCode: string; gstRateBps: number; taxTreatment: string;
}
export interface OfflineDocumentLot {
  id: string; medicineId: string; batchNumber: string; quantity: number; expiryValue: string; expiryPrecision: "month" | "date";
  sellingPricePaise: number; mrpPaise: number;
}
export interface OfflineDocumentInput {
  actorId: string; issuedAt: string; financialYear: string; issuer: OfflineDocumentIssuer; issuerRevision: number; issuerReviewReference: string;
  lines: Array<{ lineId: string; product: OfflineDocumentProduct; allocations: OfflineDocumentLot[]; discountPaise: number }>;
  invoiceDiscountPaise: number; roundOffPaise: number;
}
export interface OfflineIssuedReceipt {
  version: 2; authorityId: string; manifestDigest: string; calculationEngineSha256: string; documentEngineSha256: string;
  scope: { organizationId: string; locationId: string; deviceId: string }; commandId: string; leaseId: string; sequence: number; requestDigest: string; previousDigest: string | null;
  invoice: ReturnType<typeof buildOfflinePharmacyDocument> & { invoiceNumber: string; numberingVersion: number; invoiceSeries: string;
    numberingSnapshot?: { version: 1; prefixTemplate: string; digits: number; resetPolicy: "continuous" | "financial_year"; configurationRevision: number; prefix: string; sequence: number } };
  lines: Array<{ lineId: string; medicineId: string; discountPaise: number; allocations: Array<{ lotId: string; quantity: number; expectedRevision: number }> }>;
  payment: { manualConfirmed: true; cashTenderedPaise: number; shiftId: string; drawerCode: string; collectedPaise: number; changePaise: number; evidenceMode: "staff_confirmed_manual" };
  stock: Array<{ lotId: string; before: number; after: number; revision: number }>;
  products: Array<{ medicineId: string; before: number; after: number; revision: number }>;
}
export class OfflineDocumentError extends Error {}
export function offlineEvidenceCanonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, offlineEvidenceCanonical).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.entries(value as Record<string, unknown>).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${JSON.stringify(key)}:${offlineEvidenceCanonical(value)}`).join(",")}}`;
  throw new OfflineDocumentError("Offline evidence contains unsupported values");
}
const reject = (): never => { throw new OfflineDocumentError("Offline document source, quantities, tax or captured lot prices require review"); };
const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{24}$/.test(value);
const whole = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min;
const detail = (value: unknown, max = 500): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);

/** Pure captured-source builder, shared verbatim by the browser and importer.
 * Signing, operator authority and current stock ownership are separate boundaries.
 */
export function buildOfflinePharmacyDocument(input: OfflineDocumentInput) {
  const issuer = input?.issuer, at = input?.issuedAt;
  if (!input || !id(input.actorId) || typeof at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at ||
      !issuer || ![issuer.legalName, issuer.address, issuer.authorisedSignatory].every(value => detail(value)) || !/^(0[1-9]|[12][0-9]|3[0-8])$/.test(issuer.stateCode) ||
      !["regular", "composition", "unregistered"].includes(issuer.registration) || !Array.isArray(issuer.drugLicenceNumbers) || !issuer.drugLicenceNumbers.length || issuer.drugLicenceNumbers.length > 10 || issuer.drugLicenceNumbers.some(value => !detail(value)) ||
      (issuer.registration === "unregistered" ? Boolean(issuer.gstin) : !/^[0-9A-Z]{15}$/.test(issuer.gstin || "")) || !whole(input.issuerRevision, 1) || !detail(input.issuerReviewReference) ||
      !Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100) return reject();
  const indiaDate = new Date(Date.parse(at) + 330 * 60_000), year = indiaDate.getUTCFullYear(), start = indiaDate.getUTCMonth() >= 3 ? year : year - 1;
  if (input.financialYear !== `${start}-${String(start + 1).slice(-2)}`) return reject();
  const ids = new Set<string>(), products = new Set<string>(), lots = new Set<string>(), today = indiaDate.toISOString().slice(0, 10);
  const captured = input.lines.map(line => {
    const product = line?.product, unit = product?.unitDefinition;
    if (!line || !/^[a-zA-Z0-9_-]{8,100}$/.test(line.lineId) || ids.has(line.lineId) || !product || !id(product.id) || products.has(product.id) || !detail(product.name, 200) ||
        !unit || !whole(unit.version, 1) || !detail(unit.baseUnit, 40) || !detail(unit.packUnit, 40) || !whole(unit.unitsPerPack, 1) || unit.unitsPerPack > 1000000 ||
        !/^\d{4}(\d{2})?(\d{2})?$/.test(product.hsnSacCode) || !/^[A-Z]{3}$/.test(product.unitCode) || !whole(product.gstRateBps) || product.gstRateBps > 10000 ||
        issuer.registration !== "regular" && product.gstRateBps !== 0 || !["taxable", "exempt", "nil_rated"].includes(product.taxTreatment) ||
        !Array.isArray(line.allocations) || !line.allocations.length || line.allocations.length > 100 || !whole(line.discountPaise)) return reject();
    ids.add(line.lineId); products.add(product.id);
    let quantity = BigInt(0), gross = BigInt(0);
    const batches = line.allocations.map(lot => {
      if (!lot || !id(lot.id) || lots.has(lot.id) || lot.medicineId !== product.id || !detail(lot.batchNumber, 100) || !whole(lot.quantity, 1) ||
          !whole(lot.sellingPricePaise) || !whole(lot.mrpPaise) || lot.sellingPricePaise > lot.mrpPaise || !["month", "date"].includes(lot.expiryPrecision)) return reject();
      const date = lot.expiryPrecision === "month" ? `${lot.expiryValue}-01` : lot.expiryValue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date ||
          (lot.expiryPrecision === "month" ? lot.expiryValue < today.slice(0, 7) : lot.expiryValue < today)) return reject();
      lots.add(lot.id); quantity += BigInt(lot.quantity); gross += BigInt(lot.quantity) * BigInt(lot.sellingPricePaise);
      return { batchNumber: lot.batchNumber, expiryValue: lot.expiryValue, expiryPrecision: lot.expiryPrecision, quantity: lot.quantity, sellingPricePaise: lot.sellingPricePaise, mrpPaise: lot.mrpPaise };
    });
    if (quantity > BigInt(Number.MAX_SAFE_INTEGER) || gross > BigInt(Number.MAX_SAFE_INTEGER)) return reject();
    return { line, product, quantity: Number(quantity), gross: Number(gross), batches };
  });
  const calculation = calculatePharmacyDocument({ policy: PHARMACY_CALCULATION_POLICY, currency: "INR", priceMode: "inclusive", taxMode: issuer.registration === "regular" ? "sgst" : "none",
    invoiceDiscountPaise: input.invoiceDiscountPaise, roundOffPaise: input.roundOffPaise,
    lines: captured.map(row => ({ lineId: row.line.lineId, quantity: row.quantity, unitPrice: { numeratorPaise: row.gross, denominatorUnits: row.quantity }, gstRateBps: row.product.gstRateBps, lineDiscountPaise: row.line.discountPaise })) });
  const total = calculation.totals;
  if (total.payablePaise <= 0 || total.payablePaise >= 5_000_000) return reject();
  const hasTax = captured.some(row => row.product.gstRateBps > 0), hasExempt = captured.some(row => row.product.gstRateBps === 0);
  const kind = issuer.registration === "unregistered" ? "ordinary_bill" as const : issuer.registration === "composition" || !hasTax ? "bill_of_supply" as const : hasExempt ? "invoice_cum_bill_of_supply" as const : "tax_invoice" as const;
  return {
    kind: "pharmacy" as const, createdBy: input.actorId, customerSnapshot: { anonymous: true }, documentVersion: 2 as const, currency: "INR", issuedAt: at, financialYear: input.financialYear,
    status: "paid", subtotal: total.baseAmountPaise / 100, tax: (total.cgstPaise + total.sgstPaise) / 100, totalAmount: total.payablePaise / 100,
    cgstTotal: total.cgstPaise / 100, sgstTotal: total.sgstPaise / 100, amountPaid: total.payablePaise / 100, balanceDue: 0, calculation,
    taxDocument: { version: 2 as const, kind, pricingPolicy: PHARMACY_CALCULATION_POLICY, supplyMode: "counter_pickup", signatureMode: "manual_on_print" as const,
      issuer: { ...issuer, drugLicenceNumbers: [...issuer.drugLicenceNumbers] }, recipient: { name: "Walk-in customer", address: "", stateCode: issuer.stateCode, deliveryAddress: issuer.address },
      placeOfSupply: issuer.stateCode, reverseCharge: false, profileRevision: input.issuerRevision, reviewReference: input.issuerReviewReference, issuedBy: input.actorId, issuedAt: at,
      notice: issuer.registration === "composition" ? "Composition taxable person, not eligible to collect tax on supplies." : issuer.registration === "unregistered" ? "Unregistered supplier. GST is not collected." : "" },
    items: captured.map((row, index) => {
      const priced = calculation.lines[index];
      return { description: row.product.name, quantity: row.quantity, amount: priced.baseAmountPaise / row.quantity / 100, hsnSacCode: row.product.hsnSacCode, unitCode: row.product.unitCode,
        gstRate: row.product.gstRateBps / 100, baseAmountPaise: priced.baseAmountPaise, cgstPaise: priced.cgstPaise, sgstPaise: priced.sgstPaise, grossAmountPaise: priced.grossAmountPaise,
        unitSnapshot: { ...row.product.unitDefinition }, batches: row.batches };
    }),
  };
}
