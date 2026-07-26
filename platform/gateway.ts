import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utilities/logger.ts";

export interface GatewayClientContext {
  apiKey?: string;
  clientId?: string;
  organizationId?: string;
  rateLimitPerMinute: number;
}

export async function gatewayAuthMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers["x-ananta-api-key"] as string;

  // Public health check bypass
  if (request.url.startsWith("/api/health")) {
    return;
  }

  // Developer API Gateway Key authentication check
  if (apiKey) {
    if (!apiKey.startsWith("ananta_live_") && !apiKey.startsWith("ananta_test_")) {
      logger.warn("Invalid API Key presented to Gateway", { tenantId: undefined }, { apiKey });
      return reply.code(401).send({ error: "Unauthorized: Invalid ANANTA Platform API Key" });
    }
    
    (request as any).gatewayClient = {
      apiKey,
      clientId: "dev_partner_001",
      rateLimitPerMinute: 1000,
    };
    return;
  }
}

export default async function platformGatewayRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", gatewayAuthMiddleware);

  fastify.get("/api/v1/platform/manifest", async (request, reply) => {
    return reply.send({
      platform: "ANANTA Healthcare Intelligence Operating System",
      version: "1.0.0",
      status: "active",
      apis: {
        identity: "/api/v1/identity",
        consent: "/api/v1/consent",
        timeline: "/api/v1/timeline",
        intelligence: "/api/v1/intelligence",
        documents: "/api/v1/documents",
      },
      fhirSpecification: "HL7 FHIR R4",
      supportedRegions: ["IN_ABDM", "US_HIPAA", "EU_GDPR", "UK_NHS"],
    });
  });
}
