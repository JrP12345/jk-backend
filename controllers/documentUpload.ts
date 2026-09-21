import type { FastifyRequest, FastifyReply } from "fastify";
import { DocumentUpload } from "../models/DocumentUpload.ts";
import { Patient } from "../models/Patient.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { logger } from "../utilities/logger.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkPatientAccess } from "../utilities/tenant.ts";

export const uploadDocument = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const { patientId, category, fileName, fileUrl, mimeType, fileSizeBytes } = req.body as any;
    const userId = (req as any).user?.id || (req as any).user?._id;
    const tenantCheck = await checkPatientAccess(req, patientId);
    if (!tenantCheck.allowed) {
      return reply.code(tenantCheck.statusCode).send(errorResponse(tenantCheck.message));
    }

    if (!patientId || !fileUrl || !fileName || !mimeType) {
      return reply.code(400).send(errorResponse("Missing required fields: patientId, fileUrl, fileName, mimeType"));
    }

    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient not found"));
    }

    const organizationId = patient.organizationId || tenantCheck.organizationId;
    if (!organizationId) {
      return reply.code(409).send(errorResponse("Patient organization context is required"));
    }

    const doc = await DocumentUpload.create({
      patientId,
      organizationId,
      uploadedByUserId: userId,
      fileName,
      fileUrl,
      fileSizeBytes: fileSizeBytes || 0,
      mimeType,
      category: category || "OTHER",
      ocrStatus: "pending",
      uploadedAt: new Date(),
    });

    // Emit domain event for asynchronous OCR & vision extraction pipeline
    await eventBus.publishDurable({
      eventType: EVENT_TYPES.DOCUMENT_UPLOADED,
      category: "clinical",
      organizationId: organizationId.toString(),
      createdBy: userId ? userId.toString() : undefined,
      title: "Medical Document Uploaded",
      message: `Document '${fileName}' uploaded for patient ${patientId}`,
      metadata: {
        documentId: doc.id,
        patientId,
        category: doc.category,
        fileUrl,
      },
    });

    logger.info("Medical document uploaded successfully", {
      tenantId: organizationId.toString(),
      userId: userId ? userId.toString() : undefined,
    });

    return reply.code(201).send(successResponse(doc, "Document uploaded successfully"));
  } catch (err: any) {
    logger.error("Failed to upload medical document", { errMessage: err.message } as any);
    return reply.code(500).send(errorResponse("Internal server error uploading document"));
  }
};

export const getPatientDocuments = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const { patientId } = req.params as { patientId: string };

    const tenantCheck = await checkPatientAccess(req, patientId);
    if (!tenantCheck.allowed) {
      return reply.code(tenantCheck.statusCode).send(errorResponse(tenantCheck.message));
    }

    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient not found"));
    }

    const documentScope = patient.organizationId
      ? { patientId, organizationId: patient.organizationId }
      : tenantCheck.organizationId
        ? { patientId, organizationId: tenantCheck.organizationId }
        : { _id: null };
    const docs = await DocumentUpload.find(documentScope).sort({ uploadedAt: -1 }).lean();

    return reply.code(200).send(successResponse(docs));
  } catch (err: any) {
    logger.error("Failed to fetch patient documents", { errMessage: err.message } as any);
    return reply.code(500).send(errorResponse("Internal server error fetching documents"));
  }
};
