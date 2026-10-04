import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { ImagingStudy } from "../models/ImagingStudy.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { checkOperationalRecordAccess } from "../utilities/tenant.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { DicomWebError, getDicomInstances, getDicomFrame } from "../services/dicomWeb.ts";

export async function imagingPreview(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "private, no-store");
  reply.header("X-Content-Type-Options", "nosniff");
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) return reply.code(400).send(errorResponse("Invalid imaging study ID"));
    const study = await ImagingStudy.findById(id);
    if (!study) return reply.code(404).send(errorResponse("Imaging study not found"));
    const access = await checkOperationalRecordAccess(req, study);
    if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
    const { seriesUid, instanceUid, frame } = req.query as { seriesUid?: string; instanceUid?: string; frame?: string };
    if (seriesUid || instanceUid || frame) {
      if (!seriesUid || !instanceUid || !frame) return reply.code(400).send(errorResponse("Complete image identifiers are required"));
      const bytes = await getDicomFrame(study.studyInstanceUid, seriesUid, instanceUid, Number(frame));
      return reply.type("image/png").send(bytes);
    }
    const manifest = await getDicomInstances(study.studyInstanceUid);
    await AuditLog.create({ userId: req.user!.id, action: "PACS_STUDY_VIEW", targetId: study._id, targetModel: "ImagingStudy", details: { preview: true } });
    return reply.send(successResponse(manifest));
  } catch (error) {
    if (error instanceof DicomWebError) return reply.code(error.statusCode).send(errorResponse(error.message));
    console.error("Imaging preview failed", error instanceof Error ? error.name : "Unknown error");
    return reply.code(500).send(errorResponse("Imaging preview could not be loaded"));
  }
}
