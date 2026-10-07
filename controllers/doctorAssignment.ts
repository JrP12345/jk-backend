import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";

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
        workingHours,
        fees,
        feeType: feeType || "fixed",
        appointmentDuration: appointmentDuration || 15,
        bookingMode: bookingMode || "sequential_queue",
        maxDailyTokens: maxDailyTokens !== undefined ? maxDailyTokens : null,
        isActive: true,
      },
      { returnDocument: "after", upsert: true }
    );

    return reply.code(201).send(successResponse(assignment, "Doctor assigned to location successfully"));
  } catch (err) {
    console.error("assignDoctor error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getDoctorAssignments(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user?.role;
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed && userRole !== "patient") return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.allowed ? scope.organizationId : req.user?.organization_id;
    const { doctorId, locationId } = req.query as { doctorId?: string; locationId?: string };

    const query: any = { isActive: true };

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
    console.error("getDoctorAssignments error:", err);
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
    console.error("updateAssignment error:", err);
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

    await DoctorAssignment.findByIdAndDelete(id);

    return reply.code(200).send(successResponse(null, "Doctor assignment removed successfully"));
  } catch (err) {
    console.error("removeAssignment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
