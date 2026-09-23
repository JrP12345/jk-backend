import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission, checkPermission } from "../middleware/auth.ts";
import {
  generateSOAPNoteController,
  queryHealthAssistantController,
  listChatSessionsController,
  createChatSessionController,
  getChatSessionController,
  listChatSessionMessagesController,
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
  const clinicalAi = {
    ...auth,
    preHandler: [authenticate, checkAnyPermission("MANAGE_CLINICAL_NOTES", "MANAGE_EHR", "VIEW_EHR")],
  };
  const manageClinicalAi = {
    ...auth,
    preHandler: [authenticate, checkAnyPermission("MANAGE_CLINICAL_NOTES", "MANAGE_EHR")],
  };
  const aiGovernance = {
    ...auth,
    preHandler: [authenticate, checkPermission("MANAGE_ORGANIZATION")],
  };
  const aiAnalytics = {
    ...auth,
    preHandler: [authenticate, checkAnyPermission("VIEW_ANALYTICS", "MANAGE_ORGANIZATION")],
  };
  const billingAi = {
    ...auth,
    preHandler: [authenticate, checkAnyPermission("VIEW_BILLING", "MANAGE_BILLING")],
  };
  const inventoryAi = {
    ...auth,
    preHandler: [authenticate, checkPermission("MANAGE_MEDICINES")],
  };

  // AI SOAP Note Draft Generation
  app.post("/api/ai/soap-notes/generate", manageClinicalAi, generateSOAPNoteController);

  // Grounded Patient Health Query Assistant (Single-Turn EHR Query)
  app.post("/api/ai/health-assistant/query", clinicalAi, queryHealthAssistantController);

  // Enterprise DB-Backed Multi-Session Chat APIs
  app.get("/api/ai/chat/sessions", clinicalAi, listChatSessionsController);
  app.post("/api/ai/chat/sessions", clinicalAi, createChatSessionController);
  app.get("/api/ai/chat/sessions/:sessionId", clinicalAi, getChatSessionController);
  app.get("/api/ai/chat/sessions/:sessionId/messages", clinicalAi, listChatSessionMessagesController);
  app.post("/api/ai/chat/sessions/:sessionId/messages", clinicalAi, sendChatMessageController);
  app.delete("/api/ai/chat/sessions/:sessionId", clinicalAi, deleteChatSessionController);

  // Enterprise AI Gateway & Health Probes (Phase 1)
  app.post("/api/ai/gateway/query", clinicalAi, queryAIGatewayController);
  app.post("/api/ai/gateway/stream", clinicalAi, streamAIGatewayController);
  app.get("/api/ai/health", getAIHealthController);

  // Enterprise Prompt Governance & Approval Workflow APIs (Phase 2)
  app.get("/api/ai/prompts", aiGovernance, listPromptTemplatesController);
  app.post("/api/ai/prompts", aiGovernance, createPromptDraftController);
  app.put("/api/ai/prompts/:id/approve", aiGovernance, approvePromptTemplateController);
  app.post("/api/ai/prompts/test", aiGovernance, testPromptSandboxController);

  // Enterprise Tool Calling & Clinician Co-Signature Approval APIs (Phase 5)
  app.post("/api/ai/tools/intent", clinicalAi, detectToolIntentController);
  app.post("/api/ai/tools/request-execution", manageClinicalAi, requestToolExecutionController);
  app.put("/api/ai/tools/:id/approve", manageClinicalAi, approveAndExecuteToolController);

  // Enterprise AI Observability & Cost Analytics APIs (Phase 7)
  app.get("/api/ai/observability/metrics", aiAnalytics, getAIObservabilityMetricsController);
  app.get("/api/ai/observability/costs", billingAi, getAICostAnalyticsController);

  // Enterprise AI Admin Console REST APIs (Phase 8)
  app.get("/api/ai/admin/config", aiGovernance, getAIAdminConfigController);
  app.put("/api/ai/admin/config", aiGovernance, updateAIAdminConfigController);

  // Phase 4 AI & Automation Endpoints (Modules 32 - 37)
  app.post("/api/ai/predictive/no-show", aiAnalytics, predictNoShowRiskController);
  app.post("/api/ai/billing/audit", billingAi, auditBillingAnomaliesController);
  app.get("/api/ai/inventory/forecast", inventoryAi, forecastInventorySupplyController);
  app.post("/api/ai/nlp/icd10-extract", manageClinicalAi, extractNlpIcd10CodesController);
}
