import type { FastifyInstance } from "fastify";
import { uploadDocument, getPatientDocuments } from "../controllers/documentUpload.ts";
import { authenticate } from "../middleware/auth.ts";

export default async function documentRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/api/v1/documents/upload",
    { preHandler: [authenticate] },
    async (request, reply) => {
      // Mock Express response adapter for controller
      const reqAdapter = {
        body: request.body,
        params: request.params,
        user: (request as any).user,
      } as any;

      let statusCode = 200;
      let jsonPayload: any = {};

      const resAdapter = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          jsonPayload = data;
          return reply.code(statusCode).send(data);
        },
      } as any;

      await uploadDocument(reqAdapter, resAdapter);
    }
  );

  fastify.get(
    "/api/v1/documents/patient/:patientId",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const reqAdapter = {
        params: request.params,
        user: (request as any).user,
      } as any;

      let statusCode = 200;

      const resAdapter = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          return reply.code(statusCode).send(data);
        },
      } as any;

      await getPatientDocuments(reqAdapter, resAdapter);
    }
  );
}
