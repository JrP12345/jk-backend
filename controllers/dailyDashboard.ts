import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { Invoice } from "../models/Invoice.ts";
import { getRequestLocationIds, resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
import { getEffectivePermissions, isPrivilegedRole } from "../utilities/permissions.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { isIanaTimezone } from "../utilities/countrySettings.ts";
import { locationDateKey, locationDayRange } from "../utilities/locationTime.ts";

export async function getDailyDashboard(req: FastifyRequest, reply: FastifyReply) {
  const scope = resolveAuthorizedOrganizationScope(req);
  if (!scope.allowed || !scope.organizationId) return reply.code(403).send(errorResponse("Organization context is required"));
  if (["patient", "family_member", "guest"].includes(req.user!.role)) return reply.code(403).send(errorResponse("Staff access required"));
  const { startDate, endDate, locationId, doctorId, includeAppointments, trendDays, timezone = "Asia/Kolkata" } = req.query as { startDate?: string; endDate?: string; locationId?: string; doctorId?: string; includeAppointments?: string; trendDays?: string; timezone?: string };
  if (trendDays && (!["7", "30"].includes(trendDays) || !isIanaTimezone(timezone))) return reply.code(400).send(errorResponse("Invalid dashboard trend options"));
  if (includeAppointments !== undefined && !["true", "false"].includes(includeAppointments)) return reply.code(400).send(errorResponse("includeAppointments must be true or false"));
  if (doctorId && !mongoose.Types.ObjectId.isValid(doctorId)) return reply.code(400).send(errorResponse("Invalid doctor ID"));
  const start = new Date(startDate || "");
  const end = new Date(endDate || "");
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start || end.getTime() - start.getTime() > 27 * 60 * 60_000) {
    return reply.code(400).send(errorResponse("Supply a valid daily date range"));
  }
  const allowedLocationIds = ((await getRequestLocationIds(req)) || []).map(String);
  if (locationId && !allowedLocationIds.includes(locationId)) return reply.code(403).send(errorResponse("Location access denied"));
  const locationIds = (locationId ? [locationId] : allowedLocationIds).map((id) => new mongoose.Types.ObjectId(id));
  const appointmentMatch: any = { organizationId: new mongoose.Types.ObjectId(scope.organizationId), locationId: { $in: locationIds }, appointmentTime: { $gte: start, $lte: end } };
  if (req.user!.role === "doctor") appointmentMatch.doctorId = new mongoose.Types.ObjectId(req.user!.id);
  else if (doctorId) appointmentMatch.doctorId = new mongoose.Types.ObjectId(doctorId);
  const [statuses, recentAppointments] = await Promise.all([
    Appointment.aggregate([{ $match: appointmentMatch }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    // Summary-only consumers already fetch a paginated appointment list.
    includeAppointments === "false" ? Promise.resolve([]) : Appointment.find(appointmentMatch)
      .select("status tokenNumber queuePosition appointmentTime appointmentType patientId doctorId locationId")
      .populate("locationId", "name city").populate("doctorId", "name specialization")
      .populate({ path: "patientId", select: "name phone mrn userId", populate: { path: "userId", select: "name phone" } })
      .sort({ appointmentTime: 1, _id: 1 }).limit(100).lean(),
  ]);
  const byStatus = Object.fromEntries(statuses.map((row) => [row._id, row.count]));
  let trends: { days: Array<{ day: string; status: string; count: number }>; locations: Array<{ locationId: string; status: string; count: number }> } | undefined;
  if (trendDays) {
    const firstDay = new Date(`${locationDateKey(start, timezone)}T12:00:00Z`);
    firstDay.setUTCDate(firstDay.getUTCDate() - Number(trendDays) + 1);
    const trendStart = locationDayRange(firstDay.toISOString().slice(0, 10), timezone).start;
    const [totals] = await Appointment.aggregate([{ $match: { ...appointmentMatch, appointmentTime: { $gte: trendStart, $lte: end } } }, { $facet: {
      days: [{ $group: { _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$appointmentTime", timezone } }, status: "$status" }, count: { $sum: 1 } } }],
      locations: [{ $match: { appointmentTime: { $gte: start } } }, { $group: { _id: { locationId: "$locationId", status: "$status" }, count: { $sum: 1 } } }],
    } }]);
    trends = { days: (totals?.days || []).map((row: any) => ({ ...row._id, count: row.count })),
      locations: (totals?.locations || []).map((row: any) => ({ locationId: String(row._id.locationId), status: row._id.status, count: row.count })) };
  }
  let collections = 0, outstanding = 0;
  let moneyByCurrency: Array<{ currency: string; collections: number; outstanding: number }> = [];
  const permissions = await getEffectivePermissions(req.user!.role, scope.organizationId, req.user?.authVersion);
  const financialVisible = isPrivilegedRole(req.user!.role) || permissions.has("MANAGE_BILLING") || permissions.has("VIEW_BILLING");
  if (financialVisible) {
    const invoiceMatch: any = { organizationId: new mongoose.Types.ObjectId(scope.organizationId), locationId: { $in: locationIds }, deletedAt: null, status: { $ne: "refunded" } };
    if (req.user!.role === "doctor") invoiceMatch.doctorId = new mongoose.Types.ObjectId(req.user!.id);
    else if (doctorId) invoiceMatch.doctorId = new mongoose.Types.ObjectId(doctorId);
    const values = await Invoice.aggregate([{ $match: invoiceMatch }, { $group: {
      _id: { $ifNull: ["$currency", "INR"] },
      collections: { $sum: { $cond: [
        { $gt: [{ $size: { $ifNull: ["$payments", []] } }, 0] },
        { $sum: { $map: { input: { $filter: { input: "$payments", as: "payment", cond: { $and: [{ $gte: ["$$payment.paidAt", start] }, { $lte: ["$$payment.paidAt", end] }] } } }, as: "payment", in: "$$payment.amount" } } },
        { $cond: [{ $and: [{ $eq: ["$status", "paid"] }, { $gte: [{ $ifNull: ["$paymentDate", "$createdAt"] }, start] }, { $lte: [{ $ifNull: ["$paymentDate", "$createdAt"] }, end] }] }, "$totalAmount", 0] },
      ] } },
      outstanding: { $sum: { $cond: [{ $and: [{ $in: ["$status", ["unpaid", "partially_paid"]] }, { $gte: ["$createdAt", start] }, { $lte: ["$createdAt", end] }] }, { $max: [0, { $subtract: ["$totalAmount", { $ifNull: ["$amountPaid", 0] }] }] }, 0] } },
    } }]);
    moneyByCurrency = values.map(value => ({ currency: String(value._id), collections: value.collections || 0, outstanding: value.outstanding || 0 }));
    collections = values.reduce((total, value) => total + (value.collections || 0), 0);
    outstanding = values.reduce((total, value) => total + (value.outstanding || 0), 0);
  }
  return reply.send(successResponse({ locationCount: allowedLocationIds.length, appointments: statuses.reduce((total, row) => total + row.count, 0), completed: byStatus.completed || 0,
    pending: (byStatus.pending || 0) + (byStatus.confirmed || 0), byStatus, collections, outstanding, moneyByCurrency, financialVisible, startDate: start, endDate: end,
    ...(trends ? { trends } : {}), recentAppointments: recentAppointments.map((appointment: any) => ({ ...appointment, id: appointment._id.toString(), locationId: appointment.locationId ? { ...appointment.locationId, id: appointment.locationId._id.toString() } : null, doctorId: appointment.doctorId ? { ...appointment.doctorId, id: appointment.doctorId._id.toString() } : null, patientId: appointment.patientId ? { ...appointment.patientId, id: appointment.patientId._id.toString() } : null })) }));
}
