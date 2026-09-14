import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { ImagingStudy } from "../models/ImagingStudy.ts";
import { Patient } from "../models/Patient.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, checkPatientAccess, getRequestClinicIds } from "../utilities/tenant.ts";

function sendTenantError(reply: FastifyReply, check: { allowed: false; statusCode: number; message: string }) {
  return reply.code(check.statusCode).send(errorResponse(check.message));
}

export async function createImagingStudy(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { patientId, clinicId, modality, studyDescription, dicomWebUrl } = req.body as {
      patientId: string;
      clinicId: string;
      modality: "CR" | "DX" | "CT" | "MR" | "US" | "MG";
      studyDescription: string;
      dicomWebUrl?: string;
    };

    if (!patientId || !clinicId || !modality || !studyDescription) {
      return reply.code(400).send(errorResponse("patientId, clinicId, modality, and studyDescription are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(patientId) || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("Invalid patient or clinic ID"));
    }

    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);

    const patient = await Patient.findById(patientId).setOptions({ bypassTenantFilter: true });
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }
    if (patient.organizationId && clinicAccess.organizationId && patient.organizationId.toString() !== clinicAccess.organizationId) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }
    if (!patient.organizationId && clinicAccess.organizationId) {
      patient.organizationId = new mongoose.Types.ObjectId(clinicAccess.organizationId);
      await patient.save();
    }

    const studyInstanceUid = `1.2.840.113619.2.55.3.${Date.now()}.${Math.floor(Math.random() * 100000)}`;
    const configuredPacsUrl = dicomWebUrl?.trim() || process.env.PACS_BASE_URL?.trim();
    if (!configuredPacsUrl && process.env.NODE_ENV !== "test") {
      return reply.code(503).send(errorResponse("PACS/DICOM service is not configured; imaging study was not registered"));
    }
    if (configuredPacsUrl) {
      try {
        const parsed = new URL(configuredPacsUrl);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Unsupported PACS URL protocol");
      } catch {
        return reply.code(400).send(errorResponse("Invalid PACS/DICOM URL"));
      }
    }

    const study = await ImagingStudy.create({
      studyInstanceUid,
      patientId,
      clinicId,
      modality,
      studyDescription: studyDescription.trim(),
      dicomWebUrl: configuredPacsUrl
        ? `${configuredPacsUrl.replace(/\/$/, "")}?studyUID=${encodeURIComponent(studyInstanceUid)}`
        : undefined,
      status: "requested",
    });

    await AuditLog.create({
      userId,
      action: "PACS_STUDY_CREATE",
      targetId: study._id,
      targetModel: "ImagingStudy",
      details: { studyInstanceUid, modality, studyDescription }
    });

    return reply.code(201).send(successResponse(study, "PACS DICOM imaging study registered successfully"));
  } catch (err) {
    console.error("createImagingStudy error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getImagingStudies(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, patientId, modality, page, limit } = req.query as any;
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const filter: any = {};
    if (clinicId) {
      if (!mongoose.Types.ObjectId.isValid(clinicId)) return reply.code(400).send(errorResponse("Invalid clinic ID"));
      const clinicAccess = await checkClinicAccess(req, clinicId);
      if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);
      filter.clinicId = clinicId;
    } else {
      const clinicIds = await getRequestClinicIds(req);
      if (clinicIds) filter.clinicId = { $in: clinicIds };
    }
    if (patientId) {
      if (!mongoose.Types.ObjectId.isValid(patientId)) return reply.code(400).send(errorResponse("Invalid patient ID"));
      const patientAccess = await checkPatientAccess(req, patientId);
      if (!patientAccess.allowed) return sendTenantError(reply, patientAccess);
      filter.patientId = patientId;
    }
    if (modality) filter.modality = modality;

    const totalCount = await ImagingStudy.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);

    const studies = await ImagingStudy.find(filter)
      .populate("clinicId", "name city")
      .populate("radiologistId", "name specialization")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name phone" }
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(studies));
  } catch (err) {
    console.error("getImagingStudies error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function signRadiologyReport(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { id } = req.params as { id: string };
    const { radiologyReport } = req.body as { radiologyReport: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid Imaging Study ID"));
    }

    if (!radiologyReport || !radiologyReport.trim()) {
      return reply.code(400).send(errorResponse("radiologyReport text is required"));
    }

    const study = await ImagingStudy.findById(id);
    if (!study) {
      return reply.code(404).send(errorResponse("Imaging study not found"));
    }
    const studyAccess = await checkOperationalRecordAccess(req, study);
    if (!studyAccess.allowed) return sendTenantError(reply, studyAccess);
    if (["reported", "cancelled"].includes(study.status)) {
      return reply.code(400).send(errorResponse(`Cannot sign a report for an imaging study in ${study.status} state`));
    }

    study.radiologyReport = radiologyReport.trim();
    study.radiologistId = new mongoose.Types.ObjectId(userId);
    study.status = "reported";
    await study.save();

    await AuditLog.create({
      userId,
      action: "RADIOLOGY_REPORT_SIGN",
      targetId: study._id,
      targetModel: "ImagingStudy",
      details: { studyInstanceUid: study.studyInstanceUid, modality: study.modality }
    });

    return reply.code(200).send(successResponse(study, "Radiology report signed and attached to study"));
  } catch (err) {
    console.error("signRadiologyReport error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateImagingStudyStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { id } = req.params as { id: string };
    const { status } = req.body as { status: "requested" | "in_progress" | "completed" | "reported" | "cancelled" };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid Imaging Study ID"));
    }

    if (!status || !["requested", "in_progress", "completed", "reported", "cancelled"].includes(status)) {
      return reply.code(400).send(errorResponse("Valid status (requested, in_progress, completed, reported, cancelled) is required"));
    }

    const study = await ImagingStudy.findById(id);
    if (!study) {
      return reply.code(404).send(errorResponse("Imaging study not found"));
    }
    const studyAccess = await checkOperationalRecordAccess(req, study);
    if (!studyAccess.allowed) return sendTenantError(reply, studyAccess);

    const allowedTransitions: Record<string, string[]> = {
      requested: ["in_progress", "cancelled", "reported"],
      in_progress: ["completed", "cancelled", "reported"],
      completed: ["reported"],
      reported: [],
      cancelled: [],
    };
    if (!(allowedTransitions[study.status] || []).includes(status)) {
      return reply.code(400).send(errorResponse(`Cannot transition imaging study from ${study.status} to ${status}`));
    }

    study.status = status;
    await study.save();

    await AuditLog.create({
      userId,
      action: "PACS_STUDY_STATUS_UPDATE",
      targetId: study._id,
      targetModel: "ImagingStudy",
      details: { studyInstanceUid: study.studyInstanceUid, status }
    });

    return reply.code(200).send(successResponse(study, `Imaging study status updated to ${status}`));
  } catch (err) {
    console.error("updateImagingStudyStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
