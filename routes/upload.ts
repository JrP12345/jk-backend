import type { FastifyInstance } from 'fastify';
import { generatePresignedUrl, uploadBase64ToR2 } from '../utilities/r2.ts';
import { authenticate } from '../middleware/auth.ts';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'application/pdf',
  'application/dicom',
  'application/octet-stream',
  'text/plain',
  'text/csv',
]);

export default async function uploadRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/get-upload-url',
    { preHandler: [authenticate] }, // ensure this is secure
    async (request, reply) => {
      const { contentType, originalFilename } = request.body as {
        contentType: string;
        originalFilename: string;
      };

      if (!contentType || !originalFilename) {
        return reply.code(400).send({ error: 'Missing required fields' });
      }

      if (!ALLOWED_MIME_TYPES.has(contentType.toLowerCase().trim())) {
        return reply.code(400).send({ error: `Unsupported or unsafe file type: ${contentType}` });
      }

      try {
        const orgId = request.user?.organization_id;
        const { uploadUrl, fileKey, publicUrl } = await generatePresignedUrl(
          originalFilename,
          contentType,
          orgId
        );

        return reply.send({
          success: true,
          data: {
            uploadUrl,
            fileKey,
            publicUrl,
          },
        });
      } catch (error) {
        console.error('Error generating presigned URL:', error);
        return reply.code(500).send({ error: 'Failed to generate upload URL' });
      }
    }
  );

  fastify.post(
    '/upload-base64',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const body = (request.body || {}) as any;
      const contentType = body.contentType || 'image/png';
      const originalFilename = body.originalFilename || body.fileName || `file-${Date.now()}.png`;
      const base64Data = body.base64Data || body.base64;

      if (!base64Data) {
        return reply.code(400).send({ error: 'Missing base64 data' });
      }

      if (!ALLOWED_MIME_TYPES.has(contentType.toLowerCase().trim())) {
        return reply.code(400).send({ error: `Unsupported or unsafe file type: ${contentType}` });
      }

      try {
        const orgId = request.user?.organization_id;
        const { fileKey, publicUrl } = await uploadBase64ToR2(
          base64Data,
          originalFilename,
          contentType,
          orgId
        );

        return reply.send({
          success: true,
          data: { fileKey, publicUrl, url: publicUrl }
        });
      } catch (error) {
        fastify.log.warn('R2 cloud storage unconfigured or failed; upload was not persisted');
        return reply.code(503).send({
          success: false,
          error: 'Cloud storage is unavailable; file was not persisted'
        });
      }
    }
  );
}
