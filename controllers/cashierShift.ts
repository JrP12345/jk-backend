import { safeError } from "../utilities/safeError.ts";
import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { CashierShift } from "../models/CashierShift.ts";
import { User } from "../models/User.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { checkLocationAccess } from "../utilities/tenant.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { CommandError, executeRecordedCommand } from "../services/CommandReceiptService.ts";
import { collectTillReceipts, collectionPaise } from "../services/TillCollectionService.ts";

async function tillAccess(req: FastifyRequest, locationId: unknown) {
  if (["patient", "family_member", "guest"].includes(req.user?.role || "")) throw new CommandError(403, "Till reports require authorized staff");
  if (typeof locationId !== "string" || !mongoose.isValidObjectId(locationId)) throw new CommandError(400, "Valid locationId is required");
  const access = await checkLocationAccess(req, locationId);
  if (!access.allowed) throw new CommandError(access.statusCode, access.message);
  return access.organizationId!;
}
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
  console.error("Till report error:", safeError(error));
  return reply.code(500).send(errorResponse("Unable to calculate or save till collections"));
}
// Missing markers identify historical invoice-based snapshots without changing stored rows.
const presentShift = (shift: any) => shift ? { ...shift, collectionBasis: shift.collectionBasis || "legacy_invoice_totals" } : null;
const shiftScope = (organizationId: string, locationId: string) => ({ locationId, $or: [{ organizationId }, { organizationId: null }] });

export async function getTillSummary(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const { locationId, date } = req.query as { locationId?: string; date?: string };
    const organizationId = await tillAccess(req, locationId);
    const summary = await collectTillReceipts(organizationId, locationId!, date);
    const latestShift = await CashierShift.findOne({ ...shiftScope(organizationId, locationId!), kind: "receipt_report", shiftDate: summary.date }).sort({ createdAt: -1 }).lean();
    return reply.send(successResponse({ ...summary, latestShift: presentShift(latestShift) }));
  } catch (error) { return failure(reply, error); }
}

export async function closeTill(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const { locationId, actualCashCounted, handoverNotes, varianceReason } = req.body as {
      locationId: string; actualCashCounted: number; handoverNotes?: string; varianceReason?: string;
    };
    const organizationId = await tillAccess(req, locationId);
    const countedPaise = collectionPaise(actualCashCounted);
    if (countedPaise === null) throw new CommandError(400, "Counted physical cash must be a bounded non-negative number with at most two decimal places");
    if ((handoverNotes !== undefined && (typeof handoverNotes !== "string" || handoverNotes.length > 2000)) ||
        (varianceReason !== undefined && (typeof varianceReason !== "string" || varianceReason.length > 1000))) throw new CommandError(400, "Invalid handover notes or variance reason");
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(428, "A stable Idempotency-Key is required to save a daily collection report");
    const command = await executeRecordedCommand(`daily-receipt-report:${organizationId}:${locationId}`, key, { actorId: req.user!.id, countedPaise, handoverNotes: handoverNotes?.trim(), varianceReason: varianceReason?.trim() }, () => withTransaction(async session => {
      if (!session?.inTransaction()) throw new CommandError(409, "Till report and audit require a transaction-capable database");
      const currentOrganization = await tillAccess(req, locationId);
      if (currentOrganization !== organizationId) throw new CommandError(409, "Location authority changed; reload the till");
      const summary = await collectTillReceipts(organizationId, locationId);
      if (summary.reconciliation.requiresReview) throw new CommandError(409, "Collection evidence requires reconciliation; review the till summary before closing");
      const variancePaise = countedPaise - Math.round(summary.systemTotals.cash * 100);
      if (variancePaise && !varianceReason?.trim()) throw new CommandError(400, "A reason for the cash difference is required");
      const cashier = await User.findById(req.user!.id).select("name").lean();
      if (!cashier?.name) throw new CommandError(409, "Cashier identity requires review");
      const result = await CashierShift.create({ organizationId, locationId, cashierId: req.user!.id, cashierName: cashier.name,
        shiftDate: summary.date, collectionBasis: summary.collectionBasis, timezone: summary.timezone, currency: summary.currency,
        asOf: summary.asOf, periodEnd: summary.periodEnd, startedAt: summary.periodStart, endedAt: summary.asOf,
        systemTotals: summary.systemTotals, actualCashCounted, cashVariance: variancePaise / 100,
        varianceReason: varianceReason?.trim() || "Balanced till", handoverNotes: handoverNotes?.trim() || "", status: "closed" });
      await AuditLog.create({ organizationId, userId: req.user!.id, action: "CASHIER_TILL_CLOSE", targetId: result._id, targetModel: "CashierShift",
        details: { locationId, shiftDate: summary.date, collectionBasis: summary.collectionBasis, receiptCount: summary.systemTotals.receiptCount,
          actualCashCounted, cashVariance: variancePaise / 100, invoiceCount: summary.systemTotals.invoiceCount } });
      return String(result._id);
    }), { writeConcern: { w: "majority" } });
    const shift = await CashierShift.findOne({ _id: command.resultId, kind: "receipt_report", organizationId, locationId, cashierId: req.user!.id });
    if (!shift) throw new CommandError(409, "Saved daily collection report needs review");
    return reply.code(201).send(successResponse(shift, `Till collection snapshot saved for ${shift.shiftDate}`));
  } catch (error) { return failure(reply, error); }
}

export async function getTillHistory(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const { locationId, limit = "20" } = req.query as { locationId?: string; limit?: string };
    const organizationId = await tillAccess(req, locationId);
    const pageSize = Number(limit);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new CommandError(400, "History limit must be between 1 and 100");
    const history = await CashierShift.find({ ...shiftScope(organizationId, locationId!), kind: "receipt_report" }).sort({ createdAt: -1 }).limit(pageSize).lean();
    return reply.send(successResponse(history.map(presentShift)));
  } catch (error) { return failure(reply, error); }
}
