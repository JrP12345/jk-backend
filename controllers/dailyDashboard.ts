import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { Invoice } from "../models/Invoice.ts";
import { getRequestClinicIds, resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
import { getEffectivePermissions, isPrivilegedRole } from "../utilities/permissions.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function getDailyDashboard(req: FastifyRequest, reply: FastifyReply) {
  const scope = resolveAuthorizedOrganizationScope(req);
  if (!scope.allowed || !scope.organizationId) return reply.code(403).send(errorResponse("Organization context is required"));
  if (["patient", "family_member", "guest"].includes(req.user!.role)) return reply.code(403).send(errorResponse("Staff access required"));
  const { startDate, endDate, clinicId } = req.query as { startDate?: string; endDate?: string; clinicId?: string };
  const start = new Date(startDate || "");
  const end = new Date(endDate || "");
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start || end.getTime() - start.getTime() > 27 * 60 * 60_000) {
    return reply.code(400).send(errorResponse("Supply a valid daily date range"));
  }
  const allowedClinicIds = ((await getRequestClinicIds(req)) || []).map(String);
  if (clinicId && !allowedClinicIds.includes(clinicId)) return reply.code(403).send(errorResponse("Clinic access denied"));
  const clinicIds = (clinicId ? [clinicId] : allowedClinicIds).map((id) => new mongoose.Types.ObjectId(id));
  const appointmentMatch: any = { organizationId: new mongoose.Types.ObjectId(scope.organizationId), clinicId: { $in: clinicIds }, appointmentTime: { $gte: start, $lte: end } };
  if (req.user!.role === "doctor") appointmentMatch.doctorId = new mongoose.Types.ObjectId(req.user!.id);
  const [statuses, recentAppointments] = await Promise.all([
    Appointment.aggregate([{ $match: appointmentMatch }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    Appointment.find(appointmentMatch).populate("clinicId", "name city address").populate("doctorId", "name specialization").populate({ path: "patientId", populate: { path: "userId", select: "name phone" } }).sort({ appointmentTime: 1 }).limit(100).lean(),
  ]);
  const byStatus = Object.fromEntries(statuses.map((row) => [row._id, row.count]));
  let collections = 0, outstanding = 0;
  const permissions = await getEffectivePermissions(req.user!.role, scope.organizationId, req.user?.authVersion);
  if (isPrivilegedRole(req.user!.role) || permissions.has("MANAGE_BILLING") || permissions.has("VIEW_BILLING")) {
    const invoiceMatch: any = { organizationId: new mongoose.Types.ObjectId(scope.organizationId), clinicId: { $in: clinicIds }, deletedAt: null, status: { $ne: "refunded" } };
    if (req.user!.role === "doctor") invoiceMatch.doctorId = new mongoose.Types.ObjectId(req.user!.id);
    const values = await Invoice.aggregate([{ $match: invoiceMatch }, { $group: {
      _id: null,
      collections: { $sum: { $cond: [
        { $gt: [{ $size: { $ifNull: ["$payments", []] } }, 0] },
        { $sum: { $map: { input: { $filter: { input: "$payments", as: "payment", cond: { $and: [{ $gte: ["$$payment.paidAt", start] }, { $lte: ["$$payment.paidAt", end] }] } } }, as: "payment", in: "$$payment.amount" } } },
        { $cond: [{ $and: [{ $eq: ["$status", "paid"] }, { $gte: [{ $ifNull: ["$paymentDate", "$createdAt"] }, start] }, { $lte: [{ $ifNull: ["$paymentDate", "$createdAt"] }, end] }] }, "$totalAmount", 0] },
      ] } },
      outstanding: { $sum: { $cond: [{ $and: [{ $in: ["$status", ["unpaid", "partially_paid"]] }, { $gte: ["$createdAt", start] }, { $lte: ["$createdAt", end] }] }, { $max: [0, { $subtract: ["$totalAmount", { $ifNull: ["$amountPaid", 0] }] }] }, 0] } },
    } }]);
    collections = values[0]?.collections || 0;
    outstanding = values[0]?.outstanding || 0;
  }
  return reply.send(successResponse({ appointments: statuses.reduce((total, row) => total + row.count, 0), completed: byStatus.completed || 0,
    pending: (byStatus.pending || 0) + (byStatus.confirmed || 0), byStatus, collections, outstanding, startDate: start, endDate: end,
    recentAppointments: recentAppointments.map((appointment: any) => ({ ...appointment, id: appointment._id.toString(), clinicId: appointment.clinicId ? { ...appointment.clinicId, id: appointment.clinicId._id.toString() } : null, doctorId: appointment.doctorId ? { ...appointment.doctorId, id: appointment.doctorId._id.toString() } : null, patientId: appointment.patientId ? { ...appointment.patientId, id: appointment.patientId._id.toString() } : null })) }));
}
