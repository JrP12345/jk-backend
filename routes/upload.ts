import type { FastifyInstance } from 'fastify';
import { generatePresignedUrl, uploadBase64ToR2 } from '../utilities/r2.ts';
import { authenticate } from '../middleware/auth.ts';

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

      try {
        const { uploadUrl, fileKey, publicUrl } = await generatePresignedUrl(
          originalFilename,
          contentType
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

      try {
        const { fileKey, publicUrl } = await uploadBase64ToR2(
          base64Data,
          originalFilename,
          contentType
        );

        return reply.send({
          success: true,
          data: { fileKey, publicUrl, url: publicUrl }
        });
      } catch (error) {
        fastify.log.warn('R2 cloud storage unconfigured or failed, returning local base64 payload');
        return reply.send({
          success: true,
          data: { fileKey: originalFilename, publicUrl: base64Data, url: base64Data }
        });
      }
    }
  );
}
