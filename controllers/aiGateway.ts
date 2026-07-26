import type { FastifyRequest, FastifyReply } from "fastify";
import { aiGateway } from "../services/ai/AIGateway.ts";
import { StreamingService } from "../services/ai/StreamingService.ts";
import { providerHealthMonitor } from "../services/ai/ProviderHealthMonitor.ts";
import { AIObservabilityMetric } from "../models/AIObservabilityMetric.ts";
import { Patient } from "../models/Patient.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

// ─── POST /api/ai/gateway/query ────────────────────────────────────────
export async function queryAIGatewayController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { query, modelAlias, sessionId, currentRoute, activePatientId } = req.body as {
      query: string;
      modelAlias?: any;
      sessionId?: string;
      currentRoute?: string;
      activePatientId?: string;
    };
    const userId = req.user?.id;
    const orgId = req.user?.organization_id;

    if (!query || !query.trim()) {
      return reply.code(400).send(errorResponse("query string is required"));
    }

    const correlationId = `corr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // Fetch sample patients for PHI anonymization
    const samplePatientsList = await Patient.find(orgId ? { organizationId: orgId } : {}).populate("userId", "name email").limit(20).lean();
    const patientMapList = samplePatientsList.map(p => ({
      name: (p.userId as any)?.name,
      mrn: (p as any).mrn,
      email: (p.userId as any)?.email
    }));

    const response = await aiGateway.execute({
      correlationId,
      organizationId: orgId || "000000000000000000000000",
      sessionId: sessionId || "general",
      requestId: `req_${Date.now()}`,
      userId: userId || "anonymous",
      modelAlias: modelAlias || "CLINICAL_FAST",
      prompt: query.trim(),
      systemDirective: currentRoute ? `Clinician viewing screen "${currentRoute}".` : "Enterprise Clinical Context"
    }, patientMapList);

    // Asynchronously record telemetry metric
    AIObservabilityMetric.create({
      correlationId: response.correlationId,
      organizationId: orgId || "000000000000000000000000",
      userId: userId || "000000000000000000000000",
      sessionId: sessionId || "general",
      provider: response.provider,
      model: response.model,
      modelAlias: modelAlias || "CLINICAL_FAST",
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      estimatedCostUSD: response.usage.estimatedCostUSD,
      latencyMs: response.usage.latencyMs,
      status: "success"
    }).catch(err => console.error("Error writing AIObservabilityMetric:", err));

    return reply.code(200).send(successResponse(response));
  } catch (err: any) {
    console.error("queryAIGatewayController error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal AI Gateway error"));
  }
}

// ─── POST /api/ai/gateway/stream ───────────────────────────────────────
export async function streamAIGatewayController(req: FastifyRequest, reply: FastifyReply) {
  const correlationId = `corr_stream_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  StreamingService.initSSEResponse(reply);

  try {
    const { query, modelAlias, currentRoute } = req.body as {
      query: string;
      modelAlias?: any;
      currentRoute?: string;
    };
    const userId = req.user?.id;
    const orgId = req.user?.organization_id;

    if (!query || !query.trim()) {
      StreamingService.sendChunk(reply, {
        correlationId,
        chunkIndex: 0,
        text: "Error: query parameter is required.",
        isComplete: true
      });
      return StreamingService.endStream(reply, correlationId);
    }

    const response = await aiGateway.execute({
      correlationId,
      organizationId: orgId || "000000000000000000000000",
      sessionId: "stream",
      requestId: `req_${Date.now()}`,
      userId: userId || "anonymous",
      modelAlias: modelAlias || "CLINICAL_FAST",
      prompt: query.trim(),
      systemDirective: currentRoute ? `Clinician viewing screen "${currentRoute}".` : "Enterprise Clinical Context"
    });

    // Simulate token chunks over SSE stream
    const words = response.text.split(" ");
    for (let i = 0; i < words.length; i++) {
      const wordChunk = (i === 0 ? "" : " ") + words[i];
      StreamingService.sendChunk(reply, {
        correlationId,
        chunkIndex: i + 1,
        text: wordChunk,
        isComplete: i === words.length - 1
      });
    }

    StreamingService.endStream(reply, correlationId);
  } catch (err: any) {
    StreamingService.sendChunk(reply, {
      correlationId,
      chunkIndex: 999,
      text: `\n[Gateway Stream Error: ${err.message}]`,
      isComplete: true
    });
    StreamingService.endStream(reply, correlationId);
  }
}

// ─── GET /api/ai/health ────────────────────────────────────────────────
export async function getAIHealthController(req: FastifyRequest, reply: FastifyReply) {
  try {
    await providerHealthMonitor.runHealthCheck();
    const systemStatus = providerHealthMonitor.getSystemStatus();
    return reply.code(200).send(successResponse({
      status: systemStatus.overallStatus,
      providers: systemStatus.providers,
      timestamp: new Date().toISOString()
    }, "AI System Health Probe Successful"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to query AI health monitor"));
  }
}
