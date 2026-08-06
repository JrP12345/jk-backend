import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { ShiftRoster } from "../models/ShiftRoster.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, getRequestOrganizationId } from "../utilities/tenant.ts";

export async function getShifts(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { clinicId, date, ward, staffRole, status } = req.query as {
      clinicId?: string;
      date?: string;
      ward?: string;
      staffRole?: string;
      status?: string;
    };

    const query: any = {
      deletedAt: null,
    };

    if (clinicId) {
      const scope = await checkClinicAccess(req, clinicId);
      if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
      query.clinicId = new mongoose.Types.ObjectId(clinicId);
    } else if (user?.role !== "root") {
      const orgId = getRequestOrganizationId(req);
      if (!orgId) return reply.code(403).send(errorResponse("Organization context is required"));
      query.organizationId = new mongoose.Types.ObjectId(orgId);
    }

    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      query.shiftDate = { $gte: startOfDay, $lte: endOfDay };
    }

    if (ward && ward !== "ALL") {
      query.ward = ward;
    }
    if (staffRole && staffRole !== "ALL") {
      query.staffRole = staffRole;
    }
    if (status && status !== "ALL") {
      query.status = status;
    }

    const shifts = await ShiftRoster.find(query).sort({ shiftDate: 1, startTime: 1 });

    // KPI Metrics calculation
    const totalScheduled = shifts.length;
    const checkedInCount = shifts.filter((s) => s.status === "checked_in").length;
    const morningShifts = shifts.filter((s) => s.shiftType === "morning").length;
    const eveningShifts = shifts.filter((s) => s.shiftType === "evening").length;
    const nightShifts = shifts.filter((s) => s.shiftType === "night").length;
    
    const totalPatientsAssigned = shifts.reduce((acc, s) => acc + (s.assignedPatientsCount || 0), 0);
    const nurseCount = shifts.filter((s) => s.staffRole === "Nurse").length;
    const nurseToPatientRatio = nurseCount > 0 ? (totalPatientsAssigned / nurseCount).toFixed(1) : "0.0";

    return reply.code(200).send(
      successResponse({
        shifts,
        metrics: {
          totalScheduled,
          checkedInCount,
          morningShifts,
          eveningShifts,
          nightShifts,
          nurseCount,
          totalPatientsAssigned,
          nurseToPatientRatio: `1:${nurseToPatientRatio}`,
        },
      })
    );
  } catch (err) {
    console.error("getShifts error:", err);
    return reply.code(500).send(errorResponse("Internal server error fetching shift roster"));
  }
}

export async function createShift(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const {
      clinicId,
      departmentId,
      staffId,
      staffName,
      staffRole,
      shiftDate,
      shiftType,
      startTime,
      endTime,
      ward,
      assignedPatientsCount,
    } = req.body as any;

    if (!clinicId || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("clinicId is required"));
    }
    const scope = await checkClinicAccess(req, clinicId);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const targetClinicId = clinicId;

    if (!staffName || !shiftDate || !shiftType) {
      return reply.code(400).send(errorResponse("Missing required fields: staffName, shiftDate, shiftType"));
    }

    const assignedStaffId = staffId && mongoose.Types.ObjectId.isValid(staffId) ? staffId : user?.id || user?._id;

    const shift = await ShiftRoster.create({
      organizationId: scope.organizationId,
      clinicId: new mongoose.Types.ObjectId(targetClinicId),
      departmentId: departmentId && mongoose.Types.ObjectId.isValid(departmentId) ? new mongoose.Types.ObjectId(departmentId) : undefined,
      staffId: assignedStaffId,
      staffName,
      staffRole: staffRole || "Nurse",
      shiftDate: new Date(shiftDate),
      shiftType,
      startTime: startTime || "07:00",
      endTime: endTime || "15:00",
      ward: ward || "General Ward",
      assignedPatientsCount: Number(assignedPatientsCount) || 0,
      status: "scheduled",
    });

    await AuditLog.create({
      userId: user?.id || user?._id || assignedStaffId,
      action: "SHIFT_ROSTER_CREATE",
      targetId: shift._id,
      targetModel: "ShiftRoster",
      details: { staffName, shiftType, ward, shiftDate }
    });

    return reply.code(201).send(successResponse(shift, "Shift roster created successfully"));
  } catch (err) {
    console.error("createShift error:", err);
    return reply.code(500).send(errorResponse("Internal server error creating shift roster"));
  }
}

export async function updateShiftStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    const { status, overtimeHours } = req.body as { status: string; overtimeHours?: number };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid shift ID"));
    }

    const shift = await ShiftRoster.findById(id);
    if (!shift || shift.deletedAt) {
      return reply.code(404).send(errorResponse("Shift roster entry not found"));
    }
    const scope = await checkOperationalRecordAccess(req, shift);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    shift.status = status as any;
    if (status === "checked_in" && !shift.checkInTime) {
      shift.checkInTime = new Date();
    } else if (status === "checked_out") {
      if (!shift.checkInTime) shift.checkInTime = new Date();
      shift.checkOutTime = new Date();
    }
    if (typeof overtimeHours === "number") {
      shift.overtimeHours = overtimeHours;
    }

    await shift.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "SHIFT_ROSTER_STATUS_UPDATE",
      targetId: shift._id,
      targetModel: "ShiftRoster",
      details: { status, staffName: shift.staffName, ward: shift.ward }
    });

    return reply.code(200).send(successResponse(shift, `Shift status updated to ${status}`));
  } catch (err) {
    console.error("updateShiftStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error updating shift status"));
  }
}

export async function updateHandoverNotes(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    const { handoverNotes } = req.body as { handoverNotes: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid shift ID"));
    }

    const shift = await ShiftRoster.findById(id);
    if (!shift || shift.deletedAt) {
      return reply.code(404).send(errorResponse("Shift roster entry not found"));
    }
    const scope = await checkOperationalRecordAccess(req, shift);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    shift.handoverNotes = handoverNotes;
    await shift.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "SHIFT_ROSTER_HANDOVER_UPDATE",
      targetId: shift._id,
      targetModel: "ShiftRoster",
      details: { staffName: shift.staffName, ward: shift.ward }
    });

    return reply.code(200).send(successResponse(shift, "Shift handover notes updated successfully"));
  } catch (err) {
    console.error("updateHandoverNotes error:", err);
    return reply.code(500).send(errorResponse("Internal server error updating handover notes"));
  }
}

export async function deleteShift(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid shift ID"));
    }

    const shift = await ShiftRoster.findById(id);
    if (!shift || shift.deletedAt) {
      return reply.code(404).send(errorResponse("Shift roster entry not found"));
    }
    const scope = await checkOperationalRecordAccess(req, shift);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    shift.deletedAt = new Date();
    await shift.save();

    await AuditLog.create({
      userId: user?.id || user?._id,
      action: "SHIFT_ROSTER_DELETE",
      targetId: shift._id,
      targetModel: "ShiftRoster",
      details: { staffName: shift.staffName, ward: shift.ward }
    });

    return reply.code(200).send(successResponse(shift, "Shift roster entry deleted successfully"));
  } catch (err) {
    console.error("deleteShift error:", err);
    return reply.code(500).send(errorResponse("Internal server error deleting shift roster"));
  }
}
