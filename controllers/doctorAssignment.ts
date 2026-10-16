import { safeError } from "../utilities/safeError.ts";
import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { getRequestLocationIds, isRootRequest, resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
import { withTransaction } from '../utilities/transaction.ts';
import { publishDoctorAssignmentRemoval } from '../services/DoctorAssignmentRecoveryEvents.ts';
import { unassignRevokedCrmWork } from '../services/CrmRevocationService.ts';
import { resolveStaffLocationGrant } from '../services/LocationAccessService.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { CommandError } from '../services/CommandReceiptService.ts';

export async function assignDoctor(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    if (!orgId) return reply.code(400).send(errorResponse("You are not linked to any organization"));

    const { doctorId, locationId, workingHours, fees, feeType, appointmentDuration, bookingMode, maxDailyTokens } = req.body as {
      doctorId: string; locationId: string; workingHours: string; fees: number;
      feeType?: "fixed" | "post_consultation" | "free"; appointmentDuration?: number;
      bookingMode?: "time_slot" | "sequential_queue"; maxDailyTokens?: number | null;
    };

    if (!doctorId || !locationId || !workingHours || fees === undefined) {
      return reply.code(400).send(errorResponse("doctorId, locationId, workingHours, and fees are required"));
    }

    // Verify Location belongs to the organization
    const location = await Location.findOne({ _id: locationId, organizationId: orgId, isActive: true });
    if (!location) return reply.code(404).send(errorResponse("Location not found in your organization"));

    // Verify Doctor exists and belongs to organization
    const doctorUser = await User.findOne({ _id: doctorId, isActive: true });
    if (!doctorUser) return reply.code(404).send(errorResponse("Doctor user not found"));

    const orgMember = await OrgMember.findOne({ userId: doctorId, organizationId: orgId });
    if (!orgMember) return reply.code(403).send(errorResponse("Doctor is not a member of your organization"));

    // Upsert DoctorAssignment
    const assignment = await DoctorAssignment.findOneAndUpdate(
      { doctorId, locationId, organizationId: orgId },
      {
        $set: { workingHours,
        fees,
        feeType: feeType || "fixed",
        appointmentDuration: appointmentDuration || 15,
        bookingMode: bookingMode || "sequential_queue",
        maxDailyTokens: maxDailyTokens !== undefined ? maxDailyTokens : null,
        isActive: true },
        $inc: { assignmentRevision: 1 },
      },
      { returnDocument: "after", upsert: true }
    );

    return reply.code(201).send(successResponse(assignment, "Doctor assigned to location successfully"));
  } catch (err) {
    console.error("assignDoctor error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getDoctorAssignments(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user?.role;
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    if (["patient", "family_member", "guest"].includes(userRole || "")) return reply.code(403).send(errorResponse("Staff access required"));
    const orgId = scope.allowed ? scope.organizationId : req.user?.organization_id;
    const { doctorId, locationId } = req.query as { doctorId?: string; locationId?: string };
    if ((doctorId && !mongoose.Types.ObjectId.isValid(doctorId)) || (locationId && !mongoose.Types.ObjectId.isValid(locationId))) return reply.code(400).send(errorResponse("Invalid doctor or location ID"));
    const allowedLocations = await getRequestLocationIds(req);
    if (locationId && allowedLocations && !allowedLocations.some(id => String(id) === locationId)) return reply.code(403).send(errorResponse("Location access denied"));

    const query: any = { isActive: true };
    if (allowedLocations) query.locationId = { $in: allowedLocations };

    if (orgId && userRole !== "patient") {
      query.organizationId = orgId;
    }
    if (doctorId && mongoose.Types.ObjectId.isValid(doctorId)) {
      query.doctorId = doctorId;
    }
    if (locationId && mongoose.Types.ObjectId.isValid(locationId)) {
      query.locationId = locationId;
    }

    if (!orgId && !doctorId && !locationId && userRole !== "patient") {
      return reply.code(400).send(errorResponse("You are not linked to any organization"));
    }

    const assignments = await DoctorAssignment.find(query)
      .populate("doctorId", "name email phone")
      .populate("locationId", "name city address");

    return reply.code(200).send(successResponse(assignments));
  } catch (err) {
    console.error("getDoctorAssignments error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateAssignment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid assignment ID"));
    }

    const { workingHours, fees, feeType, appointmentDuration, bookingMode, maxDailyTokens } = req.body as {
      workingHours?: string; fees?: number; feeType?: "fixed" | "post_consultation" | "free";
      appointmentDuration?: number;
      bookingMode?: "time_slot" | "sequential_queue"; maxDailyTokens?: number | null;
    };

    const query: any = { _id: id };
    if (orgId) query.organizationId = orgId;

    const assignment = await DoctorAssignment.findOne(query);
    if (!assignment) return reply.code(404).send(errorResponse("Doctor assignment not found"));

    const updateFields: any = {};
    if (workingHours !== undefined) updateFields.workingHours = workingHours;
    if (fees !== undefined) updateFields.fees = fees;
    if (feeType !== undefined) updateFields.feeType = feeType;
    if (appointmentDuration !== undefined) updateFields.appointmentDuration = appointmentDuration;
    if (bookingMode !== undefined) updateFields.bookingMode = bookingMode;
    if (maxDailyTokens !== undefined) updateFields.maxDailyTokens = maxDailyTokens;

    const updated = await DoctorAssignment.findByIdAndUpdate(id, updateFields, { returnDocument: "after" });

    return reply.code(200).send(successResponse(updated, "Doctor assignment updated successfully"));
  } catch (err) {
    console.error("updateAssignment error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function removeAssignment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid assignment ID"));
    }

    const query: any = { _id: id };
    if (orgId) query.organizationId = orgId;

    const assignment = await DoctorAssignment.findOne(query);
    if (!assignment) return reply.code(404).send(errorResponse("Doctor assignment not found"));

    await withTransaction(async () => {
      if (!isRootRequest(req)) {
        const grant = await resolveStaffLocationGrant(req.user!.id, String(assignment.organizationId), req.user!.role, true);
        if (grant && !grant.includes(String(assignment.locationId))) throw new CommandError(403, 'This branch is outside your authority');
      }
      const removed = await DoctorAssignment.findOneAndUpdate({ _id: assignment._id, organizationId: assignment.organizationId, isActive: true }, { $set: { isActive: false }, $inc: { assignmentRevision: 1 } }, { returnDocument: 'after' });
      if (!removed) return;
      const member = await OrgMember.findOne({ userId: removed.doctorId, organizationId: removed.organizationId }).select('role').lean();
      const grant = member ? await resolveStaffLocationGrant(String(removed.doctorId), String(removed.organizationId), member.role, true) : [];
      const crmHandoff = grant ? await unassignRevokedCrmWork(String(removed.organizationId), String(removed.doctorId), grant) : undefined;
      await AuditLog.create({ organizationId: removed.organizationId, userId: req.user!.id, action: 'DOCTOR_ASSIGNMENT_REMOVED', targetId: removed._id, targetModel: 'DoctorAssignment', category: 'ADMIN', details: { locationId: String(removed.locationId), crmHandoff } });
      await publishDoctorAssignmentRemoval(removed, req.user!.id);
    });

    return reply.code(200).send(successResponse(null, "Doctor assignment removed successfully"));
  } catch (err) {
    if (err instanceof CommandError) return reply.code(err.statusCode).send(errorResponse(err.message));
    console.error("removeAssignment error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
