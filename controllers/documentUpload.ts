import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { DocumentUpload } from "../models/DocumentUpload.ts";
import { Patient } from "../models/Patient.ts";
import { createTenantRepository } from "../platform/TenantRepository.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { logger } from "../utilities/logger.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkPatientAccess } from "../utilities/tenant.ts";
import {
  getCursorPaginationParams,
  decodeCursor,
  buildCursorFilter,
  formatCursorResult,
} from "../utilities/cursorPagination.ts";

const documentRepo = createTenantRepository(DocumentUpload);

export const uploadDocument = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const { patientId, category, fileName, fileUrl, mimeType, fileSizeBytes, uploadIntentId } = req.body as any;
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

    // Step 2.6: Enforce that document is registered from a valid, completed UploadIntent
    if (uploadIntentId) {
      const { UploadIntent } = await import("../models/UploadIntent.ts");
      if (!mongoose.Types.ObjectId.isValid(uploadIntentId)) {
        return reply.code(400).send(errorResponse("Invalid uploadIntentId format"));
      }
      const intent = await UploadIntent.findOne({ _id: uploadIntentId, organizationId });
      if (!intent) {
        return reply.code(400).send(errorResponse("UploadIntent not found for your organization"));
      }
      if (intent.status !== "completed") {
        return reply.code(400).send(errorResponse(`UploadIntent status is '${intent.status}'. Must be 'completed' before registering document.`));
      }
      if (intent.registeredDocumentId) {
        return reply.code(409).send(errorResponse("UploadIntent already registered to a clinical document"));
      }
    }

    const doc = await documentRepo.create({
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
    }, { organizationId });

    if (uploadIntentId) {
      const { UploadIntent } = await import("../models/UploadIntent.ts");
      await UploadIntent.updateOne({ _id: uploadIntentId }, { $set: { registeredDocumentId: doc._id } });
    }

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
    const query = req.query as { cursor?: string; limit?: string | number; format?: string };

    const tenantCheck = await checkPatientAccess(req, patientId);
    if (!tenantCheck.allowed) {
      return reply.code(tenantCheck.statusCode).send(errorResponse(tenantCheck.message));
    }

    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient not found"));
    }

    const orgId = patient.organizationId || tenantCheck.organizationId;
    if (!orgId) {
      return reply.code(409).send(errorResponse("Organization context missing"));
    }

    // Step 5.3: Cursor pagination with deterministic compound sorting and hard maximum limit
    const pagination = getCursorPaginationParams(query, 20, 100);
    const decoded = decodeCursor(pagination.cursor);
    const cursorFilter = buildCursorFilter(decoded, { timeField: "uploadedAt", sortDirection: "desc" });

    const filter: Record<string, any> = {
      patientId: new mongoose.Types.ObjectId(patientId),
      ...cursorFilter,
    };

    const rawDocs = await DocumentUpload.find(filter)
      .sort({ uploadedAt: -1, _id: -1 })
      .limit(pagination.limit + 1)
      .lean();

    const result = formatCursorResult(rawDocs as any[], pagination.limit, "uploadedAt");

    reply.header("X-Next-Cursor", result.nextCursor || "");
    reply.header("X-Has-Next-Page", String(result.hasNextPage));
    reply.header("X-Page-Limit", String(result.limit));
    reply.header("Access-Control-Expose-Headers", "X-Next-Cursor, X-Has-Next-Page, X-Page-Limit");

    if (query.format === "paginated" || query.cursor) {
      return reply.code(200).send(successResponse(result));
    }

    return reply.code(200).send(successResponse(result.items));
  } catch (err: any) {
    logger.error("Failed to fetch patient documents", { errMessage: err.message } as any);
    return reply.code(500).send(errorResponse("Internal server error fetching documents"));
  }
};
