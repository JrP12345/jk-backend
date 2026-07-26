import type { FastifyRequest, FastifyReply } from "fastify";
import { DocumentUpload } from "../models/DocumentUpload.ts";
import { Patient } from "../models/Patient.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { logger } from "../utilities/logger.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export const uploadDocument = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const { patientId, category, fileName, fileUrl, mimeType, fileSizeBytes } = req.body as any;
    const userId = (req as any).user?.id || (req as any).user?._id;
    const tenantId = (req as any).user?.organization_id || (req as any).user?.organizationId;

    if (!patientId || !fileUrl || !fileName || !mimeType) {
      return reply.code(400).send(errorResponse("Missing required fields: patientId, fileUrl, fileName, mimeType"));
    }

    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient not found"));
    }

    const doc = await DocumentUpload.create({
      patientId,
      organizationId: tenantId || patient.organizationId,
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
    eventBus.publish({
      eventType: EVENT_TYPES.DOCUMENT_UPLOADED,
      category: "clinical",
      organizationId: tenantId ? tenantId.toString() : undefined,
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
      tenantId: tenantId ? tenantId.toString() : undefined,
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

    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient not found"));
    }

    const docs = await DocumentUpload.find({ patientId }).sort({ uploadedAt: -1 }).lean();

    return reply.code(200).send(successResponse(docs));
  } catch (err: any) {
    logger.error("Failed to fetch patient documents", { errMessage: err.message } as any);
    return reply.code(500).send(errorResponse("Internal server error fetching documents"));
  }
};
