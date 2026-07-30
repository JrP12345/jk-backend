import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { PreAuthorization } from "../models/PreAuthorization.ts";
import { Patient } from "../models/Patient.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { getNextAtomicSequence } from "../models/Counter.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";

export async function createPreAuthRequest(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const {
      patientId, clinicId, doctorId, tpaName, policyNumber, diagnosisCode, proposedTreatment, requestedAmount
    } = req.body as {
      patientId: string;
      clinicId: string;
      doctorId: string;
      tpaName: string;
      policyNumber: string;
      diagnosisCode: string;
      proposedTreatment: string;
      requestedAmount: number;
    };

    if (!patientId || !clinicId || !doctorId || !tpaName || !policyNumber || !diagnosisCode || !proposedTreatment || requestedAmount === undefined) {
      return reply.code(400).send(errorResponse("patientId, clinicId, doctorId, tpaName, policyNumber, diagnosisCode, proposedTreatment, and requestedAmount are required"));
    }

    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    const currentYear = new Date().getFullYear();
    const seq = await getNextAtomicSequence(`preauth_${clinicId}_${currentYear}`);
    const preAuthNumber = `PA-${currentYear}-${seq.toString().padStart(5, "0")}`;

    const preAuth = await PreAuthorization.create({
      preAuthNumber,
      patientId,
      clinicId,
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
    const { clinicId, status, tpaName, search, page, limit } = req.query as any;
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const filter: any = {};
    if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) filter.clinicId = clinicId;
    if (status) filter.status = status;
    if (tpaName) filter.tpaName = new RegExp(tpaName, "i");

    if (search) {
      filter.$or = [
        { preAuthNumber: new RegExp(search, "i") },
        { policyNumber: new RegExp(search, "i") },
        { diagnosisCode: new RegExp(search, "i") },
      ];
    }

    const totalCount = await PreAuthorization.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);

    const preAuths = await PreAuthorization.find(filter)
      .populate("clinicId", "name city")
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
