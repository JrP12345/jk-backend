import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Invoice } from "../models/Invoice.ts";
import { CashierShift } from "../models/CashierShift.ts";
import { User } from "../models/User.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { checkLocationAccess } from "../utilities/tenant.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

function sendTenantError(reply: FastifyReply, check: { allowed: false; statusCode: number; message: string }) {
  return reply.code(check.statusCode).send(errorResponse(check.message));
}

/**
 * GET /api/billing/till/summary
 * Calculates live system collection totals for a location's cashier desk on a given date.
 */
export async function getTillSummary(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { locationId, date } = req.query as { locationId?: string; date?: string };

    if (!locationId || !mongoose.Types.ObjectId.isValid(locationId)) {
      return reply.code(400).send(errorResponse("Valid locationId is required"));
    }

    const locationAccess = await checkLocationAccess(req, locationId);
    if (!locationAccess.allowed) return sendTenantError(reply, locationAccess);

    const dateStr = date || new Date().toISOString().slice(0, 10);
    const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
    const endOfDay = new Date(`${dateStr}T23:59:59.999Z`);

    const invoices = await Invoice.find({
      locationId,
      status: "paid",
      deletedAt: null,
      $or: [
        { paymentDate: { $gte: startOfDay, $lte: endOfDay } },
        { updatedAt: { $gte: startOfDay, $lte: endOfDay }, status: "paid" },
      ],
    }).lean();

    let cash = 0;
    let upi = 0;
    let card = 0;
    let other = 0;

    for (const inv of invoices) {
      const amt = Number(inv.amountPaid || inv.totalAmount || 0);
      const method = (inv.paymentMethod || "").toLowerCase();

      if (method.includes("cash")) {
        cash += amt;
      } else if (method.includes("upi") || method.includes("qr") || method.includes("soundbox")) {
        upi += amt;
      } else if (method.includes("card") || method.includes("pos")) {
        card += amt;
      } else {
        // Fallback check payment reference or default
        if (method === "online") upi += amt;
        else other += amt;
      }
    }

    const total = cash + upi + card + other;

    // Check if a till shift was already closed for today
    const latestShift = await CashierShift.findOne({
      locationId,
      shiftDate: dateStr,
    })
      .sort({ createdAt: -1 })
      .lean();

    return reply.code(200).send(
      successResponse({
        date: dateStr,
        locationId,
        systemTotals: {
          cash: Math.round(cash * 100) / 100,
          upi: Math.round(upi * 100) / 100,
          card: Math.round(card * 100) / 100,
          other: Math.round(other * 100) / 100,
          total: Math.round(total * 100) / 100,
          invoiceCount: invoices.length,
        },
        latestShift,
      })
    );
  } catch (err) {
    console.error("getTillSummary error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

/**
 * POST /api/billing/till/close
 * Cashier reconciles physical cash drawer, records variance, and closes daily till session.
 */
export async function closeTill(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { locationId, actualCashCounted, handoverNotes, varianceReason } = req.body as {
      locationId: string;
      actualCashCounted: number;
      handoverNotes?: string;
      varianceReason?: string;
    };

    if (!locationId || !mongoose.Types.ObjectId.isValid(locationId)) {
      return reply.code(400).send(errorResponse("Valid locationId is required"));
    }

    if (actualCashCounted === undefined || actualCashCounted === null || isNaN(Number(actualCashCounted)) || Number(actualCashCounted) < 0) {
      return reply.code(400).send(errorResponse("Counted physical cash must be a non-negative number"));
    }

    const locationAccess = await checkLocationAccess(req, locationId);
    if (!locationAccess.allowed) return sendTenantError(reply, locationAccess);

    const dateStr = new Date().toISOString().slice(0, 10);
    const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
    const endOfDay = new Date(`${dateStr}T23:59:59.999Z`);

    const invoices = await Invoice.find({
      locationId,
      status: "paid",
      deletedAt: null,
      $or: [
        { paymentDate: { $gte: startOfDay, $lte: endOfDay } },
        { updatedAt: { $gte: startOfDay, $lte: endOfDay }, status: "paid" },
      ],
    }).lean();

    let cash = 0;
    let upi = 0;
    let card = 0;
    let other = 0;

    for (const inv of invoices) {
      const amt = Number(inv.amountPaid || inv.totalAmount || 0);
      const method = (inv.paymentMethod || "").toLowerCase();

      if (method.includes("cash")) {
        cash += amt;
      } else if (method.includes("upi") || method.includes("qr") || method.includes("soundbox")) {
        upi += amt;
      } else if (method.includes("card") || method.includes("pos")) {
        card += amt;
      } else {
        if (method === "online") upi += amt;
        else other += amt;
      }
    }

    const total = cash + upi + card + other;
    const countedCash = Math.round(Number(actualCashCounted) * 100) / 100;
    const systemCash = Math.round(cash * 100) / 100;
    const cashVariance = Math.round((countedCash - systemCash) * 100) / 100;

    const cashierUser = await User.findById(req.user!.id).select("name").lean();
    const cashierName = cashierUser?.name || "Cashier Desk";

    const shift = await CashierShift.create({
      organizationId: locationAccess.organizationId || undefined,
      locationId,
      cashierId: req.user!.id,
      cashierName,
      shiftDate: dateStr,
      startedAt: startOfDay,
      endedAt: new Date(),
      systemTotals: {
        cash: systemCash,
        upi: Math.round(upi * 100) / 100,
        card: Math.round(card * 100) / 100,
        other: Math.round(other * 100) / 100,
        total: Math.round(total * 100) / 100,
        invoiceCount: invoices.length,
      },
      actualCashCounted: countedCash,
      cashVariance,
      varianceReason: varianceReason || (cashVariance !== 0 ? "Variance noted during drawer audit" : "Balanced till"),
      handoverNotes: handoverNotes || "Daily cashier shift closed and audited",
      status: "closed",
    });

    await AuditLog.create({
      userId: req.user!.id,
      action: "CASHIER_TILL_CLOSE",
      targetId: shift._id,
      targetModel: "CashierShift",
      details: {
        locationId,
        shiftDate: dateStr,
        actualCashCounted: countedCash,
        cashVariance,
        invoiceCount: invoices.length,
      },
    });

    return reply.code(201).send(
      successResponse(
        shift,
        `Cashier till successfully closed for ${dateStr}. Variance: ${cashVariance >= 0 ? `+₹${cashVariance}` : `-₹${Math.abs(cashVariance)}`}`
      )
    );
  } catch (err) {
    console.error("closeTill error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

/**
 * GET /api/billing/till/history
 * Lists historical cashier till closures for managerial review.
 */
export async function getTillHistory(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { locationId, limit = "20" } = req.query as { locationId?: string; limit?: string };

    if (!locationId || !mongoose.Types.ObjectId.isValid(locationId)) {
      return reply.code(400).send(errorResponse("Valid locationId is required"));
    }

    const locationAccess = await checkLocationAccess(req, locationId);
    if (!locationAccess.allowed) return sendTenantError(reply, locationAccess);

    const history = await CashierShift.find({ locationId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit, 10) || 20)
      .lean();

    return reply.code(200).send(successResponse(history));
  } catch (err) {
    console.error("getTillHistory error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
