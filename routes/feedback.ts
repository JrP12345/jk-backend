import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission } from "../middleware/auth.ts";
import { submitFeedback, getFeedback, getFeedbackStats } from "../controllers/feedback.ts";
import { feedbackQuerySchema, feedbackSubmissionSchema } from "../schemas/operations.ts";

export default async function feedbackRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };
  const feedbackAnalytics = { preHandler: [authenticate, checkAnyPermission("VIEW_ANALYTICS", "MANAGE_ORGANIZATION")] };

  app.post("/api/feedback", { ...auth, schema: feedbackSubmissionSchema }, submitFeedback);
  app.get("/api/feedback", { ...feedbackAnalytics, schema: feedbackQuerySchema }, getFeedback);
  app.get("/api/feedback/stats", { ...feedbackAnalytics, schema: feedbackQuerySchema }, getFeedbackStats);
}
