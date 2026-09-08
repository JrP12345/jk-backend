import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  generateSOAPNoteController,
  queryHealthAssistantController,
  listChatSessionsController,
  createChatSessionController,
  getChatSessionController,
  sendChatMessageController,
  deleteChatSessionController,
  predictNoShowRiskController,
  auditBillingAnomaliesController,
  forecastInventorySupplyController,
  extractNlpIcd10CodesController,
} from "../controllers/ai.ts";
import {
  queryAIGatewayController,
  streamAIGatewayController,
  getAIHealthController,
} from "../controllers/aiGateway.ts";
import {
  listPromptTemplatesController,
  createPromptDraftController,
  approvePromptTemplateController,
  testPromptSandboxController,
} from "../controllers/promptGovernance.ts";
import {
  detectToolIntentController,
  requestToolExecutionController,
  approveAndExecuteToolController,
} from "../controllers/aiTools.ts";
import {
  getAIObservabilityMetricsController,
  getAICostAnalyticsController,
} from "../controllers/aiObservability.ts";
import {
  getAIAdminConfigController,
  updateAIAdminConfigController,
} from "../controllers/aiAdmin.ts";

export default async function aiRoutes(app: FastifyInstance) {
  const isTest = process.env.NODE_ENV === "test";
  const auth = {
    preHandler: [authenticate],
    config: {
      rateLimit: {
        max: isTest ? 1000 : 40,
        timeWindow: "1 minute"
      }
    }
  };

  // AI SOAP Note Draft Generation
  app.post("/api/ai/soap-notes/generate", auth, generateSOAPNoteController);

  // Grounded Patient Health Query Assistant (Single-Turn EHR Query)
  app.post("/api/ai/health-assistant/query", auth, queryHealthAssistantController);

  // Enterprise DB-Backed Multi-Session Chat APIs
  app.get("/api/ai/chat/sessions", auth, listChatSessionsController);
  app.post("/api/ai/chat/sessions", auth, createChatSessionController);
  app.get("/api/ai/chat/sessions/:sessionId", auth, getChatSessionController);
  app.post("/api/ai/chat/sessions/:sessionId/messages", auth, sendChatMessageController);
  app.delete("/api/ai/chat/sessions/:sessionId", auth, deleteChatSessionController);

  // Enterprise AI Gateway & Health Probes (Phase 1)
  app.post("/api/ai/gateway/query", auth, queryAIGatewayController);
  app.post("/api/ai/gateway/stream", auth, streamAIGatewayController);
  app.get("/api/ai/health", getAIHealthController);

  // Enterprise Prompt Governance & Approval Workflow APIs (Phase 2)
  app.get("/api/ai/prompts", auth, listPromptTemplatesController);
  app.post("/api/ai/prompts", auth, createPromptDraftController);
  app.put("/api/ai/prompts/:id/approve", auth, approvePromptTemplateController);
  app.post("/api/ai/prompts/test", auth, testPromptSandboxController);

  // Enterprise Tool Calling & Clinician Co-Signature Approval APIs (Phase 5)
  app.post("/api/ai/tools/intent", auth, detectToolIntentController);
  app.post("/api/ai/tools/request-execution", auth, requestToolExecutionController);
  app.put("/api/ai/tools/:id/approve", auth, approveAndExecuteToolController);

  // Enterprise AI Observability & Cost Analytics APIs (Phase 7)
  app.get("/api/ai/observability/metrics", auth, getAIObservabilityMetricsController);
  app.get("/api/ai/observability/costs", auth, getAICostAnalyticsController);

  // Enterprise AI Admin Console REST APIs (Phase 8)
  app.get("/api/ai/admin/config", auth, getAIAdminConfigController);
  app.put("/api/ai/admin/config", auth, updateAIAdminConfigController);

  // Phase 4 AI & Automation Endpoints (Modules 32 - 37)
  app.post("/api/ai/predictive/no-show", auth, predictNoShowRiskController);
  app.post("/api/ai/billing/audit", auth, auditBillingAnomaliesController);
  app.get("/api/ai/inventory/forecast", auth, forecastInventorySupplyController);
  app.post("/api/ai/nlp/icd10-extract", auth, extractNlpIcd10CodesController);
}
