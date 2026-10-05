import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { DocumentUpload } from "../models/DocumentUpload.ts";
import { Patient } from "../models/Patient.ts";
import { UploadIntent } from "../models/UploadIntent.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { generatePresignedDownloadUrl } from "../utilities/r2.ts";
import { authorizeUpload } from "../utilities/uploadPolicy.ts";
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



export const uploadDocument = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const { patientId, category = 'OTHER', uploadIntentId } = req.body as any;
    if (!['LAB_REPORT', 'PRESCRIPTION', 'RADIOLOGY_SCAN', 'DISCHARGE_SUMMARY', 'VACCINATION_RECORD', 'DENTAL_RECORD', 'OPHTHALMIC_RECORD', 'OTHER'].includes(category)) return reply.code(400).send(errorResponse('Invalid document category'));
    const userId = req.user!.id;
    if (typeof uploadIntentId !== 'string' || !mongoose.Types.ObjectId.isValid(uploadIntentId)) {
      return reply.code(400).send(errorResponse('A verified uploadIntentId is required'));
    }
    const authority = await authorizeUpload(req, patientId);
    if (!authority.allowed) return reply.code(authority.statusCode).send(errorResponse(authority.message));
    const patient = await Patient.findById(patientId).select('organizationId').lean();
    const organizationId = patient?.organizationId || authority.organizationId;
    if (!organizationId) return reply.code(409).send(errorResponse('Patient organization context is required'));
    const doc = await withTransaction(async (session) => {
      const docId = new mongoose.Types.ObjectId();
      const intent = await UploadIntent.findOneAndUpdate({
        _id: uploadIntentId, organizationId, patientId, userId, status: 'completed',
        magicBytesVerified: true, $or: [{ contentValidationPassed: true }, { malwareClean: true }], registeredDocumentId: { $exists: false },
      }, { $set: { registeredDocumentId: docId } }, { returnDocument: 'after', session });
      if (!intent) throw Object.assign(new Error('Verified upload is unavailable or already registered'), { statusCode: 409 });
      const created = await createWithSession(DocumentUpload, {
        _id: docId, patientId, organizationId, uploadedByUserId: userId,
        fileName: intent.originalFileName, fileUrl: intent.objectKey, mimeType: intent.actualMimeType,
        fileSizeBytes: intent.actualSizeBytes, category, ocrStatus: 'pending', uploadedAt: new Date(),
      }, session);
      await eventBus.publishDurable({
        eventId: 'document-upload:' + docId.toString(), eventType: EVENT_TYPES.DOCUMENT_UPLOADED,
        category: 'clinical', organizationId: organizationId.toString(), createdBy: userId,
        title: 'Medical Document Uploaded', message: 'A verified medical document was uploaded',
        metadata: { documentId: created.id, patientId, category: created.category, fileUrl: intent.objectKey },
      }, session);
      return created;
    });

    logger.info("Medical document uploaded successfully", {
      tenantId: organizationId.toString(),
      userId: userId ? userId.toString() : undefined,
    });

    return reply.code(201).send(successResponse(doc, "Document uploaded successfully"));
  } catch (err: any) {
    logger.error("Failed to upload medical document", { errMessage: err.message } as any);
    return reply.code(err.statusCode === 409 ? 409 : 500).send(errorResponse(err.statusCode === 409 ? "Verified upload is unavailable or already registered" : "Internal server error uploading document"));
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
      organizationId: new mongoose.Types.ObjectId(orgId),
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

export async function downloadDocument(req: FastifyRequest, reply: FastifyReply) {
  const { documentId } = req.params as { documentId: string };
  if (!mongoose.Types.ObjectId.isValid(documentId)) return reply.code(400).send(errorResponse('Invalid document ID'));
  const doc = await DocumentUpload.findById(documentId).select('patientId organizationId fileUrl fileName mimeType').lean();
  if (!doc) return reply.code(404).send(errorResponse('Document not found'));
  const authority = await authorizeUpload(req, doc.patientId.toString(), false);
  if (!authority.allowed || authority.organizationId !== doc.organizationId?.toString() ||
      !doc.fileUrl.startsWith('tenants/' + doc.organizationId + '/')) {
    return reply.code(404).send(errorResponse('Document not found'));
  }
  return reply.send(successResponse({ downloadUrl: await generatePresignedDownloadUrl(doc.fileUrl),
    expiresInSeconds: 300, fileName: doc.fileName, mimeType: doc.mimeType }));
}
