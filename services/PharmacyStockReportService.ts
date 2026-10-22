import mongoose from "mongoose";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { normalizeUnitDefinition } from "../utilities/medicineCatalogue.ts";
import { validateCapturedLot, remainingLotCost } from "../utilities/pharmacyLot.ts";
import { reportColumns, reportDate, reportNumber, requireReportBound, sourcePage, type ReportContext, type ReportResult, type ReportRow } from "./PharmacyReportTypes.ts";

export async function stockReport(ctx: ReportContext): Promise<ReportResult> {
  const { input, scope, session, asOf } = ctx, after = input.cursor ? { _id: { $gt: input.cursor } } : {};
  const bound = new Date(asOf.getTime() + input.days * 86400000), cutoff = new Date(asOf.getTime() - input.days * 86400000);
  if (input.kind === "valuation" || input.kind === "expiry") {
    const sources = await MedicineBatch.find({ organizationId: scope.organizationId, locationId: scope.locationId, quantity: { $gt: 0 }, ...(input.kind === "expiry" ? { expiryDate: { $lte: bound } } : {}), ...after }).sort({ _id: 1 }).limit(input.limit + 1).maxTimeMS(5000).session(session).lean();
    const { page, nextCursor } = sourcePage(sources, input), medicines = await Medicine.find({ _id: { $in: page.map(row => row.medicineId) }, locationId: scope.locationId }).select("name unitDefinition deletedAt").limit(26).maxTimeMS(5000).session(session).lean();
    const rows: ReportRow[] = page.map(lot => {
      const medicine = medicines.find(row => String(row._id) === String(lot.medicineId)); let review = "", cost: ReturnType<typeof remainingLotCost> | null = null;
      try { if (!medicine?.unitDefinition || medicine.deletedAt || lot.lotVersion !== 1) throw Error(); validateCapturedLot(lot, medicine.unitDefinition, scope.organizationId); if (input.kind === "valuation") cost = remainingLotCost(lot); } catch { review = "Captured lot, product or cost basis needs review"; }
      return { id: String(lot._id), medicineId: String(lot.medicineId), product: medicine?.name || "Unavailable product", batch: lot.batchNumber, units: lot.quantity, unit: lot.unitSnapshot?.baseUnit || "Unknown", status: lot.status, printedExpiry: lot.expirySnapshot?.value || "Unknown", expiryCutoff: reportDate(lot.expiryDate), saleable: review ? null : lot.status === "active" && lot.expiryDate > asOf ? lot.quantity : 0, review,
        ...(input.kind === "valuation" ? { valueFloorPaise: cost ? reportNumber(BigInt(cost.numeratorPaise) / BigInt(cost.denominatorBaseUnits)) : null, costNumerator: cost?.numeratorPaise || null, costDenominator: cost?.denominatorBaseUnits || null } : {}) };
    });
    return { rows, nextCursor, scanned: page.length, columns: reportColumns([["product", "Product"], ["batch", "Batch"], ["units", "On-hand units", "integer"], ["unit", "Base unit"], ["saleable", "Eligible units", "integer"], ["status", "Disposition"], ["printedExpiry", "Printed expiry"], ["expiryCutoff", "Exclusive expiry cutoff", "date"], ...(input.kind === "valuation" ? [["valueFloorPaise", "Remaining cost, floor per lot (INR)", "paise"], ["costNumerator", "Exact cost numerator (paise)"], ["costDenominator", "Exact cost denominator", "integer"]] as Array<[string, string, "paise" | "integer" | undefined]> : []), ["review", "Review"]]), basis: input.kind === "valuation" ? "Current physical on-hand, including expired/quarantined stock. Captured rational acquisition cost; each lot is floored separately to whole paise for display. Unknown costs remain unknown. This is not an accounting valuation policy." : `Positive on-hand lots with exclusive cutoff within ${input.days} elapsed days, including already expired stock. Printed expiry precision is retained; quarantine remains ineligible.` };
  }
  const sources = await Medicine.find({ locationId: scope.locationId, deletedAt: null, ...after }).select("name stockQuantity reorderLevel unitDefinition createdAt").sort({ _id: 1 }).limit(input.limit + 1).maxTimeMS(5000).session(session).lean();
  const { page, nextCursor } = sourcePage(sources, input);
  // Inspect every related lot, including wrongly located references, without exposing foreign fields.
  const lots = await MedicineBatch.find({ medicineId: { $in: page.map(row => row._id) } }).limit(2001).maxTimeMS(5000).session(session).lean(); requireReportBound(lots);
  const recent = input.kind === "dead_stock" ? await StockMovement.aggregate([{ $match: { organizationId: new mongoose.Types.ObjectId(scope.organizationId), locationId: new mongoose.Types.ObjectId(scope.locationId), medicineId: { $in: page.map(row => row._id) }, kind: "dispense", createdAt: { $gte: cutoff, $lte: asOf } } }, { $group: { _id: "$medicineId" } }]).option({ maxTimeMS: 5000 }).session(session) : [];
  const rows: ReportRow[] = [];
  for (const medicine of page) {
    const batches = lots.filter(lot => String(lot.medicineId) === String(medicine._id)); let review = "", eligible: number | null = null;
    try {
      if (!medicine.unitDefinition || !Number.isSafeInteger(medicine.stockQuantity) || medicine.stockQuantity < 0) throw Error(); normalizeUnitDefinition(medicine.unitDefinition, medicine.unitDefinition.version);
      if (batches.some(lot => lot.lotVersion !== 1 || String(lot.locationId) !== scope.locationId || String(lot.organizationId) !== scope.organizationId)) throw Error();
      for (const lot of batches) { validateCapturedLot(lot, medicine.unitDefinition, scope.organizationId); if (lot.status === "depleted" && lot.quantity !== 0) throw Error(); }
      if (batches.reduce((sum, lot) => sum + BigInt(lot.quantity), 0n) !== BigInt(medicine.stockQuantity)) throw Error();
      eligible = reportNumber(batches.filter(lot => lot.status === "active" && lot.expiryDate > asOf).reduce((sum, lot) => sum + BigInt(lot.quantity), 0n));
    } catch { review = "Units, owned lots or aggregate reconciliation needs review"; }
    const reorder = medicine.reorderLevel ?? 20;
    if (!Number.isSafeInteger(reorder) || reorder < 0) review = "Reorder basis needs review";
    const isLow = eligible !== null && !review && eligible <= reorder;
    const oldest = batches.filter(lot => lot.quantity > 0).reduce<Date | null>((old, lot) => lot.receivedAt && (!old || lot.receivedAt < old) ? lot.receivedAt : old, null);
    const noRecent = !recent.some((row: any) => String(row._id) === String(medicine._id)), dormant = medicine.stockQuantity > 0 && oldest !== null && oldest <= cutoff && noRecent;
    if (input.kind === "low_stock" && !isLow && !review || input.kind === "dead_stock" && !dormant && !review) continue;
    rows.push({ id: String(medicine._id), product: medicine.name, units: medicine.stockQuantity, eligible, unit: medicine.unitDefinition?.baseUnit || "Unknown", reorder, oldestReceipt: reportDate(oldest), review, ...(input.kind === "dead_stock" ? { movementBasis: noRecent ? `No dispense in ${input.days} days` : "Recent dispense" } : {}) });
  }
  return { rows, nextCursor, scanned: page.length, columns: reportColumns([["product", "Product"], ["units", "Physical on-hand", "integer"], ["eligible", "Eligible saleable units", "integer"], ["unit", "Base unit"], ["reorder", "Reorder threshold (base units)", "integer"], ["oldestReceipt", "Oldest held receipt", "date"], ...(input.kind === "dead_stock" ? [["movementBasis", "Activity basis"]] as Array<[string, string]> : []), ["review", "Review"]]), basis: input.kind === "dead_stock" ? `Current positive on-hand with a receipt at least ${input.days} elapsed days old and no recorded pharmacy dispense during that interval. Never-supplied old stock qualifies; new stock does not. Review rows are included separately.` : "Current owned and reconciled captured lots. Saleable units exclude expired, quarantined and depleted lots. Low stock compares eligible base units with the product threshold (default 20 base units). Review rows are included separately; totals never add unlike units." };
}
