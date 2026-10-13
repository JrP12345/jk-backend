import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import { submitFeedback, getFeedback, getFeedbackStats, getFeedbackEligibleVisits, getVisitFeedback, getOwnFeedback } from "../controllers/feedback.ts";
import { feedbackQuerySchema, feedbackSubmissionSchema } from "../schemas/operations.ts";

export default async function feedbackRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };
  const feedbackAnalytics = auth;

  app.post("/api/feedback", { ...auth, schema: feedbackSubmissionSchema }, submitFeedback);
  app.get("/api/feedback", { ...feedbackAnalytics, schema: feedbackQuerySchema }, getFeedback);
  app.get("/api/feedback/stats", { ...feedbackAnalytics, schema: feedbackQuerySchema }, getFeedbackStats);
  app.get("/api/feedback/eligible-visits", { ...auth, schema: feedbackQuerySchema }, getFeedbackEligibleVisits);
  app.get('/api/feedback/mine', { ...auth, schema: feedbackQuerySchema }, getOwnFeedback);
  app.get('/api/feedback/visit/:id', { ...auth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } } } } }, getVisitFeedback);
}
