import mongoose from "mongoose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Invoice } from "../models/Invoice.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { purchaseScope } from "../services/PharmacyPurchaseDraftService.ts";
import { pharmacyRequestAllows } from "../services/PharmacyCapabilityService.ts";
import { readDrawers } from "../services/CashierDrawerService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { getLocationTimezone, locationDateKey, locationDayRange } from "../utilities/locationTime.ts";
import { object } from "../schemas/pharmacyPurchases.ts";
import { pharmacyInventoryMode } from "../utilities/pharmacyInventoryMode.ts";
import { errorResponse, successResponse } from "../utilities/helpers.ts";

/** Read-only counter context. Original supplies are not collections or net sales after returns. */
export async function getCounterOverview(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "organizationId", "organization_id"]);
    const scope = await purchaseScope(req, query.locationId), timezone = await getLocationTimezone(scope.locationId);
    const asOf = new Date(), date = locationDateKey(asOf, timezone), { start } = locationDayRange(date, timezone);
    const owned = { organizationId: new mongoose.Types.ObjectId(scope.organizationId), locationId: new mongoose.Types.ObjectId(scope.locationId) };
    const canStock = await pharmacyRequestAllows(req, "viewStock"), canTill = await pharmacyRequestAllows(req, "viewTill");
    const result = await withTransaction(async session => {
      const sales = { ...owned, kind: "pharmacy", deletedAt: null, documentVersion: { $in: [1, 2] }, issuedAt: { $gte: start, $lte: asOf }, status: { $ne: "cancelled" } };
      const [totals] = await Invoice.aggregate([{ $match: sales }, { $group: { _id: null, bills: { $sum: 1 }, salesPaise: { $sum: "$calculation.totals.payablePaise" }, captured: { $sum: { $cond: [{ $isNumber: "$calculation.totals.payablePaise" }, 1, 0] } } } }]).session(session).option({ maxTimeMS: 5000 });
      if (totals && (totals.captured !== totals.bills || !Number.isSafeInteger(totals.salesPaise) || totals.salesPaise < 0)) throw new CommandError(409, "Sales summary source needs review");
      const recent = await Invoice.find(sales).select("invoiceNumber issuedAt status calculation.totals.payablePaise").sort({ issuedAt: -1, _id: -1 }).limit(3).maxTimeMS(5000).session(session).lean();
      let stock: { low: number; expiring: number; expired: number; days: number } | null = null;
      if (canStock && (await pharmacyInventoryMode(scope.locationId, session)).mode === "tracked") {
        // Low means physical on-hand <= the product reorder level; it is not a promise of saleable stock.
        const low = await Medicine.countDocuments({ locationId: owned.locationId, deletedAt: null, $expr: { $lte: ["$stockQuantity", { $ifNull: ["$reorderLevel", 20] }] } }).maxTimeMS(5000).session(session);
        const lots = { ...owned, quantity: { $gt: 0 } };
        const expired = await MedicineBatch.countDocuments({ ...lots, expiryDate: { $lte: asOf } }).maxTimeMS(5000).session(session);
        const expiring = await MedicineBatch.countDocuments({ ...lots, expiryDate: { $gt: asOf, $lte: new Date(asOf.getTime() + 90 * 86400000) } }).maxTimeMS(5000).session(session);
        stock = { low, expiring, expired, days: 90 };
      }
      return { salesPaise: totals?.salesPaise ?? 0, bills: totals?.bills ?? 0, stock, recent: recent.map(row => ({ id: String(row._id), invoiceNumber: row.invoiceNumber, issuedAt: row.issuedAt!.toISOString(), status: row.status, totalPaise: row.calculation!.totals.payablePaise })) };
    }, { readConcern: { level: "snapshot" } });
    const drawer = canTill ? (await readDrawers(req, scope.locationId) as { active: { drawerTotals: { expectedCashPaise: number } } | null }).active : null;
    return reply.send(successResponse({ locationId: scope.locationId, currency: "INR", timezone, date, asOf: asOf.toISOString(), ...result, drawer: canTill ? { active: Boolean(drawer), cashPaise: drawer?.drawerTotals.expectedCashPaise ?? null } : null }));
  } catch (error) {
    return reply.code(error instanceof CommandError ? error.statusCode : 500).send(errorResponse(error instanceof CommandError ? error.message : "Counter summary could not be loaded"));
  }
}
