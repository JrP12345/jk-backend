import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { PreAuthorization } from "../models/PreAuthorization.ts";
import { Patient } from "../models/Patient.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { getNextAtomicSequence } from "../models/Counter.ts";
import { successResponse, errorResponse, escapeRegex, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { checkLocationAccess, checkOperationalRecordAccess, getRequestLocationIds, resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";

function sendTenantError(reply: FastifyReply, check: { allowed: false; statusCode: number; message: string }) {
  return reply.code(check.statusCode).send(errorResponse(check.message));
}

export async function createPreAuthRequest(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const {
      patientId, locationId, doctorId, tpaName, policyNumber, diagnosisCode, proposedTreatment, requestedAmount
    } = req.body as {
      patientId: string;
      locationId: string;
      doctorId: string;
      tpaName: string;
      policyNumber: string;
      diagnosisCode: string;
      proposedTreatment: string;
      requestedAmount: number;
    };

    if (!patientId || !locationId || !doctorId || !tpaName || !policyNumber || !diagnosisCode || !proposedTreatment || requestedAmount === undefined) {
      return reply.code(400).send(errorResponse("patientId, locationId, doctorId, tpaName, policyNumber, diagnosisCode, proposedTreatment, and requestedAmount are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(patientId) || !mongoose.Types.ObjectId.isValid(locationId) || !mongoose.Types.ObjectId.isValid(doctorId)) {
      return reply.code(400).send(errorResponse("Invalid patient, location, or doctor ID"));
    }
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      return reply.code(400).send(errorResponse("requestedAmount must be greater than zero"));
    }
    const locationAccess = await checkLocationAccess(req, locationId);
    if (!locationAccess.allowed) return sendTenantError(reply, locationAccess);

    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }
    if (patient.organizationId && locationAccess.organizationId && patient.organizationId.toString() !== locationAccess.organizationId) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    const currentYear = new Date().getFullYear();
    const seq = await getNextAtomicSequence(`preauth_${locationId}_${currentYear}`);
    const preAuthNumber = `PA-${currentYear}-${seq.toString().padStart(5, "0")}`;

    const preAuth = await PreAuthorization.create({
      organizationId: locationAccess.organizationId,
      preAuthNumber,
      patientId,
      locationId,
      doctorId,
      tpaName: tpaName.trim(),
      policyNumber: policyNumber.trim(),
      diagnosisCode: diagnosisCode.trim(),
      proposedTreatment: proposedTreatment.trim(),
      requestedAmount,
      approvedAmount: 0,
      status: "submitted",
    });

    await AuditLog.create({
      userId,
      action: "PRE_AUTH_SUBMIT",
      targetId: preAuth._id,
      targetModel: "PreAuthorization",
      details: { preAuthNumber, requestedAmount, tpaName }
    });

    return reply.code(201).send(successResponse(preAuth, "Pre-authorization cashless request submitted to TPA"));
  } catch (err) {
    console.error("createPreAuthRequest error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getPreAuthList(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { locationId, status, tpaName, search, page, limit } = req.query as any;
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const filter: any = {};
    if (locationId) {
      if (!mongoose.Types.ObjectId.isValid(locationId)) return reply.code(400).send(errorResponse("Invalid location ID"));
      const locationAccess = await checkLocationAccess(req, locationId);
      if (!locationAccess.allowed) return sendTenantError(reply, locationAccess);
      filter.locationId = locationId;
    } else {
      const locationIds = await getRequestLocationIds(req);
      if (locationIds) filter.locationId = { $in: locationIds };
    }
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return sendTenantError(reply, scope);
    if (scope.organizationId && req.user?.role !== "root") filter.organizationId = scope.organizationId;
    if (status) filter.status = status;
    if (tpaName) filter.tpaName = new RegExp(escapeRegex(tpaName.slice(0, 200)), "i");

    if (search) {
      filter.$or = [
        { preAuthNumber: new RegExp(escapeRegex(search.slice(0, 200)), "i") },
        { policyNumber: new RegExp(escapeRegex(search.slice(0, 200)), "i") },
        { diagnosisCode: new RegExp(escapeRegex(search.slice(0, 200)), "i") },
      ];
    }

    const totalCount = await PreAuthorization.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);

    const preAuths = await PreAuthorization.find(filter)
      .populate("locationId", "name city")
      .populate("doctorId", "name specialization")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(preAuths));
  } catch (err) {
    console.error("getPreAuthList error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updatePreAuthStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { id } = req.params as { id: string };
    const { status, approvedAmount, approvalCode, queryNotes, denialReason } = req.body as {
      status: "draft" | "submitted" | "under_query" | "approved" | "rejected" | "cancelled";
      approvedAmount?: number;
      approvalCode?: string;
      queryNotes?: string;
      denialReason?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid PreAuth ID"));
    }

    const preAuth = await PreAuthorization.findById(id);
    if (!preAuth) {
      return reply.code(404).send(errorResponse("Pre-authorization request not found"));
    }
    const preAuthAccess = await checkOperationalRecordAccess(req, preAuth);
    if (!preAuthAccess.allowed) return sendTenantError(reply, preAuthAccess);
    if (!["admin", "receptionist", "cashier", "root"].includes(req.user?.role || "")) {
      return reply.code(403).send(errorResponse("Only billing staff can update pre-authorization status"));
    }
    const allowedTransitions: Record<string, string[]> = {
      draft: ["submitted", "cancelled"],
      submitted: ["under_query", "approved", "rejected", "cancelled"],
      under_query: ["submitted", "approved", "rejected", "cancelled"],
      approved: ["cancelled"],
      rejected: [],
      cancelled: [],
    };
    if (!allowedTransitions[preAuth.status]?.includes(status)) {
      return reply.code(400).send(errorResponse(`Cannot transition pre-authorization from ${preAuth.status} to ${status}`));
    }
    if (approvedAmount !== undefined && (!Number.isFinite(approvedAmount) || approvedAmount < 0 || approvedAmount > preAuth.requestedAmount)) {
      return reply.code(400).send(errorResponse("approvedAmount must be non-negative and no greater than requestedAmount"));
    }

    preAuth.status = status;
    if (approvedAmount !== undefined) preAuth.approvedAmount = approvedAmount;
    if (approvalCode) preAuth.approvalCode = approvalCode.trim();
    if (queryNotes) preAuth.queryNotes = queryNotes.trim();
    if (denialReason) preAuth.denialReason = denialReason.trim();

    if (status === "approved" && !preAuth.validUntil) {
      const validDate = new Date();
      validDate.setDate(validDate.getDate() + 30); // 30-day approval validity
      preAuth.validUntil = validDate;
    }

    await preAuth.save();

    await AuditLog.create({
      userId,
      action: "PRE_AUTH_STATUS_UPDATE",
      targetId: preAuth._id,
      targetModel: "PreAuthorization",
      details: { preAuthNumber: preAuth.preAuthNumber, status, approvedAmount }
    });

    return reply.code(200).send(successResponse(preAuth, `Pre-authorization status updated to ${status}`));
  } catch (err) {
    console.error("updatePreAuthStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
