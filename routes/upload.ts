import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { generatePresignedUrl, generatePresignedDownloadUrl, getObjectBuffer, uploadBase64ToR2 } from '../utilities/r2.ts';
import { authenticate } from '../middleware/auth.ts';
import { UploadIntent, type ContentClass } from '../models/UploadIntent.ts';
import { detectMagicBytes, scanForActiveMaliciousContent } from '../utilities/fileSecurity.ts';
import { successResponse, errorResponse } from '../utilities/helpers.ts';
import { logger } from '../utilities/logger.ts';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/dicom',
  'text/plain',
  'text/csv',
]);

const CLASS_MAX_BYTES: Record<ContentClass, number> = {
  avatar: 2 * 1024 * 1024, // 2MB
  prescription: 10 * 1024 * 1024, // 10MB
  clinical_document: 25 * 1024 * 1024, // 25MB
  lab_report: 25 * 1024 * 1024, // 25MB
  radiology: 50 * 1024 * 1024, // 50MB
  other: 10 * 1024 * 1024, // 10MB
};

export default async function uploadRoutes(fastify: FastifyInstance) {
  // ─── 1. Create UploadIntent (Secured & Private Vault) ─────────────────
  fastify.post('/api/uploads/intent', { preHandler: [authenticate] }, async (req, reply) => {
    try {
      const { originalFilename, contentType, contentClass = "clinical_document", patientId } = req.body as {
        originalFilename: string;
        contentType: string;
        contentClass?: ContentClass;
        patientId?: string;
      };

      const userId = req.user?.id;
      const organizationId = req.user?.organization_id;
      if (!organizationId) {
        return reply.code(400).send(errorResponse("Organization ID context is missing"));
      }

      if (!originalFilename || !contentType) {
        return reply.code(400).send(errorResponse("originalFilename and contentType are required"));
      }

      const normalizedMime = contentType.toLowerCase().trim();
      if (!ALLOWED_MIME_TYPES.has(normalizedMime)) {
        return reply.code(400).send(errorResponse(`Unsupported or unsafe content type: ${contentType}`));
      }

      const maxSizeBytes = CLASS_MAX_BYTES[contentClass] || CLASS_MAX_BYTES.clinical_document;
      const { uploadUrl, fileKey } = await generatePresignedUrl(originalFilename, normalizedMime, organizationId, maxSizeBytes);

      const intent = await UploadIntent.create({
        organizationId: new mongoose.Types.ObjectId(organizationId),
        userId: new mongoose.Types.ObjectId(userId),
        patientId: patientId && mongoose.Types.ObjectId.isValid(patientId) ? new mongoose.Types.ObjectId(patientId) : undefined,
        objectKey: fileKey,
        originalFileName: originalFilename,
        contentClass,
        permittedMimeTypes: [normalizedMime],
        maxSizeBytes,
        status: "pending",
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 min intent lifespan
      });

      return reply.code(201).send(successResponse({
        intentId: intent._id,
        uploadUrl,
        objectKey: fileKey,
        maxSizeBytes,
        expiresAt: intent.expiresAt,
      }, "Upload intent created"));
    } catch (err: any) {
      logger.error("Failed to create upload intent", { errMessage: err.message } as any);
      return reply.code(500).send(errorResponse("Failed to create upload intent"));
    }
  });

  // ─── 2. Complete & Verify Upload (Magic Bytes & Malware Scanning) ─────
  fastify.post('/api/uploads/verify', { preHandler: [authenticate] }, async (req, reply) => {
    try {
      const { intentId } = req.body as { intentId: string };
      const organizationId = req.user?.organization_id;

      if (!intentId || !mongoose.Types.ObjectId.isValid(intentId)) {
        return reply.code(400).send(errorResponse("Invalid intentId"));
      }

      const intent = await UploadIntent.findOne({
        _id: intentId,
        organizationId,
      });

      if (!intent) {
        return reply.code(404).send(errorResponse("Upload intent not found"));
      }

      if (intent.status === "completed") {
        return reply.code(200).send(successResponse(intent, "Upload intent already verified"));
      }

      if (new Date(intent.expiresAt).getTime() < Date.now()) {
        intent.status = "expired";
        await intent.save();
        return reply.code(400).send(errorResponse("Upload intent has expired"));
      }

      // Download buffer from storage to verify magic bytes and scan content
      let buffer: Buffer;
      try {
        buffer = await getObjectBuffer(intent.objectKey);
      } catch (fetchErr: any) {
        return reply.code(400).send(errorResponse("Object not found in storage. Ensure file was uploaded to presigned URL first."));
      }

      // Verify size constraints
      if (buffer.length > intent.maxSizeBytes) {
        intent.status = "rejected";
        intent.rejectionReason = `File exceeds maximum allowed size of ${intent.maxSizeBytes} bytes`;
        await intent.save();
        return reply.code(400).send(errorResponse(intent.rejectionReason));
      }

      // Verify magic bytes (file signature)
      const detectedMime = detectMagicBytes(buffer);
      if (!detectedMime) {
        intent.status = "quarantined";
        intent.rejectionReason = "Unable to determine binary file signature";
        await intent.save();
        return reply.code(400).send(errorResponse("File rejected: Unknown or invalid binary header"));
      }

      // Scan for malware, script injection, active SVG/HTML
      const scanResult = scanForActiveMaliciousContent(buffer);
      if (!scanResult.clean) {
        intent.status = "rejected";
        intent.rejectionReason = scanResult.threat;
        await intent.save();
        return reply.code(400).send(errorResponse(`File rejected by security scanner: ${scanResult.threat}`));
      }

      intent.status = "completed";
      intent.actualSizeBytes = buffer.length;
      intent.actualMimeType = detectedMime;
      intent.magicBytesVerified = true;
      intent.malwareClean = true;
      await intent.save();

      return reply.code(200).send(successResponse({
        intentId: intent._id,
        objectKey: intent.objectKey,
        status: "completed",
        actualSizeBytes: buffer.length,
        detectedMime,
      }, "File verified and accepted into secure vault"));
    } catch (err: any) {
      logger.error("Failed to verify upload intent", { errMessage: err.message } as any);
      return reply.code(500).send(errorResponse("Failed to verify upload"));
    }
  });

  // ─── 3. Authorize & Generate Presigned Download URL ─────────────────
  fastify.get('/api/uploads/download/:intentId', { preHandler: [authenticate] }, async (req, reply) => {
    try {
      const { intentId } = req.params as { intentId: string };
      const organizationId = req.user?.organization_id;

      if (!intentId || !mongoose.Types.ObjectId.isValid(intentId)) {
        return reply.code(400).send(errorResponse("Invalid intentId"));
      }

      const intent = await UploadIntent.findById(intentId);
      if (!intent) {
        return reply.code(404).send(errorResponse("Upload intent not found"));
      }

      // Tenant isolation: verify access
      if (req.user?.role !== "root" && intent.organizationId.toString() !== organizationId) {
        return reply.code(403).send(errorResponse("Forbidden: Cross-tenant download access denied"));
      }

      if (intent.status !== "completed") {
        return reply.code(403).send(errorResponse(`Cannot download file: intent status is ${intent.status}`));
      }

      // Generate authorization-checked short-lived URL (300 seconds)
      const downloadUrl = await generatePresignedDownloadUrl(intent.objectKey, 300);

      return reply.code(200).send(successResponse({
        downloadUrl,
        expiresInSeconds: 300,
        fileName: intent.originalFileName,
        mimeType: intent.actualMimeType,
      }, "Presigned download URL generated"));
    } catch (err: any) {
      logger.error("Failed to generate download URL", { errMessage: err.message } as any);
      return reply.code(500).send(errorResponse("Failed to generate download URL"));
    }
  });

  // ─── Backward-Compatible Legacy Endpoints ─────────────────────────
  fastify.post('/get-upload-url', { preHandler: [authenticate] }, async (request, reply) => {
    const { contentType, originalFilename } = request.body as { contentType: string; originalFilename: string };
    if (!contentType || !originalFilename) return reply.code(400).send({ error: 'Missing required fields' });
    const orgId = request.user?.organization_id;
    const { uploadUrl, fileKey } = await generatePresignedUrl(originalFilename, contentType, orgId);
    return reply.send({ success: true, data: { uploadUrl, fileKey, publicUrl: uploadUrl } });
  });

  fastify.post('/upload-base64', { preHandler: [authenticate] }, async (request, reply) => {
    const body = (request.body || {}) as any;
    const contentType = body.contentType || 'image/png';
    const originalFilename = body.originalFilename || body.fileName || `file-${Date.now()}.png`;
    const base64Data = body.base64Data || body.base64;
    if (!base64Data) return reply.code(400).send({ error: 'Missing base64 data' });
    const orgId = request.user?.organization_id;
    const { fileKey } = await uploadBase64ToR2(base64Data, originalFilename, contentType, orgId);
    return reply.send({ success: true, data: { fileKey, publicUrl: fileKey, url: fileKey } });
  });
}
