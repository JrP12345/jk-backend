import { CommandError } from "../services/CommandReceiptService.ts";
import { locationDayRange } from "./locationTime.ts";
import { normalizeUnitDefinition, toBaseUnits } from "./medicineCatalogue.ts";

export interface StockReceiptInput {
  medicineId: string; locationId: string; receiptLineId: string; kind: "opening" | "receipt";
  expectedUnitVersion: number; packs: number; looseUnits: number; batchNumber: string;
  expiry: { precision: "day" | "month"; value: string };
  purchaseTotalPaise: number; sellingPricePaise: number; mrpPaise?: number; openingSourceReference?: string;
}
const amount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000_000;
export function normalizeStockReceipt(input: unknown): StockReceiptInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CommandError(400, "A stock receipt is required");
  const body = input as Record<string, any>;
  const fields = new Set(["medicineId", "locationId", "receiptLineId", "kind", "expectedUnitVersion", "packs", "looseUnits", "batchNumber", "expiry", "purchaseTotalPaise", "sellingPricePaise", "mrpPaise", "openingSourceReference", "organizationId", "organization_id"]);
  if (Object.keys(body).some(key => !fields.has(key)) || ![body.medicineId, body.locationId].every(value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value)) ||
      typeof body.receiptLineId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.receiptLineId) || !["opening", "receipt"].includes(body.kind) ||
      !Number.isSafeInteger(body.expectedUnitVersion) || body.expectedUnitVersion < 1 || ![body.packs, body.looseUnits].every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
      ![body.purchaseTotalPaise, body.sellingPricePaise].every(amount) || body.mrpPaise !== undefined && (!amount(body.mrpPaise) || body.sellingPricePaise > body.mrpPaise) ||
      typeof body.batchNumber !== "string" || !body.batchNumber.trim() || body.batchNumber.trim().length > 100) throw new CommandError(400, "Provide explicit units, a batch and bounded numeric paise amounts; selling price cannot exceed MRP");
  if (!body.expiry || typeof body.expiry !== "object" || Array.isArray(body.expiry) || Object.keys(body.expiry).some(key => !["precision", "value"].includes(key)) ||
      !["day", "month"].includes(body.expiry.precision) || typeof body.expiry.value !== "string") throw new CommandError(400, "Record the printed expiry precision and value");
  if (body.openingSourceReference !== undefined && (typeof body.openingSourceReference !== "string" || body.openingSourceReference.trim().length < 3 || body.openingSourceReference.trim().length > 120) ||
      body.kind === "opening" && !body.openingSourceReference) throw new CommandError(400, "An opening receipt needs an actual count/source reference");
  return { medicineId: body.medicineId.toLowerCase(), locationId: body.locationId.toLowerCase(), receiptLineId: body.receiptLineId, kind: body.kind,
    expectedUnitVersion: body.expectedUnitVersion, packs: body.packs, looseUnits: body.looseUnits, batchNumber: body.batchNumber.trim(),
    expiry: { precision: body.expiry.precision, value: body.expiry.value }, purchaseTotalPaise: body.purchaseTotalPaise, sellingPricePaise: body.sellingPricePaise,
    ...(body.mrpPaise !== undefined ? { mrpPaise: body.mrpPaise } : {}), ...(body.openingSourceReference !== undefined ? { openingSourceReference: body.openingSourceReference.trim() } : {}) };
}
/** Inclusive printed day/month; the stored cutoff is the exclusive next local midnight. */
export function lotExpiry(expiry: StockReceiptInput["expiry"], timezone: string) {
  const pattern = expiry.precision === "month" ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(expiry.value) || Number(expiry.value.slice(0, 4)) < 2000 || Number(expiry.value.slice(0, 4)) > 2199) throw new CommandError(400, "Use a real printed expiry day or month between 2000 and 2199");
  const first = new Date(`${expiry.value}${expiry.precision === "month" ? "-01" : ""}T12:00:00Z`);
  if (!Number.isFinite(first.getTime()) || first.toISOString().slice(0, expiry.value.length) !== expiry.value) throw new CommandError(400, "Invalid printed expiry date");
  if (expiry.precision === "month") { first.setUTCMonth(first.getUTCMonth() + 1); first.setUTCDate(0); }
  try {
    const cutoff = new Date(locationDayRange(first.toISOString().slice(0, 10), timezone).end.getTime() + 1);
    return { precision: expiry.precision, value: expiry.value, timezone, cutoff };
  } catch { throw new CommandError(409, "Expiry needs a valid location timezone and local midnight"); }
}
export function receiptQuantity(input: StockReceiptInput, unit: { version: number; baseUnit: string; packUnit: string; unitsPerPack: number }) {
  normalizeUnitDefinition(unit, unit.version);
  if (unit.version !== input.expectedUnitVersion) throw new CommandError(409, "Unit definition changed; reload before receiving stock");
  if (input.looseUnits >= unit.unitsPerPack) throw new CommandError(400, "Loose units must be fewer than one pack; enter full packs separately");
  const quantity = toBaseUnits(input.packs, unit.unitsPerPack) + input.looseUnits;
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new CommandError(400, "A receipt must contain a positive safe quantity of base units");
  return quantity;
}
export function validateCapturedLot(lot: any, unit?: any, organizationId?: string) {
  if (lot.lotVersion !== 1) return;
  const snapshot = lot.unitSnapshot, cost = lot.costBasis;
  const invalid = () => { throw new CommandError(409, "Lot snapshot, units or prices require inventory review"); };
  if (!snapshot || !cost || !Number.isSafeInteger(snapshot.version) || snapshot.version < 1) return invalid();
  try { normalizeUnitDefinition(snapshot, snapshot.version); } catch { return invalid(); }
  const expectedExpiry = lot.expirySnapshot;
  if (!expectedExpiry || !["day", "month"].includes(expectedExpiry.precision)) return invalid();
  let cutoff: Date;
  try { cutoff = lotExpiry(expectedExpiry, expectedExpiry.timezone).cutoff; } catch { return invalid(); }
  if (!lot.organizationId || organizationId && String(lot.organizationId) !== organizationId ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(lot.receiptLineId || "") || !["opening", "receipt", "return", "transfer"].includes(lot.receiptKind) ||
      lot.receiptKind === "opening" && (typeof lot.openingSourceReference !== "string" || lot.openingSourceReference.trim().length < 3) ||
      !(lot.receivedAt instanceof Date) || !Number.isFinite(lot.receivedAt.getTime()) ||
      !amount(cost.totalPaise) || !Number.isSafeInteger(cost.receivedBaseUnits) || cost.receivedBaseUnits <= 0 || cost.currency !== "INR" ||
      !amount(lot.sellingPricePaise) || lot.mrpPaise !== undefined && (!amount(lot.mrpPaise) || lot.sellingPricePaise > lot.mrpPaise) ||
      !Number.isSafeInteger(lot.quantity) || lot.quantity < 0 ||
      !Number.isSafeInteger(lot.receivedQuantity) || lot.receivedQuantity <= 0 || (lot.receiptKind === "return" ? !lot.returnSource?.returnId || !lot.returnSource?.originalBatchId || !lot.returnSource?.invoiceId || lot.status !== "quarantined" || lot.quantity > lot.receivedQuantity
        : lot.receiptKind === "transfer" ? ![lot.transferSource?.transferId, lot.transferSource?.eventId, lot.transferSource?.originalBatchId].every(id => /^[a-f\d]{24}$/i.test(String(id))) : lot.receivedQuantity !== cost.receivedBaseUnits) ||
      lot.purchaseCost !== cost.totalPaise / cost.receivedBaseUnits / 100 || lot.sellingPrice !== lot.sellingPricePaise / 100 ||
      (lot.mrpPaise === undefined ? lot.mrp != null : lot.mrp !== lot.mrpPaise / 100) ||
      !(lot.expiryDate instanceof Date) || lot.expiryDate.getTime() !== cutoff.getTime() ||
      !(expectedExpiry.cutoff instanceof Date) || expectedExpiry.cutoff.getTime() !== cutoff.getTime() ||
      unit && ["version", "baseUnit", "packUnit", "unitsPerPack"].some(key => snapshot[key] !== unit[key])) return invalid();
}
/** Exact acquisition-cost fraction; no rounding of per-unit paise or accounting-policy claim. */
export function remainingLotCost(lot: any) {
  validateCapturedLot(lot);
  if (lot.lotVersion !== 1) throw new CommandError(409, "Legacy cost basis needs reviewed reconciliation");
  return { numeratorPaise: (BigInt(lot.costBasis.totalPaise) * BigInt(lot.quantity)).toString(), denominatorBaseUnits: lot.costBasis.receivedBaseUnits, currency: "INR" };
}
