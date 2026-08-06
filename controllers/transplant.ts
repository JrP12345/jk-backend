import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { TransplantCase } from "../models/TransplantCase.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, getRequestOrganizationId } from "../utilities/tenant.ts";

export async function getTransplantCases(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const { clinicId, organType, caseRole, matchStatus, bloodGroup } = req.query as {
      clinicId?: string;
      organType?: string;
      caseRole?: string;
      matchStatus?: string;
      bloodGroup?: string;
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

    if (organType && organType !== "ALL") query.organType = organType;
    if (caseRole && caseRole !== "ALL") query.caseRole = caseRole;
    if (matchStatus && matchStatus !== "ALL") query.matchStatus = matchStatus;
    if (bloodGroup && bloodGroup !== "ALL") query.bloodGroup = bloodGroup;

    const cases = await TransplantCase.find(query).sort({ urgencyScore: -1, createdAt: -1 });

    // Calculate KPI metrics
    const totalCases = cases.length;
    const recipientCount = cases.filter((c) => c.caseRole === "recipient_waitlist").length;
    const donorCount = cases.filter((c) => c.caseRole === "donor_registered").length;
    const activeMatchesCount = cases.filter((c) =>
      ["potential_match_found", "crossmatch_verified", "transplant_scheduled"].includes(c.matchStatus)
    ).length;
    const criticalUrgencyCount = cases.filter((c) => c.urgencyScore >= 25).length;

    return reply.code(200).send(
      successResponse({
        cases,
        metrics: {
          totalCases,
          recipientCount,
          donorCount,
          activeMatchesCount,
          criticalUrgencyCount,
        },
      })
    );
  } catch (err) {
    console.error("getTransplantCases error:", err);
    return reply.code(500).send(errorResponse("Internal server error fetching transplant registry cases"));
  }
}

export async function createTransplantCase(req: FastifyRequest, reply: FastifyReply) {
  try {
    const user = (req as any).user;
    const {
      clinicId,
      caseNumber,
      patientName,
      organType,
      caseRole,
      bloodGroup,
      hlaTyping,
      urgencyScore,
      matchStatus,
      donorHospital,
      preservationTimeHours,
      leadSurgeon,
      notes,
    } = req.body as any;

    if (!clinicId || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("clinicId is required"));
    }
    const scope = await checkClinicAccess(req, clinicId);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const targetClinicId = clinicId;

    if (!patientName || !bloodGroup || !hlaTyping?.trim() || !donorHospital?.trim() || !leadSurgeon?.trim()) {
      return reply.code(400).send(errorResponse("patientName, bloodGroup, hlaTyping, donorHospital and leadSurgeon are required"));
    }

    const generatedCaseNum = caseNumber || `TXP-${Date.now().toString().slice(-6)}`;

    const newCase = await TransplantCase.create({
      organizationId: scope.organizationId || undefined,
      clinicId: new mongoose.Types.ObjectId(targetClinicId),
      caseNumber: generatedCaseNum,
      patientName,
      organType: organType || "kidney",
      caseRole: caseRole || "recipient_waitlist",
      bloodGroup,
      hlaTyping: hlaTyping.trim(),
      urgencyScore: urgencyScore !== undefined ? Number(urgencyScore) : 15,
      matchStatus: matchStatus || "seeking_match",
      donorHospital: donorHospital.trim(),
      preservationTimeHours: preservationTimeHours !== undefined ? Number(preservationTimeHours) : undefined,
      leadSurgeon: leadSurgeon.trim(),
      notes: notes || "",
    });

    return reply.code(201).send(successResponse(newCase, "Transplant case registered successfully"));
  } catch (err) {
    console.error("createTransplantCase error:", err);
    return reply.code(500).send(errorResponse("Internal server error registering transplant case"));
  }
}

export async function updateMatchStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { matchStatus, urgencyScore, notes } = req.body as {
      matchStatus?: string;
      urgencyScore?: number;
      notes?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid transplant case ID"));
    }

    const item = await TransplantCase.findById(id);
    if (!item || item.deletedAt) {
      return reply.code(404).send(errorResponse("Transplant case not found"));
    }
    const scope = await checkOperationalRecordAccess(req, item);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    if (matchStatus) item.matchStatus = matchStatus as any;
    if (urgencyScore !== undefined) item.urgencyScore = urgencyScore;
    if (notes !== undefined) item.notes = notes;

    await item.save();
    return reply.code(200).send(successResponse(item, "Transplant match status updated successfully"));
  } catch (err) {
    console.error("updateMatchStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error updating transplant match status"));
  }
}

export async function calculateMatch(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { recipientHla, donorHla, recipientBlood, donorBlood } = req.body as {
      recipientHla: string;
      donorHla: string;
      recipientBlood: string;
      donorBlood: string;
    };

    // ABO Compatibility check
    let isBloodCompatible = false;
    if (donorBlood === "O-") isBloodCompatible = true;
    else if (donorBlood === recipientBlood) isBloodCompatible = true;
    else if (recipientBlood === "AB+") isBloodCompatible = true;

    // HLA Antigen Match Score calculation (0 - 100%)
    const recipientTokens = recipientHla ? recipientHla.split(",").map((s) => s.trim().toLowerCase()) : [];
    const donorTokens = donorHla ? donorHla.split(",").map((s) => s.trim().toLowerCase()) : [];

    let sharedAntigens = 0;
    recipientTokens.forEach((r) => {
      if (donorTokens.includes(r)) sharedAntigens++;
    });

    if (recipientTokens.length === 0 || donorTokens.length === 0) {
      return reply.code(400).send(errorResponse("recipientHla and donorHla must contain at least one allele"));
    }

    const matchPercentage = Math.round((sharedAntigens / recipientTokens.length) * 100);

    return reply.code(200).send(
      successResponse({
        isBloodCompatible,
        sharedAntigens,
        matchPercentage,
        compatibilityVerdict: isBloodCompatible && matchPercentage >= 50 ? "COMPATIBLE_HIGH_MATCH" : "CROSSMATCH_REQUIRED",
      })
    );
  } catch (err) {
    console.error("calculateMatch error:", err);
    return reply.code(500).send(errorResponse("Internal server error computing tissue compatibility match"));
  }
}

export async function deleteTransplantCase(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid transplant case ID"));
    }

    const item = await TransplantCase.findById(id);
    if (!item || item.deletedAt) {
      return reply.code(404).send(errorResponse("Transplant case not found"));
    }
    const scope = await checkOperationalRecordAccess(req, item);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    item.deletedAt = new Date();
    await item.save();

    return reply.code(200).send(successResponse(item, "Transplant case deleted successfully"));
  } catch (err) {
    console.error("deleteTransplantCase error:", err);
    return reply.code(500).send(errorResponse("Internal server error deleting transplant case"));
  }
}
