import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import { submitFeedback, getFeedback, getFeedbackStats } from "../controllers/feedback.ts";

export default async function feedbackRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  app.post("/api/feedback", auth, submitFeedback);
  app.get("/api/feedback", auth, getFeedback);
  app.get("/api/feedback/stats", auth, getFeedbackStats);
}
