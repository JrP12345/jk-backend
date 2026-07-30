import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { ImagingStudy } from "../models/ImagingStudy.ts";
import { Patient } from "../models/Patient.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";

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

    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    const studyInstanceUid = `1.2.840.113619.2.55.3.${Date.now()}.${Math.floor(Math.random() * 100000)}`;

    const study = await ImagingStudy.create({
      studyInstanceUid,
      patientId,
      clinicId,
      modality,
      studyDescription: studyDescription.trim(),
      dicomWebUrl: dicomWebUrl?.trim() || `https://pacs.healthos.demo/wado?studyUID=${studyInstanceUid}`,
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
    if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) filter.clinicId = clinicId;
    if (patientId && mongoose.Types.ObjectId.isValid(patientId)) filter.patientId = patientId;
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
