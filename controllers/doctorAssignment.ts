import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Clinic } from "../models/Clinic.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function assignDoctor(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user!.organization_id;
    if (!orgId) return reply.code(400).send(errorResponse("You are not linked to any organization"));

    const { doctorId, clinicId, workingHours, fees, appointmentDuration, bookingMode, maxDailyTokens } = req.body as {
      doctorId: string; clinicId: string; workingHours: string; fees: number; appointmentDuration?: number;
      bookingMode?: "time_slot" | "sequential_queue"; maxDailyTokens?: number | null;
    };

    if (!doctorId || !clinicId || !workingHours || fees === undefined) {
      return reply.code(400).send(errorResponse("doctorId, clinicId, workingHours, and fees are required"));
    }

    // Verify Clinic belongs to the organization
    const clinic = await Clinic.findOne({ _id: clinicId, organizationId: orgId, isActive: true });
    if (!clinic) return reply.code(404).send(errorResponse("Clinic not found in your organization"));

    // Verify Doctor exists and belongs to organization
    const doctorUser = await User.findOne({ _id: doctorId, isActive: true });
    if (!doctorUser) return reply.code(404).send(errorResponse("Doctor user not found"));

    const orgMember = await OrgMember.findOne({ userId: doctorId, organizationId: orgId });
    if (!orgMember) return reply.code(403).send(errorResponse("Doctor is not a member of your organization"));

    // Upsert DoctorAssignment
    const assignment = await DoctorAssignment.findOneAndUpdate(
      { doctorId, clinicId, organizationId: orgId },
      {
        workingHours,
        fees,
        appointmentDuration: appointmentDuration || 15,
        bookingMode: bookingMode || "sequential_queue",
        maxDailyTokens: maxDailyTokens !== undefined ? maxDailyTokens : null,
        isActive: true,
      },
      { returnDocument: "after", upsert: true }
    );

    return reply.code(201).send(successResponse(assignment, "Doctor assigned to clinic successfully"));
  } catch (err) {
    console.error("assignDoctor error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getDoctorAssignments(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    const userRole = req.user?.role;
    const { doctorId, clinicId } = req.query as { doctorId?: string; clinicId?: string };

    const query: any = { isActive: true };

    if (orgId && userRole !== "patient") {
      query.organizationId = orgId;
    }
    if (doctorId && mongoose.Types.ObjectId.isValid(doctorId)) {
      query.doctorId = doctorId;
    }
    if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) {
      query.clinicId = clinicId;
    }

    if (!orgId && !doctorId && !clinicId && userRole !== "patient") {
      return reply.code(400).send(errorResponse("You are not linked to any organization"));
    }

    const assignments = await DoctorAssignment.find(query)
      .populate("doctorId", "name email phone")
      .populate("clinicId", "name city address");

    return reply.code(200).send(successResponse(assignments));
  } catch (err) {
    console.error("getDoctorAssignments error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateAssignment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid assignment ID"));
    }

    const { workingHours, fees, appointmentDuration, bookingMode, maxDailyTokens } = req.body as {
      workingHours?: string; fees?: number; appointmentDuration?: number;
      bookingMode?: "time_slot" | "sequential_queue"; maxDailyTokens?: number | null;
    };

    const query: any = { _id: id };
    if (orgId) query.organizationId = orgId;

    const assignment = await DoctorAssignment.findOne(query);
    if (!assignment) return reply.code(404).send(errorResponse("Doctor assignment not found"));

    const updateFields: any = {};
    if (workingHours !== undefined) updateFields.workingHours = workingHours;
    if (fees !== undefined) updateFields.fees = fees;
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
    const orgId = req.user?.organization_id;
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
