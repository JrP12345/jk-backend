import crypto from "node:crypto";
import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { generatePresignedUrl, generatePresignedDownloadUrl, getObjectBuffer, storeVerifiedObject, deleteObjectFromStorage } from '../utilities/r2.ts';
import { authenticate } from '../middleware/auth.ts';
import { UploadIntent, type ContentClass } from '../models/UploadIntent.ts';
import { CLASS_MAX_BYTES, normalizeUploadMime, validateUploadMetadata, validateUploadBytes, authorizeUpload } from '../utilities/uploadPolicy.ts';
import { successResponse, errorResponse } from '../utilities/helpers.ts';

export default async function uploadRoutes(fastify: FastifyInstance) {
  const createIntent = async (req: any, reply: any) => {
    const { originalFilename, contentType, contentClass = 'clinical_document', patientId, fileSizeBytes } = req.body || {};
    const invalid = validateUploadMetadata(originalFilename, contentType, contentClass);
    if (invalid) return reply.code(400).send(errorResponse(invalid));
    const authority = await authorizeUpload(req, patientId);
    if (!authority.allowed) return reply.code(authority.statusCode).send(errorResponse(authority.message));
    const organizationId = authority.organizationId!;
    const maxSizeBytes = CLASS_MAX_BYTES[contentClass as ContentClass];
    if (!Number.isSafeInteger(fileSizeBytes) || fileSizeBytes <= 0 || fileSizeBytes > maxSizeBytes) return reply.code(400).send(errorResponse('fileSizeBytes must be within the class limit'));
    if (['clinical_document', 'prescription', 'lab_report', 'radiology'].includes(contentClass) && !patientId) return reply.code(400).send(errorResponse('Patient context is required for clinical uploads'));
    const mime = normalizeUploadMime(contentType);
    const { uploadUrl, fileKey } = await generatePresignedUrl(originalFilename, mime, organizationId, maxSizeBytes, fileSizeBytes);
    const intent = await UploadIntent.create({ organizationId, userId: req.user.id, patientId, objectKey: fileKey,
      originalFileName: originalFilename, contentClass, permittedMimeTypes: [mime], maxSizeBytes,
      status: 'pending', expiresAt: new Date(Date.now() + 15 * 60000) });
    return reply.code(201).send(successResponse({ intentId: intent._id, uploadUrl, objectKey: fileKey, fileKey,
      maxSizeBytes, expiresAt: intent.expiresAt }, 'Upload intent created'));
  };
  fastify.post('/uploads/intent', { preHandler: [authenticate] }, createIntent);
  // Compatibility route uses the same intent and verification contract.
  fastify.post('/get-upload-url', { preHandler: [authenticate] }, createIntent);

  fastify.post('/uploads/verify', { preHandler: [authenticate] }, async (req, reply) => {
    const { intentId } = (req.body || {}) as { intentId?: string };
    if (typeof intentId !== 'string' || !mongoose.Types.ObjectId.isValid(intentId)) return reply.code(400).send(errorResponse('Invalid intentId'));
    const owned = { _id: intentId, userId: req.user!.id };
    let intent = await UploadIntent.findOne(owned);
    if (!intent) return reply.code(404).send(errorResponse('Upload intent not found'));
    const authority = await authorizeUpload(req, intent.patientId?.toString());
    if (!authority.allowed || authority.organizationId !== intent.organizationId.toString()) return reply.code(403).send(errorResponse('Upload access denied'));
    if (intent.status === 'completed') return reply.send(successResponse(intent));
    // Claim prevents concurrent reads/scans of the same object.
    const verificationToken = crypto.randomUUID();
    intent = await UploadIntent.findOneAndUpdate({ ...owned, expiresAt: { $gt: new Date() }, $or: [{ status: 'pending' }, { status: 'verifying', verifyingUntil: { $lte: new Date() } }, { status: 'verifying', verifyingUntil: null, updatedAt: { $lt: new Date(Date.now() - 120_000) } }] }, { $set: { status: 'verifying', verificationToken, verifyingUntil: new Date(Date.now() + 90_000) } }, { returnDocument: 'after' });
    if (!intent) return reply.code(409).send(errorResponse('Upload is expired or already being verified'));
    let verifiedKey: string | undefined;
    const originalKey = intent.objectKey;
    let invalidContent = false;
    try {
      const buffer = await getObjectBuffer(originalKey, intent.maxSizeBytes);
      let mime: string;
      try { mime = validateUploadBytes(buffer, intent.permittedMimeTypes[0], intent.maxSizeBytes); }
      catch (error) { invalidContent = true; throw error; }
      // Seal the checked bytes at a server-only key. The original PUT URL cannot overwrite them.
      verifiedKey = await storeVerifiedObject(buffer, mime, intent.organizationId.toString());
      const completed = await UploadIntent.findOneAndUpdate({ ...owned, status: 'verifying', verificationToken, objectKey: originalKey }, {
        $set: { objectKey: verifiedKey, status: 'completed', actualSizeBytes: buffer.length, actualMimeType: mime, magicBytesVerified: true, contentValidationPassed: true, malwareClean: false },
        $unset: { expiresAt: 1, verificationToken: 1, verifyingUntil: 1 },
      }, { returnDocument: 'after' });
      if (!completed) throw new Error('Upload claim was lost');
      void deleteObjectFromStorage(originalKey).catch(() => {});
      return reply.send(successResponse({ intentId: completed._id, objectKey: completed.objectKey,
        status: 'completed', actualSizeBytes: completed.actualSizeBytes, detectedMime: mime }));
    } catch (error: any) {
      if (verifiedKey) await deleteObjectFromStorage(verifiedKey).catch(() => {});
      await UploadIntent.updateOne({ ...owned, status: 'verifying', verificationToken }, { $set: { status: invalidContent || error.message === 'UPLOAD_TOO_LARGE' ? 'rejected' : 'pending' }, $unset: { verificationToken: 1, verifyingUntil: 1 } });
      return reply.code(400).send(errorResponse('Upload could not be verified. Check its size, type and storage upload.'));
    }
  });

  fastify.get('/uploads/download/:intentId', { preHandler: [authenticate] }, async (req, reply) => {
    const { intentId } = req.params as { intentId: string };
    if (!mongoose.Types.ObjectId.isValid(intentId)) return reply.code(400).send(errorResponse('Invalid intentId'));
    const intent = await UploadIntent.findOne({ _id: intentId, status: 'completed' });
    if (!intent) return reply.code(404).send(errorResponse('File not found'));
    // Patient files require current clinical/family authority even for their uploader.
    const authority = intent.patientId
      ? await authorizeUpload(req, intent.patientId.toString(), false)
      : await authorizeUpload(req);
    if (!authority.allowed || authority.organizationId !== intent.organizationId.toString() ||
      (!intent.patientId && intent.userId.toString() !== req.user!.id && req.user?.role !== 'root')) {
      return reply.code(404).send(errorResponse('File not found'));
    }
    const downloadUrl = await generatePresignedDownloadUrl(intent.objectKey, 300);
    return reply.send(successResponse({ downloadUrl, expiresInSeconds: 300, fileName: intent.originalFileName, mimeType: intent.actualMimeType }));
  });

  fastify.post('/upload-base64', { preHandler: [authenticate] }, async (req, reply) => {
    const body = (req.body || {}) as any;
    const filename = body.originalFilename || body.fileName;
    const contentClass = body.contentClass || (typeof body.contentType === 'string' && body.contentType.startsWith('image/') ? 'avatar' : 'other');
    const invalid = validateUploadMetadata(filename, body.contentType, contentClass);
    if (invalid) return reply.code(400).send(errorResponse(invalid));
    const authority = await authorizeUpload(req, body.patientId);
    if (!authority.allowed) return reply.code(authority.statusCode).send(errorResponse(authority.message));
    const encoded = body.base64Data || body.base64;
    const maxBytes = Math.min(CLASS_MAX_BYTES[contentClass as ContentClass], 7 * 1024 * 1024);
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(maxBytes / 3) * 4 + 256) return reply.code(413).send(errorResponse('Upload exceeds the allowed size'));
    const raw = encoded.replace(/^data:[^;]+;base64,/, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0) return reply.code(400).send(errorResponse('Invalid base64 data'));
    const buffer = Buffer.from(raw, 'base64');
    let mime: string;
    try { mime = validateUploadBytes(buffer, body.contentType, maxBytes); }
    catch { return reply.code(400).send(errorResponse('Invalid file size, signature or active content')); }
    const key = await storeVerifiedObject(buffer, mime, authority.organizationId!);
    try {
      const intent = await UploadIntent.create({ organizationId: authority.organizationId, userId: req.user!.id,
        patientId: body.patientId, objectKey: key, originalFileName: filename, contentClass,
        permittedMimeTypes: [mime], maxSizeBytes: maxBytes, actualSizeBytes: buffer.length, actualMimeType: mime,
        status: 'completed', magicBytesVerified: true, contentValidationPassed: true, malwareClean: false });
      return reply.send(successResponse({ intentId: intent._id, fileKey: key, objectKey: key, publicUrl: key, url: key }));
    } catch (error) { await deleteObjectFromStorage(key).catch(() => {}); throw error; }
  });
}
